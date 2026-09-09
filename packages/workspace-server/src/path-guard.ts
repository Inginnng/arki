import { createHash } from "node:crypto";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import { RelativePathSchema } from "@aimd/contracts";

import {
  isCanonicalPathContained as isContained,
  sameCanonicalPath,
} from "./canonical-path.js";
import {
  isSensitiveTreePath,
  isVerifiedWorkspaceRoot,
  resolveWorkspaceRoot,
  type VerifiedWorkspaceRoot,
} from "./root-resolver.js";

export type WorkspaceAccessErrorCode =
  | "INVALID_ROOT"
  | "WORKSPACE_ROOT_CHANGED"
  | "INVALID_RELATIVE_PATH"
  | "PATH_ESCAPE"
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "CREDENTIAL_FILE"
  | "DENIED_PATH"
  | "BINARY_FILE"
  | "FILE_TOO_LARGE"
  | "FILE_CHANGED_DURING_READ"
  | "INVALID_LINE_RANGE"
  | "LINE_RANGE_TOO_LARGE"
  | "LINE_RANGE_OUT_OF_BOUNDS"
  | "EXCERPT_TOO_LARGE"
  | "INVALID_TEXT_ENCODING"
  | "INVALID_QUERY"
  | "NOT_MARKDOWN_DOCUMENT"
  | "SNAPSHOT_UNAVAILABLE";

const PUBLIC_MESSAGES: Record<WorkspaceAccessErrorCode, string> = {
  INVALID_ROOT: "The workspace root is unavailable.",
  WORKSPACE_ROOT_CHANGED: "The verified workspace root changed and must be rebound.",
  INVALID_RELATIVE_PATH: "A normalized workspace-relative path is required.",
  PATH_ESCAPE: "The requested path is outside the project root.",
  FILE_NOT_FOUND: "The requested file is not available.",
  NOT_A_FILE: "The requested path is not a readable file.",
  CREDENTIAL_FILE: "Credential files are excluded from project retrieval.",
  DENIED_PATH: "The requested path is excluded from project retrieval.",
  BINARY_FILE: "Binary files are excluded from project retrieval.",
  FILE_TOO_LARGE: "The requested file exceeds the retrieval size limit.",
  FILE_CHANGED_DURING_READ: "The requested file changed while it was being read.",
  INVALID_LINE_RANGE: "A valid one-based inclusive line range is required.",
  LINE_RANGE_TOO_LARGE: "A bounded line range is required.",
  LINE_RANGE_OUT_OF_BOUNDS: "The requested line range is unavailable.",
  EXCERPT_TOO_LARGE: "The requested excerpt exceeds the retrieval size limit.",
  INVALID_TEXT_ENCODING: "The requested file is not valid UTF-8 text.",
  INVALID_QUERY: "A bounded non-blank search query is required.",
  NOT_MARKDOWN_DOCUMENT: "The requested document is not Markdown.",
  SNAPSHOT_UNAVAILABLE: "A complete stable workspace snapshot is unavailable.",
};

export class WorkspaceAccessError extends Error {
  readonly code: WorkspaceAccessErrorCode;

  constructor(code: WorkspaceAccessErrorCode) {
    super(PUBLIC_MESSAGES[code]);
    this.name = "WorkspaceAccessError";
    this.code = code;
  }
}

export interface PathGuardOptions {
  denyGlobs?: readonly string[];
  maxFileBytes?: number;
  maxExcerptLines?: number;
  maxExcerptBytes?: number;
}

/** Internal test/host hooks. They cannot authorize a path or bypass validation. */
export interface PathGuardDependencies {
  beforeOpen?(canonicalPath: string): void | Promise<void>;
  afterOpen?(canonicalPath: string): void | Promise<void>;
  beforeResolveTraversal?(relativePath: string): void | Promise<void>;
}

export interface GuardedReadableFile {
  relativePath: string;
  canonicalRelativePath: string;
  canonicalPath: string;
  size: number;
  sourceLocationKey: string;
}

