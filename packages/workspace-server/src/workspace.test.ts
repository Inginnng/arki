import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceSnapshot,
  issueEvidencePacket,
  validateEvidence,
} from "@aimd/reader-core";

import { WorkspaceAccessError } from "./path-guard.js";
import {
  hardenWorkspaceGitArguments,
  hardenWorkspaceGitEnvironment,
  openReadOnlyWorkspaceForTesting,
  resolveTrustedWorkspaceExecutable,
} from "./workspace.js";

const temporaryDirectories: string[] = [];
const SNAPSHOT_CREATED_AT = "2026-09-02T00:00:00.000Z";

function registerEvidenceSnapshot(
  projectRoot: string,
  rootId: string,
  path: string,
  hash: string,
): string {
  return createWorkspaceSnapshot({
    projectRoot,
    rootId,
    branch: null,
    head: null,
    createdAt: SNAPSHOT_CREATED_AT,
    gitState: { kind: "clean" },
    relevantFileHashes: [{ path, hash }],
  }).snapshotDigest;
}

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `aimd-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("read-only workspace", () => {
  it("reads current dirty bytes with a hash, exact range, and numbered bounded excerpt", async () => {
    const root = await temporaryDirectory("workspace-dirty");
    await mkdir(join(root, "docs"));
    const document = join(root, "docs", "architecture.md");
    await writeFile(document, "one\ncommitted placeholder\nthree\n", "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root, { maxExcerptLines: 4 });

    const dirty = "one\nDIRTY_SENTINEL_ONLY_IN_WORKTREE\nthree\n";
    await writeFile(document, dirty, "utf8");
    const result = await workspace.readFile("docs/architecture.md", { startLine: 2, endLine: 3 });

    expect(result).toEqual({
      path: "docs/architecture.md",
      startLine: 2,
      endLine: 3,
      totalLines: 3,
      lines: [
        { line: 2, text: "DIRTY_SENTINEL_ONLY_IN_WORKTREE" },
        { line: 3, text: "three" },
      ],
      excerpt: "2: DIRTY_SENTINEL_ONLY_IN_WORKTREE\n3: three",
      fileHash: createHash("sha256").update(Buffer.from(dirty)).digest("hex"),
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("returns an exact unnumbered evidence range with the authoritative raw-byte hash", async () => {
    const root = await temporaryDirectory("workspace-evidence-range");
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("one\r\ntwo\n", "utf8"),
    ]);
    await writeFile(join(root, "guide.md"), bytes);
    const workspace = await openReadOnlyWorkspaceForTesting(root);

    const range = await workspace.readEvidenceRange("guide.md", 1, 2);
    expect(range).toMatchObject({
      path: "guide.md",
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      excerpt: "one\r\ntwo",
      fileHash: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    });
    expect(range.sourceLocationKey).toMatch(/^[a-f0-9]{64}$/);
    const snapshotDigest = registerEvidenceSnapshot(root, "root-bom", range.path, range.fileHash);

    const packet = issueEvidencePacket({
      runId: "run-bom",
      generation: "generation-bom",
      snapshotDigest,
      sources: [{ kind: "project_document", ...range }],
    }, { idFactory: (scope) => `${scope}-bom` });
    const answer = await validateEvidence({
      candidate: {
        conclusionClaimId: "claim-bom",
        claims: [{ id: "claim-bom", statement: "The guide contains two lines.", category: "document_literal", evidenceIds: ["evidence-bom"] }],
        unknowns: [],
      },
      packet,
      expectedRunId: "run-bom",
      expectedGeneration: "generation-bom",
      currentSnapshotDigest: snapshotDigest,
      contextMode: "project_only",
      readEvidence: (path, startLine, endLine) => workspace.readEvidenceRange(path, startLine, endLine),
    });
    expect(answer.reviewStatus).toBe("citation_validated");
    expect(answer.evidence[0]).toMatchObject({ fileHash: range.fileHash, excerpt: "one\r\ntwo" });
  });

  it("preserves a final blank CRLF line so the range can be issued as evidence", async () => {
    const root = await temporaryDirectory("workspace-evidence-final-blank");
    await writeFile(join(root, "blank.md"), "one\r\n\r\n", "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root);

    const range = await workspace.readEvidenceRange("blank.md", 1, 2);

    expect(range.excerpt).toBe("one\r\n\r\n");
    const snapshotDigest = registerEvidenceSnapshot(
      root,
      "root-final-blank",
      range.path,
      range.fileHash,
    );
    expect(() => issueEvidencePacket({
      runId: "run-final-blank",
      generation: "generation-final-blank",
      snapshotDigest,
      sources: [{ kind: "project_document", ...range }],
    })).not.toThrow();
  });

  it("preserves single and internal blank LF line boundaries", async () => {
    const root = await temporaryDirectory("workspace-evidence-blank-lines");
    const workspace = await openReadOnlyWorkspaceForTesting(root);
    await writeFile(join(root, "single.md"), "\n", "utf8");
    await writeFile(join(root, "internal.md"), "one\n\nthree", "utf8");

    const singleBlank = await workspace.readEvidenceRange("single.md", 1, 1);
    const includingInternalBlank = await workspace.readEvidenceRange("internal.md", 1, 2);

    expect(singleBlank.excerpt).toBe("\n");
    expect(includingInternalBlank.excerpt).toBe("one\n\n");
    const snapshotDigest = registerEvidenceSnapshot(
      root,
      "root-internal-blank",
      includingInternalBlank.path,
      includingInternalBlank.fileHash,
    );
    expect(() => issueEvidencePacket({
      runId: "run-internal-blank",
      generation: "generation-internal-blank",
      snapshotDigest,
      sources: [{ kind: "project_document", ...includingInternalBlank }],
    })).not.toThrow();
  });

  it("does not reopen a validated path when collecting workspace bytes", async () => {
    const root = await temporaryDirectory("workspace-stable-handle");
    const document = join(root, "guide.md");
    await writeFile(document, "before\n", "utf8");
    let openCount = 0;
    const workspace = await openReadOnlyWorkspaceForTesting(root, {}, {
      afterOpen: async () => {
        openCount += 1;
      },
    });

    await expect(workspace.readFile("guide.md")).resolves.toMatchObject({ excerpt: "1: before" });
    expect(openCount).toBe(1);
  });

  it("bounds requested ranges and returns sanitized failures", async () => {
    const root = await temporaryDirectory("workspace-bounds");
    await writeFile(join(root, "guide.md"), "one\ntwo\nthree\nfour\n", "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root, { maxExcerptLines: 2 });

    await expect(workspace.readFile("guide.md", { startLine: 1, endLine: 3 })).rejects.toMatchObject({
      code: "LINE_RANGE_TOO_LARGE",
    });
    await expect(workspace.readFile("guide.md", { startLine: 4, endLine: 5 })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WorkspaceAccessError &&
        error.code === "LINE_RANGE_OUT_OF_BOUNDS" &&
        !error.message.includes(root),
    );
    await expect(workspace.readFile("guide.md", { startLine: 5 })).rejects.toMatchObject({
      code: "LINE_RANGE_OUT_OF_BOUNDS",
    });
  });

  it("searches current text deterministically and returns relative hash-bound ranges", async () => {
    const root = await temporaryDirectory("workspace-search");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "zeta.ts"), "const target = 'old';\n", "utf8");
    await writeFile(join(root, "src", "alpha.ts"), "// TARGET first\nconst x = 1;\n", "utf8");
    await writeFile(join(root, ".env"), "TARGET=must-not-leak\n", "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root);
    await writeFile(join(root, "src", "zeta.ts"), "const target = 'DIRTY';\n", "utf8");

    const search = await workspace.search("target", { maxResults: 10 });

    expect(search.matches.map(({ path, line, column }) => ({ path, line, column }))).toEqual([
      { path: "src/alpha.ts", line: 1, column: 4 },
      { path: "src/zeta.ts", line: 1, column: 7 },
    ]);
    expect(search.matches[1]).toMatchObject({
      path: "src/zeta.ts",
      startLine: 1,
      endLine: 1,
      excerpt: "1: const target = 'DIRTY';",
    });
    expect(search.matches.every((match) => /^[a-f0-9]{64}$/.test(match.fileHash))).toBe(true);
    expect(search.inspectedPaths).toEqual(["src/alpha.ts", "src/zeta.ts"]);
    expect(search.truncated).toBe(false);
    expect(JSON.stringify(search)).not.toContain(root);
    expect(JSON.stringify(search)).not.toContain("must-not-leak");
  });

  it("caps deterministic search results and rejects blank or oversized queries", async () => {
    const root = await temporaryDirectory("workspace-search-bounds");
    await writeFile(join(root, "a.md"), "needle\nneedle\n", "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root, { maxSearchResults: 1 });

    const result = await workspace.search("needle");
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
    await expect(workspace.search("   ")).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(workspace.search("needle\nsecond-line")).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(workspace.search("x".repeat(513))).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("marks search incomplete when a matching line cannot fit the excerpt budget", async () => {
    const root = await temporaryDirectory("workspace-search-excerpt-budget");
    await writeFile(join(root, "long.md"), `TOKEN ${"x".repeat(100)}\n`, "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root, { maxExcerptBytes: 8 });

    const result = await workspace.search("TOKEN");

    expect(result.matches).toEqual([]);
    expect(result.inspectedPaths).toEqual(["long.md"]);
    expect(result.truncated).toBe(true);
  });

  it("bounds traversal entries even when a tree contains only empty directories", async () => {
    const root = await temporaryDirectory("workspace-traversal-budget");
    for (let index = 0; index < 12; index += 1) {
      await mkdir(join(root, `empty-${String(index).padStart(2, "0")}`));
    }
    const workspace = await openReadOnlyWorkspaceForTesting(root, { maxTraversalEntries: 5 });

    const result = await workspace.search("needle");

    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("marks search incomplete when a discovered file cannot be read stably", async () => {
    const root = await temporaryDirectory("workspace-search-incomplete");
    const target = join(root, "changing.md");
    await writeFile(target, "needle before\n", "utf8");
    let changed = false;
    const workspace = await openReadOnlyWorkspaceForTesting(root, {}, {
      afterOpen: async () => {
        if (changed) return;
        changed = true;
        await writeFile(target, "changed after discovery\n", "utf8");
      },
    });

    const result = await workspace.search("needle");

    expect(result.matches).toEqual([]);
    expect(result.inspectedPaths).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("aborts search when the verified root authority changes during file reads", async () => {
    const parent = await temporaryDirectory("workspace-search-root-change-parent");
    const root = join(parent, "workspace");
    const displaced = join(parent, "workspace-original");
    const replacement = join(parent, "replacement");
    await mkdir(root);
    await mkdir(replacement);
    await writeFile(join(root, "guide.md"), "needle original\n", "utf8");
    await writeFile(join(replacement, "guide.md"), "needle replacement\n", "utf8");
    let swapped = false;
    const workspace = await openReadOnlyWorkspaceForTesting(root, {}, {
      beforeOpen: async () => {
        if (swapped) return;
        swapped = true;
        await rename(root, displaced);
        await rename(replacement, root);
      },
    });

    await expect(workspace.search("needle")).rejects.toMatchObject({
      code: "WORKSPACE_ROOT_CHANGED",
    });
  });

  it("canonicalizes in-root evidence aliases to one physical source identity", async () => {
    const root = await temporaryDirectory("workspace-evidence-alias");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "real.ts"), "export const value = 1;\n", "utf8");
    await symlink(join(root, "src"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    const workspace = await openReadOnlyWorkspaceForTesting(root);

    const direct = await workspace.readEvidenceRange("src/real.ts", 1, 1);
    const aliased = await workspace.readEvidenceRange("alias/real.ts", 1, 1);

    expect(aliased.path).toBe("src/real.ts");
    expect(aliased.sourceLocationKey).toBe(direct.sourceLocationKey);
  });

  it("marks traversal incomplete when a directory is replaced at the same path", async () => {
    const root = await temporaryDirectory("workspace-directory-swap");
    const outside = await temporaryDirectory("workspace-directory-replacement");
    const swappable = join(root, "swappable");
    const displaced = join(root, "swappable-old");
    await mkdir(swappable);
    await writeFile(join(swappable, "old.md"), "needle old\n", "utf8");
    await writeFile(join(outside, "new.md"), "needle replacement\n", "utf8");
    let swappableResolutions = 0;
    const workspace = await openReadOnlyWorkspaceForTesting(root, {}, {
      beforeResolveTraversal: async (relativePath) => {
        if (relativePath !== "swappable") return;
        swappableResolutions += 1;
        if (swappableResolutions !== 2) return;
        await rename(swappable, displaced);
        await rename(outside, swappable);
      },
    });

    const result = await workspace.search("needle");

    expect(result.truncated).toBe(true);
    expect(result.matches).toEqual([]);
  });

  it.each(["add", "delete_recreate", "rename_swap"] as const)(
    "marks traversal incomplete when the same directory has a %s mutation during enumeration",
    async (mutation) => {
      const root = await temporaryDirectory(`workspace-directory-${mutation}`);
      const first = join(root, "first.md");
      const second = join(root, "second.md");
      const temporary = join(root, "swap.tmp");
      await writeFile(first, "needle first\n", "utf8");
      await writeFile(second, "second\n", "utf8");
      let rootResolutions = 0;
      const workspace = await openReadOnlyWorkspaceForTesting(root, {}, {
        beforeResolveTraversal: async (relativePath) => {
          if (relativePath !== "") return;
          rootResolutions += 1;
          if (rootResolutions !== 2) return;
          if (mutation === "add") {
            await writeFile(join(root, "late.md"), "needle late\n", "utf8");
          } else if (mutation === "delete_recreate") {
            await rm(first);
            await writeFile(first, "replacement\n", "utf8");
          } else {
            await rename(first, temporary);
            await rename(second, first);
            await rename(temporary, second);
          }
        },
      });

      const result = await workspace.search("needle");

      expect(result.truncated).toBe(true);
    },
  );
});

describe("bounded project workspace operations", () => {
  it.each(["git", "rg"] as const)(
    "skips a project-local %s executable while resolving a trusted absolute candidate",
    async (command) => {
      const root = await temporaryDirectory(`workspace-untrusted-${command}`);
      const trustedBin = await temporaryDirectory(`workspace-trusted-${command}`);
      const executableName = process.platform === "win32" ? `${command}.exe` : command;
      const projectExecutable = join(root, executableName);
      const trustedExecutable = join(trustedBin, executableName);
      await writeFile(projectExecutable, "project controlled", "utf8");
      await writeFile(trustedExecutable, "trusted placeholder", "utf8");
      if (process.platform !== "win32") {
        await chmod(projectExecutable, 0o755);
        await chmod(trustedExecutable, 0o755);
      }

      const pathValue = [root, trustedBin].join(process.platform === "win32" ? ";" : ":");
      await expect(resolveTrustedWorkspaceExecutable(command, root, { pathValue }))
        .resolves.toBe(await realpath(trustedExecutable));
      await expect(resolveTrustedWorkspaceExecutable(command, root, { pathValue: root }))
        .resolves.toBeNull();
    },
  );

  it("forces non-interactive Git execution without project-controlled helpers", () => {
    const args = hardenWorkspaceGitArguments(["status", "--porcelain=v1"]);
    expect(args).toEqual(expect.arrayContaining([
      "--no-optional-locks",
      "core.fsmonitor=false",
      "submodule.recurse=false",
      "diff.external=",
      "status",
    ]));
    expect(args.find((value) => value.startsWith("core.hooksPath="))).toBeDefined();

    const environment = hardenWorkspaceGitEnvironment({
      PATH: "trusted-path",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "project-hook",
      GIT_EXTERNAL_DIFF: "project-diff",
      GIT_DIR: "project-git-dir",
      RIPGREP_CONFIG_PATH: "project-rg-config",
    });
    expect(environment).toMatchObject({
      PATH: "trusted-path",
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(environment).not.toHaveProperty("GIT_CONFIG_KEY_0");
    expect(environment).not.toHaveProperty("GIT_CONFIG_VALUE_0");
    expect(environment).not.toHaveProperty("GIT_EXTERNAL_DIFF");
    expect(environment).not.toHaveProperty("GIT_DIR");
  });

  it("reads Markdown with headings, a byte hash, and one-based numbered lines", async () => {
    const root = await temporaryDirectory("workspace-document");
    const source = [
      "# Sample Project",
      "",
      "## Architecture",
      "",
      "```md",
      "# Not a real heading",
      "```",
      "",
      "Worker Flow",
      "-----------",
      "",
    ].join("\n");
    await writeFile(join(root, "README.md"), source, "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root);

    const document = await workspace.readDocument("README.md");

    expect(document).toMatchObject({
      path: "README.md",
      hash: createHash("sha256").update(Buffer.from(source)).digest("hex"),
      anchorStatus: { status: "available" },
    });
    expect(document.lines.slice(0, 3)).toEqual([
      { number: 1, text: "# Sample Project" },
      { number: 2, text: "" },
      { number: 3, text: "## Architecture" },
    ]);
    expect(document.headings).toEqual([
      { depth: 1, text: "Sample Project", line: 1 },
      { depth: 2, text: "Architecture", line: 3 },
      { depth: 2, text: "Worker Flow", line: 9 },
    ]);
    expect(JSON.stringify(document)).not.toContain(root);
  });

  it("preserves a UTF-8 BOM in the exact source while still recognizing headings", async () => {
    const root = await temporaryDirectory("workspace-document-bom");
    const source = "\uFEFF# BOM Project\n\nBody\n";
    await writeFile(join(root, "README.md"), source, "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root);

    const [document, exact] = await Promise.all([
      workspace.readDocument("README.md"),
      workspace.readDocumentSource("README.md"),
    ]);

    expect(document.hash).toBe(createHash("sha256").update(Buffer.from(source)).digest("hex"));
    expect(document.headings).toEqual([{ depth: 1, text: "BOM Project", line: 1 }]);
    expect(exact).toEqual({ path: "README.md", source, hash: document.hash });
  });

  it("uses the same canonical Markdown outline semantics as source anchors", async () => {
    const root = await temporaryDirectory("workspace-canonical-outline");
    const source = [
      "# *Architecture*",
      "",
      "~~~md",
      "~~~ still-open",
      "# Fence false",
      "~~~",
      "",
      "<div>",
      "# HTML false",
      "</div>",
      "",
      "Alpha",
      "Beta",
      "-----",
    ].join("\n");
    await writeFile(join(root, "README.md"), source, "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root);

    const document = await workspace.readDocument("README.md");

    expect(document.anchorStatus).toEqual({ status: "available" });
    expect(document.headings).toEqual([
      { depth: 1, text: "Architecture", line: 1 },
      { depth: 2, text: "Alpha\nBeta", line: 12 },
    ]);
  });

  it("keeps over-budget Markdown viewable while explicitly disabling anchors", async () => {
    const root = await temporaryDirectory("workspace-view-only-outline");
    const source = `# ${"*".repeat(8_193)}\nbody`;
    await writeFile(join(root, "README.md"), source, "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root);

    const document = await workspace.readDocument("README.md");

    expect(document.lines).toHaveLength(2);
    expect(document.headings).toEqual([]);
    expect(document.anchorStatus).toEqual({
      status: "view_only",
      code: "SOURCE_ANCHOR_COMPLEXITY_BUDGET",
    });
  });

  it("exposes a bounded readLines alias without returning absolute paths", async () => {
    const root = await temporaryDirectory("workspace-read-lines");
    await writeFile(join(root, "guide.md"), "one\ntwo\nthree\n", "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root, { maxExcerptLines: 2 });

    const result = await workspace.readLines("guide.md", 2, 3);

    expect(result).toMatchObject({
      path: "guide.md",
      startLine: 2,
      endLine: 3,
      lines: [
        { line: 2, text: "two" },
        { line: 3, text: "three" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("changes the trusted snapshot when current workspace bytes change", async () => {
    const root = await temporaryDirectory("workspace-snapshot-dirty");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "sentinel.ts"), "export const value = 'dirty-a';\n", "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root);

    const before = await workspace.snapshot({ relevantPaths: ["src/sentinel.ts"] });
    await writeFile(join(root, "src", "sentinel.ts"), "export const value = 'dirty-b';\n", "utf8");
    const after = await workspace.snapshot({ relevantPaths: ["src/sentinel.ts"] });
    const reopened = await openReadOnlyWorkspaceForTesting(root);
    const reopenedSnapshot = await reopened.snapshot({ relevantPaths: ["src/sentinel.ts"] });

    expect(after.publicSnapshot.dirtyStateDigest).not.toBe(before.publicSnapshot.dirtyStateDigest);
    expect(after.snapshotDigest).not.toBe(before.snapshotDigest);
    expect(after.publicSnapshot.rootId).toBe(before.publicSnapshot.rootId);
    expect(reopenedSnapshot.publicSnapshot.rootId).not.toBe(after.publicSnapshot.rootId);
    expect(after.publicSnapshot.rootId).not.toBe(
      createHash("sha256")
        .update("aimd-workspace-root-v1\0", "utf8")
        .update(root, "utf8")
        .digest("hex"),
    );
    expect(after.relevantFileHashes).toEqual([
      {
        path: "src/sentinel.ts",
        hash: createHash("sha256")
          .update(Buffer.from("export const value = 'dirty-b';\n"))
          .digest("hex"),
      },
    ]);
    expect(JSON.stringify(after.publicSnapshot)).not.toContain(root);
  });

  it("keeps an explicitly injected internal root id stable across workspace reopen", async () => {
    const root = await temporaryDirectory("workspace-stable-root-id");
    await writeFile(join(root, "README.md"), "# Stable\n", "utf8");
    const rootId = "root-stable-production";

    const first = await openReadOnlyWorkspaceForTesting(root, { rootId });
    const reopened = await openReadOnlyWorkspaceForTesting(root, { rootId });

    await expect(first.snapshot()).resolves.toMatchObject({ publicSnapshot: { rootId } });
    await expect(reopened.snapshot()).resolves.toMatchObject({ publicSnapshot: { rootId } });
  });

  it("rejects an invalid injected internal root id instead of weakening to a random id", async () => {
    const root = await temporaryDirectory("workspace-invalid-root-id");
    await writeFile(join(root, "README.md"), "# Invalid\n", "utf8");

    await expect(openReadOnlyWorkspaceForTesting(root, { rootId: "C:\\private\\root" }))
      .rejects.toThrow(/Opaque ids/u);
  });

  it.each(["walker", "rg"] as const)(
    "applies gitignore, dependency, build, credential, and configured deny rules in the %s backend",
    async (searchBackend) => {
      const root = await temporaryDirectory(`workspace-ignore-${searchBackend}`);
      await mkdir(join(root, "nested"), { recursive: true });
      await mkdir(join(root, "node_modules", "package"), { recursive: true });
      await mkdir(join(root, "dist"), { recursive: true });
      await mkdir(join(root, "mixed", "NODE_MODULES", "package"), { recursive: true });
      await mkdir(join(root, "mixed", "DIST"), { recursive: true });
      await mkdir(join(root, "private"), { recursive: true });
      await writeFile(
        join(root, ".gitignore"),
        [
          "ignored-root.md",
          "nested/generated/**",
          "nested/*.md",
          "!nested/kept.md",
          "!.env",
          "!private/notes.md",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(join(root, "nested", ".gitignore"), "ignored-local.md\n", "utf8");
      await mkdir(join(root, "nested", "generated"), { recursive: true });
      await writeFile(join(root, "visible.md"), "AIMD_NEEDLE visible\n", "utf8");
      await writeFile(join(root, "ignored-root.md"), "AIMD_NEEDLE ignored root\n", "utf8");
      await writeFile(join(root, "nested", "ignored-local.md"), "AIMD_NEEDLE ignored nested\n", "utf8");
      await writeFile(join(root, "nested", "kept.md"), "AIMD_NEEDLE unignored safely\n", "utf8");
      await writeFile(join(root, "nested", "generated", "file.md"), "AIMD_NEEDLE ignored generated\n", "utf8");
      await writeFile(join(root, "node_modules", "package", "index.js"), "AIMD_NEEDLE dependency\n", "utf8");
      await writeFile(join(root, "dist", "bundle.js"), "AIMD_NEEDLE build\n", "utf8");
      await writeFile(join(root, "mixed", "NODE_MODULES", "package", "index.js"), "AIMD_NEEDLE mixed dependency\n", "utf8");
      await writeFile(join(root, "mixed", "DIST", "bundle.js"), "AIMD_NEEDLE mixed build\n", "utf8");
      await writeFile(join(root, "private", "notes.md"), "AIMD_NEEDLE configured deny\n", "utf8");
      await writeFile(join(root, ".env"), "AIMD_NEEDLE=credential\n", "utf8");
      const workspace = await openReadOnlyWorkspaceForTesting(root, {
        denyGlobs: ["private/**"],
        searchBackend,
      });

      const result = await workspace.searchProject("AIMD_NEEDLE");

      expect(result.matches.map((match) => match.path)).toEqual(["nested/kept.md", "visible.md"]);
      expect(result.inspectedPaths).not.toEqual(expect.arrayContaining([
        "ignored-root.md",
        "nested/ignored-local.md",
        "nested/generated/file.md",
        "node_modules/package/index.js",
        "dist/bundle.js",
        "mixed/NODE_MODULES/package/index.js",
        "mixed/DIST/bundle.js",
        "private/notes.md",
        ".env",
      ]));
      expect(JSON.stringify(result)).not.toContain(root);
    },
  );

  it("fails search closed when a gitignore file cannot be read safely", async () => {
    const root = await temporaryDirectory("workspace-unreadable-gitignore");
    await writeFile(join(root, ".gitignore"), "private.md\n", "utf8");
    await writeFile(join(root, "private.md"), "AIMD_NEEDLE must remain excluded\n", "utf8");
    await writeFile(join(root, "visible.md"), "AIMD_NEEDLE visible\n", "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root, {
      denyGlobs: [".gitignore"],
      searchBackend: "walker",
    });

    await expect(workspace.searchProject("AIMD_NEEDLE")).resolves.toEqual({
      query: "AIMD_NEEDLE",
      matches: [],
      inspectedPaths: [],
      truncated: true,
    });
  });

  it("discards a subtree when its gitignore changes during enumeration", async () => {
    const root = await temporaryDirectory("workspace-changing-gitignore");
    await writeFile(join(root, ".gitignore"), "", "utf8");
    await writeFile(join(root, "visible.md"), "AIMD_NEEDLE visible\n", "utf8");
    let rootTraversalChecks = 0;
    const workspace = await openReadOnlyWorkspaceForTesting(root, { searchBackend: "walker" }, {
      beforeResolveTraversal: async (relativePath) => {
        if (relativePath !== "") return;
        rootTraversalChecks += 1;
        if (rootTraversalChecks === 2) {
          await writeFile(join(root, ".gitignore"), "visible.md\n", "utf8");
        }
      },
    });

    await expect(workspace.searchProject("AIMD_NEEDLE")).resolves.toEqual({
      query: "AIMD_NEEDLE",
      matches: [],
      inspectedPaths: [],
      truncated: true,
    });
  });

  it("falls back to the bounded walker when rg is unavailable", async () => {
    const root = await temporaryDirectory("workspace-rg-fallback");
    await writeFile(join(root, "README.md"), "fallback needle\n", "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root, {
      searchBackend: "auto",
      rgExecutable: join(root, "missing-rg-executable"),
    });

    await expect(workspace.searchProject("fallback needle")).resolves.toMatchObject({
      matches: [{ path: "README.md" }],
      truncated: false,
    });
  });

  it("rejects non-Markdown documents with a fixed non-leaking error", async () => {
    const root = await temporaryDirectory("workspace-document-extension");
    await writeFile(join(root, "notes.txt"), "# Looks like Markdown\n", "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root);

    await expect(workspace.readDocument("notes.txt")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WorkspaceAccessError &&
        error.code === "NOT_MARKDOWN_DOCUMENT" &&
        !error.message.includes(root),
    );
  });

  it("prepares an internal safe-write descriptor only after a stable Markdown read", async () => {
    const root = await temporaryDirectory("workspace-safe-output-source");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n", "utf8");
    await writeFile(join(root, "docs", "notes.txt"), "not markdown\n", "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root);

    await expect(workspace.prepareSafeOutputSource("docs/guide.md")).resolves.toEqual({
      canonicalRoot: workspace.guard.canonicalRoot,
      canonicalSourcePath: join(workspace.guard.canonicalRoot, "docs", "guide.md"),
      sourceContentSha256: createHash("sha256").update(Buffer.from("# Guide\n")).digest("hex"),
    });
    await expect(workspace.prepareSafeOutputSource("docs/notes.txt")).rejects.toMatchObject({
      code: "NOT_MARKDOWN_DOCUMENT",
    });
  });

  it("changes a non-Git snapshot for additions and deletions without claiming clean", async () => {
    const root = await temporaryDirectory("workspace-snapshot-add-delete");
    await writeFile(join(root, "old.md"), "old\n", "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root);

    const before = await workspace.snapshot();
    await rm(join(root, "old.md"));
    await writeFile(join(root, "new.md"), "new\n", "utf8");
    const after = await workspace.snapshot();

    expect(before.internalSnapshot.head).toBeNull();
    expect(after.internalSnapshot.head).toBeNull();
    expect(after.publicSnapshot.dirtyStateDigest).not.toBe(before.publicSnapshot.dirtyStateDigest);
  });

  it("keeps ignored dependency trees outside the authorized non-Git snapshot budget", async () => {
    const root = await temporaryDirectory("workspace-snapshot-ignored-dependencies");
    await mkdir(join(root, "node_modules", "package"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Visible\n", "utf8");
    await writeFile(join(root, "node_modules", "package", "cache.bin"), "x".repeat(4_096), "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root, { maxSnapshotBytes: 128 });

    await expect(workspace.snapshot({ relevantPaths: ["README.md"] })).resolves.toMatchObject({
      relevantFileHashes: [{ path: "README.md" }],
    });
  });

  it("fails closed when a complete non-Git snapshot exceeds its file budget", async () => {
    const root = await temporaryDirectory("workspace-snapshot-budget");
    await writeFile(join(root, "one.md"), "one\n", "utf8");
    await writeFile(join(root, "two.md"), "two\n", "utf8");
    const workspace = await openReadOnlyWorkspaceForTesting(root, { maxSnapshotFiles: 1 });

    await expect(workspace.snapshot()).rejects.toMatchObject({ code: "SNAPSHOT_UNAVAILABLE" });
  });
});
