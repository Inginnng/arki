import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, opendir, open, readlink, realpath } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";

import ignore, { type Ignore } from "ignore";
import { OpaqueIdSchema } from "@aimd/contracts";
import {
  createWorkspaceSnapshot,
  inspectMarkdownOutline,
  type CreatedWorkspaceSnapshot,
  type GitWorkspaceState,
  type RelevantFileHash,
} from "@aimd/reader-core";

import {
  WorkspaceAccessError,
  type PathGuardDependencies,
  type PathGuardOptions,
  type WorkspacePathGuard,
  createPathGuard,
  createPathGuardForTesting,
} from "./path-guard.js";
import {
  isCanonicalPathContained as isContained,
  sameCanonicalPath as samePath,
} from "./canonical-path.js";
import type { VerifiedWorkspaceRoot } from "./root-resolver.js";
import type { SafeOutputSourceDescriptor } from "./safe-writer.js";

export interface WorkspaceOptions extends PathGuardOptions {
  maxSearchResults?: number;
  maxSearchFiles?: number;
  maxTraversalEntries?: number;
  /** Internal/test policy. Production uses auto and prefers bounded rg JSON. */
  searchBackend?: "auto" | "rg" | "walker";
  /** Internal/test executable override. It is never accepted from an MCP tool argument. */
  rgExecutable?: string;
  /** Internal/host executable override. It is never accepted from an MCP tool argument. */
  gitExecutable?: string;
  maxSnapshotFiles?: number;
  maxSnapshotBytes?: number;
  /** Internal production identity; never accepted from an MCP/UI argument. */
  rootId?: string;
}

export interface ReadFileRange {
  startLine?: number;
  endLine?: number;
}

export interface NumberedLine {
  line: number;
  text: string;
}

export interface DocumentLine {
  number: number;
  text: string;
}

export interface DocumentHeading {
  depth: number;
  text: string;
  line: number;
}

export interface WorkspaceDocument {
  path: string;
  hash: string;
  lines: DocumentLine[];
  headings: DocumentHeading[];
  anchorStatus:
    | { status: "available" }
    | { status: "view_only"; code: "SOURCE_ANCHOR_COMPLEXITY_BUDGET" };
}

export interface WorkspaceDocumentSummary {
  path: string;
  title: string;
  hash: string;
}

export interface WorkspaceExcerpt {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: NumberedLine[];
  excerpt: string;
  fileHash: string;
  truncated: boolean;
}

export interface WorkspaceEvidenceRange {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  /** Exact unnumbered decoded text; internal line endings are preserved. */
  excerpt: string;
  /** SHA-256 of original guarded bytes, not re-encoded text. */
  fileHash: string;
  byteLength: number;
  /** Opaque same-file key consumed only by the trusted evidence issuer. */
  sourceLocationKey: string;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  maxResults?: number;
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  column: number;
  startLine: number;
  endLine: number;
  excerpt: string;
  fileHash: string;
}

export interface WorkspaceSearchResult {
  query: string;
  matches: WorkspaceSearchMatch[];
  inspectedPaths: string[];
  truncated: boolean;
}

export interface WorkspaceSnapshotRequest {
  /** Canonical server-readable files whose hashes will back evidence in this generation. */
  relevantPaths?: readonly string[];
}

const DEFAULT_MAX_SEARCH_RESULTS = 100;
const DEFAULT_MAX_SEARCH_FILES = 2_000;
const DEFAULT_MAX_TRAVERSAL_ENTRIES = 10_000;
const DEFAULT_MAX_SNAPSHOT_FILES = 5_000;
const DEFAULT_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_QUERY_LENGTH = 512;
const MAX_IGNORE_FILE_BYTES = 256 * 1024;
const MAX_RG_OUTPUT_BYTES = 2 * 1024 * 1024;
const RG_TIMEOUT_MS = 5_000;
const RG_MAX_ARGUMENT_CHARS = process.platform === "win32" ? 12_000 : 64_000;
const MAX_EXECUTABLE_PATH_BYTES = 4_096;
const MAX_PATH_SEARCH_BYTES = 64 * 1024;
const MAX_PATH_SEARCH_ENTRIES = 256;
const SKIPPED_DIRECTORIES = new Set([".git", ".hg", ".svn", "coverage", "dist", "node_modules"]);
const SNAPSHOT_CONTROL_DIRECTORIES = new Set([".git", ".hg", ".svn", ".aimd-git"]);
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const EXACT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface TrustedWorkspaceExecutableResolutionOptions {
  /** Internal/host override. A relative or project-local value is rejected. */
  explicitPath?: string | undefined;
  /** Test seam for the trusted host process PATH. Project content never supplies it. */
  pathValue?: string | undefined;
}