export interface GuardedFileBytes extends GuardedReadableFile {
  bytes: Buffer;
}

export interface GuardedTraversalDirectory {
  canonicalPath: string;
  sourceLocationKey: string;
  sourceVersionKey: string;
}

// This is both the production default and a hard public-workspace ceiling.
// Test/host options may lower it to exercise bounded behavior, never raise it.
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_EXCERPT_LINES = 200;
const DEFAULT_MAX_EXCERPT_BYTES = 64 * 1024;
const BINARY_EXTENSIONS = new Set([
  ".7z", ".avi", ".bmp", ".class", ".dll", ".doc", ".docx", ".exe", ".gif", ".gz",
  ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4", ".o", ".obj", ".pdf",
  ".png", ".ppt", ".pptx", ".pyc", ".so", ".tar", ".wav", ".webp", ".xls", ".xlsx", ".zip",
]);
const CREDENTIAL_GLOBS = [
  ".env*", "**/.env*", ".npmrc", "**/.npmrc", ".pypirc", "**/.pypirc",
  ".netrc", "**/.netrc", "credentials", "credentials.*", "**/credentials", "**/credentials.*",
  "id_rsa", "id_rsa.*", "**/id_rsa", "**/id_rsa.*", "id_ed25519", "id_ed25519.*",
  "**/id_ed25519", "**/id_ed25519.*", "*.pem", "**/*.pem", "*.key", "**/*.key",
  "*.p12", "**/*.p12", "*.pfx", "**/*.pfx",
] as const;
const DEFAULT_DENY_GLOBS = [
  ".git", "**/.git", ".git/**", "**/.git/**",
  ".hg", "**/.hg", ".hg/**", "**/.hg/**",
  ".svn", "**/.svn", ".svn/**", "**/.svn/**",
  ".aimd-git", "**/.aimd-git", ".aimd-git/**", "**/.aimd-git/**",
] as const;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function escapeRegexCharacter(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function compileGlob(glob: string): RegExp | null {
  const normalized = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.length === 0 || normalized.includes("\0")) return null;
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegexCharacter(character);
    }
  }
  return new RegExp(`${expression}$`, "i");
}

function containsNul(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

async function readBoundedBytes(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= maxBytes) {
    const remaining = maxBytes + 1 - totalBytes;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > maxBytes) throw new WorkspaceAccessError("FILE_TOO_LARGE");
  return Buffer.concat(chunks, totalBytes);
}

interface BigIntFileState {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  nlink: bigint;
}

