import { mkdir, mkdtemp, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { resolveWorkspaceRoot } from "./root-resolver.js";
import { openReadOnlyWorkspace } from "./workspace.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `aimd-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resolveWorkspaceRoot", () => {
  it("treats the exact thread/read workspace as authoritative and cross-checks MCP roots", async () => {
    const root = await temporaryDirectory("verified-root");
    const alias = join(root, ".", "nested", "..");
    await mkdir(join(root, "nested"));

    await expect(resolveWorkspaceRoot({ threadWorkspaceRoot: alias, mcpRoots: [root] })).resolves.toMatchObject({
      status: "verified",
      contextMode: "task_and_project",
      canonicalRoot: await realpath(root),
      rootBinding: { canonicalRoot: await realpath(root) },
      source: "thread_read",
      reason: null,
    });
  });

  it("uses an exact thread/read root when roots/list is genuinely unavailable", async () => {
    const root = await temporaryDirectory("thread-only");

    const resolved = await resolveWorkspaceRoot({ threadWorkspaceRoot: root });

    expect(resolved.status).toBe("verified");
    expect(resolved.contextMode).toBe("task_and_project");
    expect(resolved.canonicalRoot).toBe(await realpath(root));
  });

  it("fails closed on a thread/read and roots/list mismatch", async () => {
    const threadRoot = await temporaryDirectory("thread-root");
    const mcpRoot = await temporaryDirectory("mcp-root");

    await expect(
      resolveWorkspaceRoot({ threadWorkspaceRoot: threadRoot, mcpRoots: [mcpRoot] }),
    ).resolves.toEqual({
      status: "degraded",
      contextMode: "document_only",
      canonicalRoot: null,
      source: null,
      reason: "ROOT_MISMATCH",
    });

    await expect(
      resolveWorkspaceRoot({ threadWorkspaceRoot: threadRoot, mcpRoots: [] }),
    ).resolves.toMatchObject({ status: "degraded", reason: "ROOT_MISMATCH" });
  });

  it("accepts a canonical thread workspace contained by an allowed MCP root", async () => {
    const allowedRoot = await temporaryDirectory("allowed-parent");
    const threadRoot = join(allowedRoot, "worktree");
    await mkdir(threadRoot);

    await expect(
      resolveWorkspaceRoot({ threadWorkspaceRoot: threadRoot, mcpRoots: [allowedRoot] }),
    ).resolves.toMatchObject({
      status: "verified",
      contextMode: "task_and_project",
      canonicalRoot: await realpath(threadRoot),
    });
  });

  it("permits project-only mode only from an allowed roots/list root", async () => {
    const root = await temporaryDirectory("project-only");

    await expect(resolveWorkspaceRoot({ mcpRoots: [root] })).resolves.toMatchObject({
      status: "verified",
      contextMode: "project_only",
      canonicalRoot: await realpath(root),
      rootBinding: { canonicalRoot: await realpath(root) },
      source: "mcp_roots",
      reason: null,
    });

    const noRoots = await resolveWorkspaceRoot({ mcpRoots: [] });
    expect(noRoots).toEqual({
      status: "degraded",
      contextMode: "document_only",
      canonicalRoot: null,
      source: null,
      reason: "MCP_ROOT_REQUIRED",
    });
  });

  it("rejects a supplied document outside the only MCP root", async () => {
    const root = await temporaryDirectory("single-root-document");
    const outside = await temporaryDirectory("single-root-document-outside");
    const document = join(outside, "README.md");
    await writeFile(document, "# Outside\n", "utf8");

    await expect(resolveWorkspaceRoot({
      mcpRoots: [root],
      trustedHostDocumentPath: document,
    })).resolves.toMatchObject({
      status: "degraded",
      reason: "ROOT_MISMATCH",
    });
  });

  it("rejects a supplied document outside an exact thread workspace", async () => {
    const root = await temporaryDirectory("thread-document-root");
    const outside = await temporaryDirectory("thread-document-outside");
    const document = join(outside, "README.md");
    await writeFile(document, "# Outside\n", "utf8");

    await expect(resolveWorkspaceRoot({
      threadWorkspaceRoot: root,
      trustedHostDocumentPath: document,
    })).resolves.toMatchObject({
      status: "degraded",
      reason: "ROOT_MISMATCH",
    });
  });

  it("rejects a supplied document that cannot be canonicalized", async () => {
    const root = await temporaryDirectory("missing-document-root");

    await expect(resolveWorkspaceRoot({
      mcpRoots: [root],
      trustedHostDocumentPath: join(root, "missing.md"),
    })).resolves.toMatchObject({
      status: "degraded",
      reason: "ROOT_MISMATCH",
    });
  });

  it.each([
    [".git", "config"],
    ["credentials", "README.md"],
  ])("rejects a supplied document inside a sensitive tree", async (...segments) => {
    const root = await temporaryDirectory(`sensitive-document-${segments[0]!.replace(".", "dot-")}`);
    const document = join(root, ...segments);
    await mkdir(join(root, segments[0]!), { recursive: true });
    await writeFile(document, "TOKEN=sensitive\n", "utf8");

    await expect(resolveWorkspaceRoot({
      mcpRoots: [root],
      trustedHostDocumentPath: document,
    })).resolves.toMatchObject({
      status: "degraded",
      reason: "ROOT_MISMATCH",
    });
  });

  it("does not use process.cwd or a recent-thread heuristic when binding data is missing", async () => {
    const resolved = await resolveWorkspaceRoot({});

    expect(resolved).toEqual({
      status: "degraded",
      contextMode: "document_only",
      canonicalRoot: null,
      source: null,
      reason: "WORKSPACE_ROOT_UNAVAILABLE",
    });
    expect(JSON.stringify(resolved)).not.toContain(process.cwd());
  });

  it("accepts platform file URIs from the roots/list protocol without cwd resolution", async () => {
    const root = await temporaryDirectory("mcp-file-uri");
    const selected = await resolveWorkspaceRoot({ mcpRoots: [{ uri: pathToFileURL(root).href }] });
    expect(selected).toMatchObject({
      status: "verified",
      contextMode: "project_only",
      canonicalRoot: await realpath(root),
    });

    let canonicalizeCalls = 0;
    const relative = await resolveWorkspaceRoot(
      { threadWorkspaceRoot: "." },
      {
        canonicalize: async () => {
          canonicalizeCalls += 1;
          return root;
        },
      },
    );
    expect(relative).toMatchObject({
      status: "degraded",
      reason: "WORKSPACE_ROOT_UNAVAILABLE",
    });
    expect(canonicalizeCalls).toBe(0);
  });

  it("decodes spaces and non-ASCII characters from MCP file URIs", async () => {
    const parent = await temporaryDirectory("mcp-encoded-file-uri");
    const root = join(parent, "项目 with spaces");
    await mkdir(root);

    const selected = await resolveWorkspaceRoot({
      mcpRoots: [{ uri: pathToFileURL(root).href }],
    });

    expect(selected).toMatchObject({
      status: "verified",
      contextMode: "project_only",
      canonicalRoot: await realpath(root),
    });
  });

  it("rejects oversized roots/list input before any canonicalization", async () => {
    const root = await temporaryDirectory("mcp-root-limit");
    let canonicalizeCalls = 0;
    const canonicalize = async (value: string) => {
      canonicalizeCalls += 1;
      return await realpath(value);
    };

    await expect(resolveWorkspaceRoot(
      { mcpRoots: Array.from({ length: 33 }, () => root) },
      { canonicalize },
    )).resolves.toMatchObject({
      status: "degraded",
      reason: "ROOT_INPUT_LIMIT_EXCEEDED",
    });
    await expect(resolveWorkspaceRoot(
      { mcpRoots: [{ uri: `file:///${"a".repeat(4_097)}` }] },
      { canonicalize },
    )).resolves.toMatchObject({
      status: "degraded",
      reason: "ROOT_INPUT_LIMIT_EXCEEDED",
    });
    expect(canonicalizeCalls).toBe(0);
  });

  it("does not guess among multiple MCP roots without a uniquely contained document", async () => {
    const first = await temporaryDirectory("first-root");
    const second = await temporaryDirectory("second-root");

    const ambiguous = await resolveWorkspaceRoot({ mcpRoots: [first, second] });
    expect(ambiguous.reason).toBe("AMBIGUOUS_MCP_ROOT");
    expect(ambiguous.contextMode).toBe("document_only");

    const document = join(second, "README.md");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(document, "# Selected\n", "utf8");
    const selected = await resolveWorkspaceRoot({
      mcpRoots: [first, second],
      trustedHostDocumentPath: document,
    });
    expect(selected.contextMode).toBe("project_only");
    expect(selected.canonicalRoot).toBe(await realpath(second));
  });

  it("binds root identity so a replaced workspace root cannot be trusted later", async () => {
    const parent = await temporaryDirectory("root-binding-parent");
    const root = join(parent, "workspace");
    const moved = join(parent, "workspace-original");
    const outside = await temporaryDirectory("root-binding-outside");
    await mkdir(root);
    await writeFile(join(root, "safe.md"), "inside\n", "utf8");
    await writeFile(join(outside, "secret.md"), "outside secret\n", "utf8");

    const resolution = await resolveWorkspaceRoot({ mcpRoots: [root] });
    expect(resolution.status).toBe("verified");
    if (resolution.status !== "verified") throw new Error("expected verified root");

    await rename(root, moved);
    await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");

    await expect(openReadOnlyWorkspace(resolution.rootBinding)).rejects.toMatchObject({
      code: "WORKSPACE_ROOT_CHANGED",
    });
  });

  it("rejects a different directory moved into the same canonical root pathname", async () => {
    const parent = await temporaryDirectory("root-identity-parent");
    const root = join(parent, "workspace");
    const moved = join(parent, "workspace-original");
    const replacement = join(parent, "replacement");
    await mkdir(root);
    await mkdir(replacement);
    await writeFile(join(root, "safe.md"), "inside\n", "utf8");
    await writeFile(join(replacement, "secret.md"), "replacement secret\n", "utf8");

    const resolution = await resolveWorkspaceRoot({ mcpRoots: [root] });
    expect(resolution.status).toBe("verified");
    if (resolution.status !== "verified") throw new Error("expected verified root");

    await rename(root, moved);
    await rename(replacement, root);
    expect(await realpath(root)).toBe(resolution.canonicalRoot);

    await expect(openReadOnlyWorkspace(resolution.rootBinding)).rejects.toMatchObject({
      code: "WORKSPACE_ROOT_CHANGED",
    });
  });

  it("rejects a non-directory root even when canonicalization succeeds", async () => {
    const parent = await temporaryDirectory("root-file");
    const file = join(parent, "not-a-workspace.md");
    await writeFile(file, "not a directory\n", "utf8");

    await expect(resolveWorkspaceRoot({ mcpRoots: [file] })).resolves.toMatchObject({
      status: "degraded",
      reason: "MCP_ROOT_REQUIRED",
    });
  });

  it.each([".git", ".hg", ".svn", ".aimd-git"])(
    "rejects a workspace root inside the %s control tree",
    async (controlDirectory) => {
      const parent = await temporaryDirectory(`control-root-${controlDirectory.slice(1)}`);
      const root = join(parent, controlDirectory, "worktrees", "candidate");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "config"), "TOKEN=control-secret\n", "utf8");

      await expect(resolveWorkspaceRoot({ mcpRoots: [root] })).resolves.toMatchObject({
        status: "degraded",
        reason: "MCP_ROOT_REQUIRED",
      });
    },
  );

  it.each([
    ["credentials"],
    [".env", "nested"],
    [".envrc", "nested"],
  ])("rejects a workspace root inside a credential control tree", async (...segments) => {
    const parent = await temporaryDirectory(`credential-root-${segments[0]!.replace(".", "dot-")}`);
    const root = join(parent, ...segments);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "prod.json"), "TOKEN=credential-secret\n", "utf8");

    await expect(resolveWorkspaceRoot({ mcpRoots: [root] })).resolves.toMatchObject({
      status: "degraded",
      reason: "MCP_ROOT_REQUIRED",
    });
  });
});