export async function resolveTrustedWorkspaceExecutable(
  command: "git" | "rg",
  canonicalRoot: string,
  options: TrustedWorkspaceExecutableResolutionOptions = {},
): Promise<string | null> {
  const path = process.platform === "win32" ? win32 : posix;
  const executableName = process.platform === "win32" ? `${command}.exe` : command;
  const rawCandidates = options.explicitPath === undefined
    ? (() => {
        const pathValue = options.pathValue ?? process.env.PATH ?? "";
        if (Buffer.byteLength(pathValue, "utf8") > MAX_PATH_SEARCH_BYTES) return [];
        const entries = pathValue.split(process.platform === "win32" ? ";" : ":");
        if (entries.length > MAX_PATH_SEARCH_ENTRIES) return [];
        return entries.map((entry) => {
          const unquoted = process.platform === "win32" && /^".*"$/u.test(entry)
            ? entry.slice(1, -1)
            : entry;
          return path.join(unquoted, executableName);
        });
      })()
    : [options.explicitPath];

  for (const candidate of rawCandidates) {
    if (
      typeof candidate !== "string" ||
      !path.isAbsolute(candidate) ||
      candidate.includes("\0") ||
      Buffer.byteLength(candidate, "utf8") > MAX_EXECUTABLE_PATH_BYTES ||
      isContained(canonicalRoot, path.resolve(candidate))
    ) continue;
    try {
      const lexicalState = await lstat(candidate);
      if (
        !lexicalState.isFile() ||
        lexicalState.isSymbolicLink() ||
        (process.platform !== "win32" && (lexicalState.mode & 0o111) === 0)
      ) continue;
      const canonical = await realpath(candidate);
      const canonicalState = await lstat(canonical);
      if (
        !canonicalState.isFile() ||
        canonicalState.isSymbolicLink() ||
        isContained(canonicalRoot, canonical)
      ) continue;
      return canonical;
    } catch {
      // Missing, unstable, or unreadable candidates are not execution authority.
    }
  }
  return null;
}

const GIT_ENVIRONMENT_DENY_KEYS = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_ASKPASS",
  "GIT_ATTR_SOURCE",
  "GIT_CONFIG",
  "GIT_DIFF_OPTS",
  "GIT_DIR",
  "GIT_EDITOR",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PAGER",
  "GIT_PROXY_COMMAND",
  "GIT_SEQUENCE_EDITOR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_TEMPLATE_DIR",
  "GIT_WORK_TREE",
  "SSH_ASKPASS",
]);

export function hardenWorkspaceGitEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...inherited };
  for (const key of Object.keys(environment)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("GIT_CONFIG_") || GIT_ENVIRONMENT_DENY_KEYS.has(upper)) {
      delete environment[key];
    }
  }
  const nullConfig = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_COUNT = "0";
  environment.GIT_CONFIG_GLOBAL = nullConfig;
  environment.GIT_CONFIG_SYSTEM = nullConfig;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_PAGER = "";
  return environment;
}