function sameIdentity(left: BigIntFileState, right: BigIntFileState): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameVersion(left: BigIntFileState, right: BigIntFileState): boolean {
  return sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function opaqueLocationKey(state: Pick<BigIntFileState, "dev" | "ino">): string {
  return createHash("sha256").update(`${state.dev.toString()}:${state.ino.toString()}`).digest("hex");
}

function opaqueVersionKey(
  state: Pick<BigIntFileState, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">,
): string {
  return createHash("sha256").update([
    state.dev,
    state.ino,
    state.size,
    state.mtimeNs,
    state.ctimeNs,
  ].map((part) => part.toString()).join(":"), "utf8").digest("hex");
}

export class WorkspacePathGuard {
  readonly canonicalRoot: string;
  readonly maxFileBytes: number;
  readonly maxExcerptLines: number;
  readonly maxExcerptBytes: number;
  readonly #credentialMatchers: readonly RegExp[];
  readonly #denyMatchers: readonly RegExp[];
  readonly #dependencies: PathGuardDependencies;
  readonly #rootIdentity: VerifiedWorkspaceRoot["identity"];

  private constructor(
    rootBinding: VerifiedWorkspaceRoot,
    options: PathGuardOptions,
    dependencies: PathGuardDependencies,
  ) {
    this.canonicalRoot = rootBinding.canonicalRoot;
    this.#rootIdentity = rootBinding.identity;
    this.maxFileBytes = Math.min(
      positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
      DEFAULT_MAX_FILE_BYTES,
    );
    this.maxExcerptLines = positiveInteger(options.maxExcerptLines, DEFAULT_MAX_EXCERPT_LINES);
    this.maxExcerptBytes = positiveInteger(options.maxExcerptBytes, DEFAULT_MAX_EXCERPT_BYTES);
    this.#credentialMatchers = CREDENTIAL_GLOBS.map(compileGlob).filter((value): value is RegExp => value !== null);
    this.#denyMatchers = [...DEFAULT_DENY_GLOBS, ...(options.denyGlobs ?? [])]
      .map(compileGlob)
      .filter((value): value is RegExp => value !== null);
    this.#dependencies = dependencies;
  }

  static async create(
    root: VerifiedWorkspaceRoot,
    options: PathGuardOptions = {},
    dependencies: PathGuardDependencies = {},
  ): Promise<WorkspacePathGuard> {
    if (!isVerifiedWorkspaceRoot(root)) {
      throw new WorkspaceAccessError("WORKSPACE_ROOT_CHANGED");
    }
    const suppliedPath = root.canonicalRoot;
    if (
      typeof suppliedPath !== "string" || suppliedPath.length === 0 ||
      suppliedPath.includes("\0") || !isAbsolute(suppliedPath)
    ) throw new WorkspaceAccessError("WORKSPACE_ROOT_CHANGED");
    try {
      const canonicalRoot = await realpath(suppliedPath);
      const rootStat = await stat(canonicalRoot, { bigint: true });
      if (!rootStat.isDirectory()) {
        throw new WorkspaceAccessError("WORKSPACE_ROOT_CHANGED");
      }
      if (isSensitiveTreePath(canonicalRoot)) {
        throw new WorkspaceAccessError("WORKSPACE_ROOT_CHANGED");
      }
      const observedIdentity = { device: rootStat.dev.toString(), inode: rootStat.ino.toString() };
      if (
        !sameCanonicalPath(root.canonicalRoot, canonicalRoot) ||
        root.identity.device !== observedIdentity.device ||
        root.identity.inode !== observedIdentity.inode
      ) throw new WorkspaceAccessError("WORKSPACE_ROOT_CHANGED");
      return new WorkspacePathGuard(root, options, dependencies);
    } catch (error) {
      if (error instanceof WorkspaceAccessError) throw error;
      throw new WorkspaceAccessError("WORKSPACE_ROOT_CHANGED");
    }
  }

  async #assertRootStable(): Promise<void> {
    try {
      const canonicalRoot = await realpath(this.canonicalRoot);
      const state = await stat(canonicalRoot, { bigint: true });
      if (
        !state.isDirectory() ||
        isSensitiveTreePath(canonicalRoot) ||
        !sameCanonicalPath(canonicalRoot, this.canonicalRoot) ||
        state.dev.toString() !== this.#rootIdentity.device ||
        state.ino.toString() !== this.#rootIdentity.inode
      ) throw new WorkspaceAccessError("WORKSPACE_ROOT_CHANGED");
    } catch (error) {
      if (error instanceof WorkspaceAccessError) throw error;
      throw new WorkspaceAccessError("WORKSPACE_ROOT_CHANGED");
    }
  }

  async assertRootAuthority(): Promise<void> {
    await this.#assertRootStable();
  }

  classifyDeniedPath(relativePath: string): "CREDENTIAL_FILE" | "DENIED_PATH" | null {
    const segments = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
    for (let length = 1; length <= segments.length; length += 1) {
      const ancestorOrPath = segments.slice(0, length).join("/");
      if (this.#credentialMatchers.some((matcher) => matcher.test(ancestorOrPath))) {
        return "CREDENTIAL_FILE";
      }
    }
    if (this.#denyMatchers.some((matcher) => matcher.test(relativePath))) return "DENIED_PATH";
    return null;
  }

  validateRelativePath(relativePath: string): string {
    const parsed = RelativePathSchema.safeParse(relativePath);
    if (
      !parsed.success ||
      relativePath.includes(":") ||
      /[\u0000-\u001f\u007f]/.test(relativePath)
    ) throw new WorkspaceAccessError("INVALID_RELATIVE_PATH");
    return parsed.data;
  }

  validateLineRange(startLine: number, endLine: number): { startLine: number; endLine: number } {
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new WorkspaceAccessError("INVALID_LINE_RANGE");
    }
    if (endLine - startLine + 1 > this.maxExcerptLines) {
      throw new WorkspaceAccessError("LINE_RANGE_TOO_LARGE");
    }
    return { startLine, endLine };
  }

  async #canonicalFileCandidate(relativePath: string): Promise<{
    relativePath: string;
    canonicalPath: string;
  }> {
    await this.#assertRootStable();
    const normalizedPath = this.validateRelativePath(relativePath);
    const denied = this.classifyDeniedPath(normalizedPath);
    if (denied !== null) throw new WorkspaceAccessError(denied);
    if (BINARY_EXTENSIONS.has(extname(normalizedPath).toLowerCase())) {
      throw new WorkspaceAccessError("BINARY_FILE");
    }

    const lexicalPath = resolve(this.canonicalRoot, ...normalizedPath.split("/"));
    if (!isContained(this.canonicalRoot, lexicalPath)) throw new WorkspaceAccessError("PATH_ESCAPE");

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(lexicalPath);
    } catch {
      throw new WorkspaceAccessError("FILE_NOT_FOUND");
    }
    if (!isContained(this.canonicalRoot, canonicalPath)) throw new WorkspaceAccessError("PATH_ESCAPE");

    const canonicalRelativePath = relative(this.canonicalRoot, canonicalPath).split(sep).join("/");
    const canonicalDenied = this.classifyDeniedPath(canonicalRelativePath);
    if (canonicalDenied !== null) throw new WorkspaceAccessError(canonicalDenied);
    if (BINARY_EXTENSIONS.has(extname(canonicalRelativePath).toLowerCase())) {
      throw new WorkspaceAccessError("BINARY_FILE");
    }

    let fileStat;
    try {
      fileStat = await stat(canonicalPath);
    } catch {
      throw new WorkspaceAccessError("FILE_NOT_FOUND");
    }
    if (!fileStat.isFile()) throw new WorkspaceAccessError("NOT_A_FILE");
    if (fileStat.size > this.maxFileBytes) throw new WorkspaceAccessError("FILE_TOO_LARGE");
    return { relativePath: normalizedPath, canonicalPath };
  }

  async readFileBytes(relativePath: string): Promise<GuardedFileBytes> {
    const candidate = await this.#canonicalFileCandidate(relativePath);
    await this.#dependencies.beforeOpen?.(candidate.canonicalPath);

    let handle;
    try {
      handle = await open(candidate.canonicalPath, "r");
    } catch {
      throw new WorkspaceAccessError("FILE_NOT_FOUND");
    }

    try {
      const openedState = await handle.stat({ bigint: true });
      if (!openedState.isFile()) throw new WorkspaceAccessError("NOT_A_FILE");
      if (openedState.nlink > 1n) throw new WorkspaceAccessError("DENIED_PATH");
      if (openedState.size > BigInt(this.maxFileBytes)) throw new WorkspaceAccessError("FILE_TOO_LARGE");

      let checkedCanonicalPath: string;
      let checkedPathState;
      try {
        checkedCanonicalPath = await realpath(candidate.canonicalPath);
        checkedPathState = await stat(checkedCanonicalPath, { bigint: true });
      } catch {
        throw new WorkspaceAccessError("FILE_CHANGED_DURING_READ");
      }
      if (!isContained(this.canonicalRoot, checkedCanonicalPath)) {
        throw new WorkspaceAccessError("PATH_ESCAPE");
      }
      if (
        !sameCanonicalPath(candidate.canonicalPath, checkedCanonicalPath) ||
        !sameVersion(openedState, checkedPathState)
      ) {
        throw new WorkspaceAccessError("FILE_CHANGED_DURING_READ");
      }

      await this.#dependencies.afterOpen?.(checkedCanonicalPath);
      const bytes = await readBoundedBytes(handle, this.maxFileBytes);
      const finalHandleState = await handle.stat({ bigint: true });
      let finalCanonicalPath: string;
      let finalPathState;
      try {
        finalCanonicalPath = await realpath(candidate.canonicalPath);
        finalPathState = await stat(finalCanonicalPath, { bigint: true });
      } catch {
        throw new WorkspaceAccessError("FILE_CHANGED_DURING_READ");
      }
      if (!isContained(this.canonicalRoot, finalCanonicalPath)) {
        throw new WorkspaceAccessError("PATH_ESCAPE");
      }
      if (
        !sameCanonicalPath(checkedCanonicalPath, finalCanonicalPath) ||
        !sameVersion(openedState, finalHandleState) ||
        !sameVersion(finalHandleState, finalPathState) ||
        BigInt(bytes.byteLength) !== finalHandleState.size
      ) {
        throw new WorkspaceAccessError("FILE_CHANGED_DURING_READ");
      }
      if (containsNul(bytes)) throw new WorkspaceAccessError("BINARY_FILE");
      await this.#assertRootStable();
      return {
        relativePath: candidate.relativePath,
        canonicalRelativePath: relative(this.canonicalRoot, finalCanonicalPath).split(sep).join("/"),
        canonicalPath: finalCanonicalPath,
        size: bytes.byteLength,
        sourceLocationKey: opaqueLocationKey(finalHandleState),
        bytes,
      };
    } catch (error) {
      if (error instanceof WorkspaceAccessError) throw error;
      throw new WorkspaceAccessError("FILE_CHANGED_DURING_READ");
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async resolveReadableFile(relativePath: string): Promise<GuardedReadableFile> {
    const { bytes: _bytes, ...file } = await this.readFileBytes(relativePath);
    return file;
  }

  async resolveTraversalDirectory(relativePath = ""): Promise<GuardedTraversalDirectory> {
    await this.#assertRootStable();
    let lexicalPath = this.canonicalRoot;
    if (relativePath.length > 0) {
      const normalizedPath = this.validateRelativePath(relativePath);
      lexicalPath = resolve(this.canonicalRoot, ...normalizedPath.split("/"));
    }
    if (!isContained(this.canonicalRoot, lexicalPath)) throw new WorkspaceAccessError("PATH_ESCAPE");
    try {
      await this.#dependencies.beforeResolveTraversal?.(relativePath);
      const canonicalPath = await realpath(lexicalPath);
      const directoryState = await stat(canonicalPath, { bigint: true });
      if (
        !directoryState.isDirectory() ||
        !isContained(this.canonicalRoot, canonicalPath) ||
        !sameCanonicalPath(lexicalPath, canonicalPath)
      ) {
        throw new WorkspaceAccessError("PATH_ESCAPE");
      }
      await this.#assertRootStable();
      return {
        canonicalPath,
        sourceLocationKey: opaqueLocationKey(directoryState),
        sourceVersionKey: opaqueVersionKey(directoryState),
      };
    } catch (error) {
      if (error instanceof WorkspaceAccessError) throw error;
      throw new WorkspaceAccessError("FILE_NOT_FOUND");
    }
  }
}

export function createPathGuard(
  root: VerifiedWorkspaceRoot,
  options: PathGuardOptions = {},
  dependencies: PathGuardDependencies = {},
): Promise<WorkspacePathGuard> {
  return WorkspacePathGuard.create(root, options, dependencies);
}

/** Test/bootstrap helper. Production code must use a host-authoritative VerifiedWorkspaceRoot. */
export async function createPathGuardForTesting(
  root: string,
  options: PathGuardOptions = {},
  dependencies: PathGuardDependencies = {},
): Promise<WorkspacePathGuard> {
  const resolution = await resolveWorkspaceRoot({ mcpRoots: [root] });
  if (resolution.status !== "verified") throw new WorkspaceAccessError("INVALID_ROOT");
  return WorkspacePathGuard.create(resolution.rootBinding, options, dependencies);
}