export function hardenWorkspaceGitArguments(args: readonly string[]): string[] {
  const disabledHooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
  return [
    "--no-optional-locks",
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${disabledHooksPath}`,
    "-c", "submodule.recurse=false",
    "-c", "diff.external=",
    ...args,
  ];
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new WorkspaceAccessError("INVALID_TEXT_ENCODING");
  }
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (/\r\n$|[\n\r]$/.test(text)) lines.pop();
  return lines;
}

type TextLineSpan = { start: number; end: number; delimiterEnd: number };

function textLineSpans(text: string): TextLineSpan[] {
  const spans: TextLineSpan[] = [];
  let start = 0;
  const newline = /\r\n|\n|\r/g;
  for (let match = newline.exec(text); match; match = newline.exec(text)) {
    const delimiterEnd = match.index + match[0].length;
    spans.push({ start, end: match.index, delimiterEnd });
    start = delimiterEnd;
  }
  if (start < text.length) spans.push({ start, end: text.length, delimiterEnd: text.length });
  return spans;
}

function numberedExcerpt(lines: readonly NumberedLine[]): string {
  return lines.map(({ line, text }) => `${line}: ${text}`).join("\n");
}

type IgnoreContext = Readonly<{ prefix: string; matcher: Ignore }>;

function ignoredByContexts(
  contexts: readonly IgnoreContext[],
  relativePath: string,
  directory: boolean,
): boolean {
  let ignored = false;
  for (const context of contexts) {
    const inContext = context.prefix.length === 0
      ? relativePath
      : relativePath === context.prefix
        ? ""
        : relativePath.startsWith(`${context.prefix}/`)
          ? relativePath.slice(context.prefix.length + 1)
          : null;
    if (inContext === null || inContext.length === 0) continue;
    const tested = context.matcher.test(directory ? `${inContext}/` : inContext);
    if (tested.ignored) ignored = true;
    if (tested.unignored) ignored = false;
  }
  return ignored;
}

type BoundedProcessResult =
  | Readonly<{ status: "completed"; code: number; stdout: Buffer }>
  | Readonly<{ status: "unavailable" }>;

function runBoundedProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  maxOutputBytes: number,
  timeoutMs: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<BoundedProcessResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    let total = 0;
    const chunks: Buffer[] = [];
    let child;
    try {
      child = spawn(executable, [...args], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: environment,
      });
    } catch {
      resolveResult({ status: "unavailable" });
      return;
    }
    const finish = (result: BoundedProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ status: "unavailable" });
    }, timeoutMs);
    child.once("error", () => finish({ status: "unavailable" }));
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxOutputBytes) {
        child.kill();
        finish({ status: "unavailable" });
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.once("close", (code) => {
      finish({ status: "completed", code: code ?? -1, stdout: Buffer.concat(chunks) });
    });
  });
}

function chunksForArguments(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let characters = 0;
  for (const path of paths) {
    const next = path.length + 3;
    if (current.length > 0 && characters + next > RG_MAX_ARGUMENT_CHARS) {
      chunks.push(current);
      current = [];
      characters = 0;
    }
    current.push(path);
    characters += next;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

type BigIntIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

function sameFileVersion(left: BigIntIdentity, right: BigIntIdentity): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

export class ReadOnlyWorkspace {
  readonly guard: WorkspacePathGuard;
  readonly #maxSearchResults: number;
  readonly #maxSearchFiles: number;
  readonly #maxTraversalEntries: number;
  readonly #searchBackend: "auto" | "rg" | "walker";
  readonly #gitExecutable: string | null;
  readonly #rgExecutable: string | null;
  readonly #maxSnapshotFiles: number;
  readonly #maxSnapshotBytes: number;
  readonly #rootId: string;

  constructor(
    guard: WorkspacePathGuard,
    options: WorkspaceOptions = {},
    executables: Readonly<{ git: string | null; rg: string | null }> = { git: null, rg: null },
  ) {
    this.guard = guard;
    this.#maxSearchResults = positiveInteger(options.maxSearchResults, DEFAULT_MAX_SEARCH_RESULTS);
    this.#maxSearchFiles = positiveInteger(options.maxSearchFiles, DEFAULT_MAX_SEARCH_FILES);
    this.#maxTraversalEntries = positiveInteger(options.maxTraversalEntries, DEFAULT_MAX_TRAVERSAL_ENTRIES);
    this.#searchBackend = options.searchBackend ?? "auto";
    this.#gitExecutable = executables.git;
    this.#rgExecutable = executables.rg;
    this.#maxSnapshotFiles = positiveInteger(options.maxSnapshotFiles, DEFAULT_MAX_SNAPSHOT_FILES);
    this.#maxSnapshotBytes = positiveInteger(options.maxSnapshotBytes, DEFAULT_MAX_SNAPSHOT_BYTES);
    this.#rootId = OpaqueIdSchema.parse(options.rootId ?? `root-${randomUUID()}`);
  }

  async #currentFile(relativePath: string): Promise<{
    bytes: Buffer;
    text: string;
    fileHash: string;
    canonicalPath: string;
    canonicalRelativePath: string;
    sourceLocationKey: string;
  }> {
    const file = await this.guard.readFileBytes(relativePath);
    return {
      bytes: file.bytes,
      text: decodeUtf8(file.bytes),
      fileHash: hash(file.bytes),
      canonicalPath: file.canonicalPath,
      canonicalRelativePath: file.canonicalRelativePath,
      sourceLocationKey: file.sourceLocationKey,
    };
  }

  async #hashSnapshotEntry(relativePath: string): Promise<{
    kind: "file" | "symlink";
    hash: string;
    byteLength: number;
  }> {
    const normalized = this.guard.validateRelativePath(relativePath);
    const lexicalPath = resolve(this.guard.canonicalRoot, ...normalized.split("/"));
    if (!isContained(this.guard.canonicalRoot, lexicalPath)) {
      throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
    }
    let initial;
    try {
      initial = await lstat(lexicalPath, { bigint: true });
    } catch {
      throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
    }
    if (initial.isSymbolicLink()) {
      let target: string;
      let final;
      try {
        target = await readlink(lexicalPath);
        final = await lstat(lexicalPath, { bigint: true });
      } catch {
        throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
      }
      if (!sameFileVersion(initial, final)) throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
      const bytes = Buffer.from(target, "utf8");
      return {
        kind: "symlink",
        hash: createHash("sha256").update("aimd-symlink-v1\0").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
      };
    }
    if (!initial.isFile()) throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");

    let handle;
    try {
      handle = await open(lexicalPath, "r");
    } catch {
      throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
    }
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.size > BigInt(this.#maxSnapshotBytes)) {
        throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
      }
      let canonicalPath: string;
      let pathState;
      try {
        canonicalPath = await realpath(lexicalPath);
        pathState = await lstat(lexicalPath, { bigint: true });
      } catch {
        throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
      }
      if (
        !isContained(this.guard.canonicalRoot, canonicalPath) ||
        pathState.isSymbolicLink() ||
        !sameFileVersion(opened, pathState)
      ) throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
      const bytes = await handle.readFile();
      const finalHandle = await handle.stat({ bigint: true });
      let finalPath;
      try {
        finalPath = await lstat(lexicalPath, { bigint: true });
      } catch {
        throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
      }
      if (
        bytes.byteLength !== Number(finalHandle.size) ||
        !sameFileVersion(opened, finalHandle) ||
        !sameFileVersion(finalHandle, finalPath)
      ) throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
      return { kind: "file", hash: hash(bytes), byteLength: bytes.byteLength };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #fullWorkspaceManifest(): Promise<string> {
    const entries: Array<{ path: string; kind: "file" | "symlink"; hash: string }> = [];
    let totalBytes = 0;
    const discoveryLimit = this.#maxSnapshotFiles >= Number.MAX_SAFE_INTEGER
      ? Number.MAX_SAFE_INTEGER
      : this.#maxSnapshotFiles + 1;
    // A non-Git manifest covers the same authorized project surface exposed by
    // list/search: ignored dependencies, build outputs, credentials, control
    // trees, symlinks, and configured deny paths are not readable evidence and
    // must not make an otherwise bounded project impossible to open.
    const candidates = await this.#workspaceFiles(discoveryLimit);
    if (candidates.truncated || candidates.paths.length > this.#maxSnapshotFiles) {
      throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
    }
    for (const path of candidates.paths) {
      const snapshotEntry = await this.#hashSnapshotEntry(path);
      totalBytes += snapshotEntry.byteLength;
      if (totalBytes > this.#maxSnapshotBytes) {
        throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
      }
      entries.push({ path, kind: snapshotEntry.kind, hash: snapshotEntry.hash });
    }
    await this.guard.assertRootAuthority();
    return createHash("sha256")
      .update("aimd-non-git-manifest-v1\0")
      .update(JSON.stringify(entries), "utf8")
      .digest("hex");
  }

  async #git(args: readonly string[], maxBytes = MAX_RG_OUTPUT_BYTES): Promise<BoundedProcessResult> {
    if (this.#gitExecutable === null) return { status: "unavailable" };
    return await runBoundedProcess(
      this.#gitExecutable,
      hardenWorkspaceGitArguments(args),
      this.guard.canonicalRoot,
      maxBytes,
      RG_TIMEOUT_MS,
      hardenWorkspaceGitEnvironment(),
    );
  }

  async #gitValue(args: readonly string[]): Promise<string | null> {
    const result = await this.#git(args, 16 * 1024);
    if (result.status !== "completed" || result.code !== 0) return null;
    const value = result.stdout.toString("utf8").trim();
    return value.length === 0 ? null : value;
  }

  async #gitDirtyContent(head: string | null): Promise<string> {
    const difference = head === null
      ? { status: "completed" as const, code: 0, stdout: Buffer.alloc(0) }
      : await this.#git(
          [
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=all",
            head,
            "--",
            ".",
          ],
          this.#maxSnapshotBytes,
        );
    const untracked = await this.#git(
      ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
      MAX_RG_OUTPUT_BYTES,
    );
    if (
      difference.status !== "completed" || difference.code !== 0 ||
      untracked.status !== "completed" || untracked.code !== 0
    ) throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
    const paths = untracked.stdout.toString("utf8").split("\0").filter((path) => path.length > 0);
    if (paths.length > this.#maxSnapshotFiles || new Set(paths).size !== paths.length) {
      throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
    }
    paths.sort(comparePaths);
    const manifest: Array<{ path: string; kind: "file" | "symlink"; hash: string }> = [];
    let totalBytes = difference.stdout.byteLength;
    for (const path of paths) {
      if (path.split("/").some((segment) => SNAPSHOT_CONTROL_DIRECTORIES.has(segment.toLowerCase()))) {
        throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
      }
      const entry = await this.#hashSnapshotEntry(path);
      totalBytes += entry.byteLength;
      if (totalBytes > this.#maxSnapshotBytes) throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
      manifest.push({ path, kind: entry.kind, hash: entry.hash });
    }
    return createHash("sha256")
      .update("aimd-git-dirty-content-v1\0")
      .update(difference.stdout)
      .update("\0untracked\0")
      .update(JSON.stringify(manifest), "utf8")
      .digest("hex");
  }

  async #gitSnapshotState(): Promise<{
    branch: string | null;
    head: string | null;
    gitState: GitWorkspaceState;
  } | null> {
    const topLevel = await this.#gitValue(["rev-parse", "--show-toplevel"]);
    if (topLevel === null) return null;
    let canonicalTop: string;
    try {
      canonicalTop = await realpath(topLevel);
    } catch {
      throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
    }
    if (!samePath(canonicalTop, this.guard.canonicalRoot)) return null;

    const branchBefore = await this.#gitValue(["symbolic-ref", "--short", "-q", "HEAD"]);
    const headBefore = await this.#gitValue(["rev-parse", "--verify", "HEAD"]);
    const statusBefore = await this.#git(
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=all",
        "--",
        ".",
      ],
      MAX_RG_OUTPUT_BYTES,
    );
    if (statusBefore.status !== "completed" || statusBefore.code !== 0) {
      throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
    }

    if (statusBefore.stdout.byteLength === 0) {
      const statusAfter = await this.#git(
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=all",
          "--",
          ".",
        ],
        MAX_RG_OUTPUT_BYTES,
      );
      const branchAfter = await this.#gitValue(["symbolic-ref", "--short", "-q", "HEAD"]);
      const headAfter = await this.#gitValue(["rev-parse", "--verify", "HEAD"]);
      if (
        statusAfter.status !== "completed" || statusAfter.code !== 0 ||
        statusAfter.stdout.byteLength !== 0 ||
        branchBefore !== branchAfter || headBefore !== headAfter
      ) throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
      return { branch: branchBefore, head: headBefore, gitState: { kind: "clean" } };
    }

    const contentBefore = headBefore === null
      ? await this.#fullWorkspaceManifest()
      : await this.#gitDirtyContent(headBefore);
    const statusMiddle = await this.#git(
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=all",
        "--",
        ".",
      ],
      MAX_RG_OUTPUT_BYTES,
    );
    const contentAfter = headBefore === null
      ? await this.#fullWorkspaceManifest()
      : await this.#gitDirtyContent(headBefore);
    const statusAfter = await this.#git(
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=all",
        "--",
        ".",
      ],
      MAX_RG_OUTPUT_BYTES,
    );
    const branchAfter = await this.#gitValue(["symbolic-ref", "--short", "-q", "HEAD"]);
    const headAfter = await this.#gitValue(["rev-parse", "--verify", "HEAD"]);
    if (
      statusMiddle.status !== "completed" || statusMiddle.code !== 0 ||
      statusAfter.status !== "completed" || statusAfter.code !== 0 ||
      !statusBefore.stdout.equals(statusMiddle.stdout) ||
      !statusMiddle.stdout.equals(statusAfter.stdout) ||
      contentBefore !== contentAfter ||
      branchBefore !== branchAfter || headBefore !== headAfter
    ) throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
    return {
      branch: branchBefore,
      head: headBefore,
      gitState: {
        kind: "dirty",
        status: hash(statusBefore.stdout),
        contentDigest: contentBefore,
      },
    };
  }

  async #relevantFileHashes(paths: readonly string[]): Promise<RelevantFileHash[]> {
    if (paths.length > 64) throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
    const result = new Map<string, string>();
    for (const path of paths) {
      const current = await this.#currentFile(path);
      const previous = result.get(current.canonicalRelativePath);
      if (previous !== undefined && previous !== current.fileHash) {
        throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
      }
      result.set(current.canonicalRelativePath, current.fileHash);
    }
    return [...result.entries()]
      .map(([path, fileHash]) => ({ path, hash: fileHash }))
      .sort((left, right) => comparePaths(left.path, right.path));
  }

  async readFile(relativePath: string, range: ReadFileRange = {}): Promise<WorkspaceExcerpt> {
    const normalizedPath = this.guard.validateRelativePath(relativePath);
    const current = await this.#currentFile(normalizedPath);
    const allLines = splitLines(current.text);
    if (allLines.length === 0) {
      if (range.startLine !== undefined || range.endLine !== undefined) {
        throw new WorkspaceAccessError("LINE_RANGE_OUT_OF_BOUNDS");
      }
      return {
        path: normalizedPath,
        startLine: 0,
        endLine: 0,
        totalLines: 0,
        lines: [],
        excerpt: "",
        fileHash: current.fileHash,
        truncated: false,
      };
    }

    const startLine = range.startLine ?? 1;
    if (Number.isSafeInteger(startLine) && startLine > allLines.length) {
      throw new WorkspaceAccessError("LINE_RANGE_OUT_OF_BOUNDS");
    }
    const requestedEnd = range.endLine;
    const endLine = requestedEnd ?? Math.min(allLines.length, startLine + this.guard.maxExcerptLines - 1);
    this.guard.validateLineRange(startLine, endLine);
    if (startLine > allLines.length || endLine > allLines.length) {
      throw new WorkspaceAccessError("LINE_RANGE_OUT_OF_BOUNDS");
    }
    const lines = allLines.slice(startLine - 1, endLine).map((text, index) => ({
      line: startLine + index,
      text,
    }));
    const excerpt = numberedExcerpt(lines);
    if (UTF8_ENCODER.encode(excerpt).byteLength > this.guard.maxExcerptBytes) {
      throw new WorkspaceAccessError("EXCERPT_TOO_LARGE");
    }
    return {
      path: normalizedPath,
      startLine,
      endLine,
      totalLines: allLines.length,
      lines,
      excerpt,
      fileHash: current.fileHash,
      truncated: requestedEnd === undefined && endLine < allLines.length,
    };
  }

  async readDocument(relativePath: string): Promise<WorkspaceDocument> {
    const normalizedPath = this.guard.validateRelativePath(relativePath);
    if (!/\.(?:md|markdown)$/iu.test(normalizedPath)) {
      throw new WorkspaceAccessError("NOT_MARKDOWN_DOCUMENT");
    }
    const current = await this.#currentFile(normalizedPath);
    if (!/\.(?:md|markdown)$/iu.test(current.canonicalRelativePath)) {
      throw new WorkspaceAccessError("NOT_MARKDOWN_DOCUMENT");
    }
    const lines = splitLines(current.text);
    const outline = inspectMarkdownOutline(current.text.replace(/^\uFEFF/u, ""));
    return {
      path: current.canonicalRelativePath,
      hash: current.fileHash,
      lines: lines.map((text, index) => ({ number: index + 1, text })),
      headings: outline.headings.map(({ depth, text, line }) => ({ depth, text, line })),
      anchorStatus: outline.status === "available"
        ? { status: "available" }
        : { status: "view_only", code: outline.code },
    };
  }

  async readDocumentSource(relativePath: string): Promise<{
    path: string;
    source: string;
    hash: string;
  }> {
    const normalizedPath = this.guard.validateRelativePath(relativePath);
    if (!/\.(?:md|markdown)$/iu.test(normalizedPath)) {
      throw new WorkspaceAccessError("NOT_MARKDOWN_DOCUMENT");
    }
    const current = await this.#currentFile(normalizedPath);
    if (!/\.(?:md|markdown)$/iu.test(current.canonicalRelativePath)) {
      throw new WorkspaceAccessError("NOT_MARKDOWN_DOCUMENT");
    }
    return {
      path: current.canonicalRelativePath,
      source: EXACT_UTF8_DECODER.decode(current.bytes),
      hash: current.fileHash,
    };
  }

  async listMarkdownDocuments(): Promise<WorkspaceDocumentSummary[]> {
    const candidates = await this.#workspaceFiles();
    const documents: WorkspaceDocumentSummary[] = [];
    for (const path of candidates.paths) {
      if (!/\.(?:md|markdown)$/iu.test(path)) continue;
      const document = await this.readDocument(path);
      documents.push({
        path: document.path,
        title: document.headings[0]?.text.trim() || posix.basename(document.path),
        hash: document.hash,
      });
    }
    await this.guard.assertRootAuthority();
    return documents;
  }

  async readLines(
    relativePath: string,
    startLine: number,
    endLine: number,
  ): Promise<WorkspaceExcerpt> {
    return await this.readFile(relativePath, { startLine, endLine });
  }

  /**
   * Internal capability assembly only. Absolute paths from this descriptor are
   * never part of an MCP/UI schema; SafeOutputWriter independently revalidates
   * them inside its platform-specific locked directory chain.
   */
  async prepareSafeOutputSource(relativePath: string): Promise<SafeOutputSourceDescriptor> {
    const normalizedPath = this.guard.validateRelativePath(relativePath);
    if (!/\.(?:md|markdown)$/iu.test(normalizedPath)) {
      throw new WorkspaceAccessError("NOT_MARKDOWN_DOCUMENT");
    }
    const source = await this.#currentFile(normalizedPath);
    if (!/\.(?:md|markdown)$/iu.test(source.canonicalRelativePath)) {
      throw new WorkspaceAccessError("NOT_MARKDOWN_DOCUMENT");
    }
    return Object.freeze({
      canonicalRoot: this.guard.canonicalRoot,
      canonicalSourcePath: source.canonicalPath,
      sourceContentSha256: source.fileHash,
    });
  }

  /** Bounded, ignore-aware discovery; callers still read every file through the guard. */
  async listProjectFiles(limit = 600): Promise<{ paths: string[]; truncated: boolean }> {
    await this.guard.assertRootAuthority();
    return this.#workspaceFiles(Math.min(Math.max(1, limit), this.#maxSearchFiles), new Set(["generated", "third_party", "vendor", "docs", "tests", "test", ".tmp"]));
  }

  async snapshot(request: WorkspaceSnapshotRequest = {}): Promise<CreatedWorkspaceSnapshot> {
    const relevantPaths = request.relevantPaths ?? [];
    await this.guard.assertRootAuthority();
    const relevantBefore = await this.#relevantFileHashes(relevantPaths);
    const gitSnapshot = await this.#gitSnapshotState();
    let branch: string | null;
    let head: string | null;
    let gitState: GitWorkspaceState;
    if (gitSnapshot === null) {
      const manifestBefore = await this.#fullWorkspaceManifest();
      const manifestAfter = await this.#fullWorkspaceManifest();
      if (manifestBefore !== manifestAfter) throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
      branch = null;
      head = null;
      gitState = {
        kind: "dirty",
        status: "non_git_workspace_v1",
        contentDigest: manifestBefore,
      };
    } else {
      ({ branch, head, gitState } = gitSnapshot);
    }
    const relevantAfter = await this.#relevantFileHashes(relevantPaths);
    if (JSON.stringify(relevantBefore) !== JSON.stringify(relevantAfter)) {
      throw new WorkspaceAccessError("SNAPSHOT_UNAVAILABLE");
    }
    await this.guard.assertRootAuthority();
    return createWorkspaceSnapshot({
      projectRoot: this.guard.canonicalRoot,
      rootId: this.#rootId,
      branch,
      head,
      createdAt: new Date().toISOString(),
      gitState,
      relevantFileHashes: relevantAfter,
    });
  }

  async readEvidenceRange(
    relativePath: string,
    startLine: number,
    endLine: number,
  ): Promise<WorkspaceEvidenceRange> {
    const normalizedPath = this.guard.validateRelativePath(relativePath);
    this.guard.validateLineRange(startLine, endLine);
    const current = await this.#currentFile(normalizedPath);
    const spans = textLineSpans(current.text);
    const first = spans[startLine - 1];
    const last = spans[endLine - 1];
    if (!first || !last) throw new WorkspaceAccessError("LINE_RANGE_OUT_OF_BOUNDS");
    const excerptEnd = last.start === last.end ? last.delimiterEnd : last.end;
    const excerpt = current.text.slice(first.start, excerptEnd);
    if (UTF8_ENCODER.encode(excerpt).byteLength > this.guard.maxExcerptBytes) {
      throw new WorkspaceAccessError("EXCERPT_TOO_LARGE");
    }
    return {
      path: current.canonicalRelativePath,
      startLine,
      endLine,
      totalLines: spans.length,
      excerpt,
      fileHash: current.fileHash,
      byteLength: current.bytes.byteLength,
      sourceLocationKey: current.sourceLocationKey,
    };
  }

  async #ignoreContext(prefix: string): Promise<{
    context: IgnoreContext | null;
    complete: boolean;
    fingerprint: string | null;
  }> {
    const ignorePath = prefix.length === 0 ? ".gitignore" : `${prefix}/.gitignore`;
    try {
      const file = await this.guard.readFileBytes(ignorePath);
      if (file.bytes.byteLength > MAX_IGNORE_FILE_BYTES) {
        return { context: null, complete: false, fingerprint: null };
      }
      const matcher = ignore();
      matcher.add(decodeUtf8(file.bytes));
      return {
        context: { prefix, matcher },
        complete: true,
        fingerprint: `file:${hash(file.bytes)}`,
      };
    } catch (error) {
      if (error instanceof WorkspaceAccessError && error.code === "FILE_NOT_FOUND") {
        return { context: null, complete: true, fingerprint: "absent" };
      }
      return { context: null, complete: false, fingerprint: null };
    }
  }

  async #workspaceFiles(maxFiles = this.#maxSearchFiles, skipDirectories: ReadonlySet<string> = new Set()): Promise<{ paths: string[]; truncated: boolean }> {
    const files: string[] = [];
    let truncated = false;
    let traversalEntries = 0;
    const visit = async (prefix: string, inheritedContexts: readonly IgnoreContext[]): Promise<void> => {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const loadedIgnore = await this.#ignoreContext(prefix);
      if (!loadedIgnore.complete) {
        truncated = true;
        return;
      }
      const contexts = loadedIgnore.context === null
        ? inheritedContexts
        : [...inheritedContexts, loadedIgnore.context];
      const subtreeFileStart = files.length;
      try {
        const entries = [];
        try {
          const directory = await this.guard.resolveTraversalDirectory(prefix);
          const stream = await opendir(directory.canonicalPath);
          for await (const entry of stream) {
            if (traversalEntries >= this.#maxTraversalEntries) {
              truncated = true;
              break;
            }
            traversalEntries += 1;
            entries.push(entry);
          }
          const afterReadDirectory = await this.guard.resolveTraversalDirectory(prefix);
          if (
            !samePath(afterReadDirectory.canonicalPath, directory.canonicalPath) ||
            afterReadDirectory.sourceLocationKey !== directory.sourceLocationKey ||
            afterReadDirectory.sourceVersionKey !== directory.sourceVersionKey
          ) {
            truncated = true;
            return;
          }
        } catch (error) {
          if (error instanceof WorkspaceAccessError && error.code === "WORKSPACE_ROOT_CHANGED") throw error;
          truncated = true;
          return;
        }
        entries.sort((left, right) => comparePaths(left.name, right.name));
        for (const entry of entries) {
          if (files.length >= maxFiles) {
            truncated = true;
            return;
          }
          const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (
              SKIPPED_DIRECTORIES.has(entry.name.toLowerCase()) || skipDirectories.has(entry.name) ||
              this.guard.classifyDeniedPath(`${relativePath}/probe`) !== null ||
              ignoredByContexts(contexts, relativePath, true)
            ) continue;
            await visit(relativePath, contexts);
          } else if (
            entry.isFile() &&
            this.guard.classifyDeniedPath(relativePath) === null &&
            !ignoredByContexts(contexts, relativePath, false)
          ) {
            files.push(relativePath);
          }
        }
      } finally {
        const observedIgnore = await this.#ignoreContext(prefix);
        if (
          !observedIgnore.complete ||
          observedIgnore.fingerprint !== loadedIgnore.fingerprint
        ) {
          files.splice(subtreeFileStart);
          truncated = true;
        }
      }
    };
    await visit("", []);
    files.sort(comparePaths);
    return { paths: files, truncated };
  }

  async #rgCandidatePaths(
    query: string,
    paths: readonly string[],
    caseSensitive: boolean,
  ): Promise<Set<string> | null> {
    if (this.#rgExecutable === null) return null;
    const allowed = new Set(paths);
    const matches = new Set<string>();
    for (const pathChunk of chunksForArguments(paths)) {
      const result = await runBoundedProcess(
        this.#rgExecutable,
        [
          "--no-config",
          "--json",
          "--files-with-matches",
          "--fixed-strings",
          caseSensitive ? "--case-sensitive" : "--ignore-case",
          "--color=never",
          "--no-messages",
          "--",
          query,
          ...pathChunk,
        ],
        this.guard.canonicalRoot,
        MAX_RG_OUTPUT_BYTES,
        RG_TIMEOUT_MS,
      );
      if (result.status !== "completed" || (result.code !== 0 && result.code !== 1)) return null;
      const output = result.stdout.toString("utf8");
      if (output.trim().length === 0) continue;
      for (const line of output.split("\n")) {
        if (line.length === 0) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return null;
        }
        if (typeof event !== "object" || event === null) return null;
        const record = event as {
          type?: unknown;
          data?: { path?: { text?: unknown } };
        };
        if (record.type !== "begin" && record.type !== "match") continue;
        const rawPath = record.data?.path?.text;
        if (typeof rawPath !== "string") return null;
        const normalized = rawPath.replaceAll("\\", "/").replace(/^\.\//u, "");
        if (!allowed.has(normalized)) return null;
        matches.add(normalized);
      }
    }
    return matches;
  }

  async searchProject(query: string, options: SearchOptions = {}): Promise<WorkspaceSearchResult> {
    if (
      typeof query !== "string" ||
      query.trim().length === 0 ||
      query.length > MAX_QUERY_LENGTH ||
      /[\0\r\n]/.test(query)
    ) {
      throw new WorkspaceAccessError("INVALID_QUERY");
    }
    const maxResults = Math.min(positiveInteger(options.maxResults, this.#maxSearchResults), this.#maxSearchResults);
    const needle = options.caseSensitive === true ? query : query.toLocaleLowerCase("en-US");
    const files = await this.#workspaceFiles();
    let candidatePaths = files.paths;
    if (this.#searchBackend !== "walker" && files.paths.length > 0) {
      const rgMatches = await this.#rgCandidatePaths(query, files.paths, options.caseSensitive === true);
      if (rgMatches !== null) candidatePaths = files.paths.filter((path) => rgMatches.has(path));
    }
    const inspectedPaths: string[] = [];
    const matches: WorkspaceSearchMatch[] = [];
    let truncated = files.truncated;

    outer: for (const path of candidatePaths) {
      let current;
      try {
        current = await this.#currentFile(path);
      } catch (error) {
        if (error instanceof WorkspaceAccessError) {
          await this.guard.assertRootAuthority();
          truncated = true;
          continue;
        }
        throw error;
      }
      inspectedPaths.push(path);
      const lines = splitLines(current.text);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const lineText = lines[lineIndex]!;
        const haystack = options.caseSensitive === true ? lineText : lineText.toLocaleLowerCase("en-US");
        let fromIndex = 0;
        while (fromIndex <= haystack.length - needle.length) {
          const index = haystack.indexOf(needle, fromIndex);
          if (index < 0) break;
          if (matches.length >= maxResults) {
            truncated = true;
            break outer;
          }
          const line = lineIndex + 1;
          const excerpt = `${line}: ${lineText}`;
          if (UTF8_ENCODER.encode(excerpt).byteLength <= this.guard.maxExcerptBytes) {
            matches.push({
              path,
              line,
              column: index + 1,
              startLine: line,
              endLine: line,
              excerpt,
              fileHash: current.fileHash,
            });
          } else {
            truncated = true;
          }
          fromIndex = index + Math.max(needle.length, 1);
        }
      }
    }
    await this.guard.assertRootAuthority();
    return { query, matches, inspectedPaths, truncated };
  }

  async search(query: string, options: SearchOptions = {}): Promise<WorkspaceSearchResult> {
    return await this.searchProject(query, options);
  }
}

export async function openReadOnlyWorkspace(
  root: VerifiedWorkspaceRoot,
  options: WorkspaceOptions = {},
  dependencies: PathGuardDependencies = {},
): Promise<ReadOnlyWorkspace> {
  const guard = await createPathGuard(root, options, dependencies);
  const [git, rg] = await Promise.all([
    resolveTrustedWorkspaceExecutable("git", guard.canonicalRoot, {
      explicitPath: options.gitExecutable,
    }),
    resolveTrustedWorkspaceExecutable("rg", guard.canonicalRoot, {
      explicitPath: options.rgExecutable,
    }),
  ]);
  return new ReadOnlyWorkspace(guard, options, { git, rg });
}

/** Test/bootstrap helper. Production code must bind through resolveWorkspaceRoot first. */
export async function openReadOnlyWorkspaceForTesting(
  root: string,
  options: WorkspaceOptions = {},
  dependencies: PathGuardDependencies = {},
): Promise<ReadOnlyWorkspace> {
  const guard = await createPathGuardForTesting(root, options, dependencies);
  const [git, rg] = await Promise.all([
    resolveTrustedWorkspaceExecutable("git", guard.canonicalRoot, {
      explicitPath: options.gitExecutable,
    }),
    resolveTrustedWorkspaceExecutable("rg", guard.canonicalRoot, {
      explicitPath: options.rgExecutable,
    }),
  ]);
  return new ReadOnlyWorkspace(guard, options, { git, rg });
}
