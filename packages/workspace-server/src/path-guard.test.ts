import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceAccessError, createPathGuard, createPathGuardForTesting } from "./path-guard.js";
import { openReadOnlyWorkspaceForTesting } from "./workspace.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `aimd-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("workspace path guard", () => {
  it("rejects a structurally forged root binding without the authority brand", async () => {
    const root = await temporaryDirectory("guard-forged-root");
    await expect(createPathGuard({
      canonicalRoot: root,
      identity: { device: "0", inode: "0" },
    } as never)).rejects.toMatchObject({ code: "WORKSPACE_ROOT_CHANGED" });
  });

  it("refuses to bootstrap a workspace from inside a credential directory", async () => {
    const parent = await temporaryDirectory("guard-credential-root");
    const root = join(parent, "credentials");
    await mkdir(root);
    await writeFile(join(root, "prod.json"), "TOKEN=secret\n", "utf8");

    await expect(createPathGuardForTesting(root)).rejects.toMatchObject({ code: "INVALID_ROOT" });
  });

  it("returns only canonical in-root files addressed by normalized relative paths", async () => {
    const root = await temporaryDirectory("guard-root");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "guide.md"), "safe\n", "utf8");
    const guard = await createPathGuardForTesting(root);

    const file = await guard.resolveReadableFile("docs/guide.md");

    expect(file.relativePath).toBe("docs/guide.md");
    expect(file.canonicalPath.startsWith(guard.canonicalRoot)).toBe(true);
    await expect(guard.resolveReadableFile("../outside.md")).rejects.toMatchObject({ code: "INVALID_RELATIVE_PATH" });
    await expect(guard.resolveReadableFile(join(root, "docs", "guide.md"))).rejects.toMatchObject({
      code: "INVALID_RELATIVE_PATH",
    });
  });

  it("rejects a symlink or junction whose real path escapes the canonical root", async () => {
    const root = await temporaryDirectory("guard-link-root");
    const outside = await temporaryDirectory("guard-link-outside");
    await writeFile(join(outside, "escaped.md"), "outside\n", "utf8");
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const guard = await createPathGuardForTesting(root);

    await expect(guard.resolveReadableFile("linked/escaped.md")).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
  });

  it("reads through the verified handle and rejects an ancestor swapped after canonicalization", async () => {
    const root = await temporaryDirectory("guard-swap-root");
    const outside = await temporaryDirectory("guard-swap-outside");
    const swappable = join(root, "swappable");
    await mkdir(swappable);
    await writeFile(join(swappable, "evidence.md"), "inside\n", "utf8");
    await writeFile(join(outside, "evidence.md"), "outside secret\n", "utf8");
    let swapped = false;
    const guard = await createPathGuardForTesting(root, {}, {
      beforeOpen: async () => {
        if (swapped) return;
        swapped = true;
        await rm(swappable, { recursive: true, force: true });
        await symlink(outside, swappable, process.platform === "win32" ? "junction" : "dir");
      },
    });

    await expect(guard.readFileBytes("swappable/evidence.md")).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
  });

  it("aborts when an opened file changes while its stable bytes are being read", async () => {
    const root = await temporaryDirectory("guard-changing-file");
    const target = join(root, "evidence.md");
    await writeFile(target, "before\n", "utf8");
    const guard = await createPathGuardForTesting(root, {}, {
      afterOpen: async () => {
        await writeFile(target, "changed and longer\n", "utf8");
      },
    });

    await expect(guard.readFileBytes("evidence.md")).rejects.toMatchObject({
      code: "FILE_CHANGED_DURING_READ",
    });
  });

  it("bounds bytes read from an opened file that grows after its initial size check", async () => {
    const root = await temporaryDirectory("guard-growing-file");
    const target = join(root, "evidence.md");
    await writeFile(target, "before\n", "utf8");
    const guard = await createPathGuardForTesting(root, { maxFileBytes: 64 }, {
      afterOpen: async () => {
        await writeFile(target, "x".repeat(65), "utf8");
      },
    });

    await expect(guard.readFileBytes("evidence.md")).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });

  it("allows the file limit to be lowered but never raised above two MiB", async () => {
    const root = await temporaryDirectory("guard-hard-file-cap");
    const guard = await createPathGuardForTesting(root, {
      maxFileBytes: 2 * 1024 * 1024 + 1,
    });

    expect(guard.maxFileBytes).toBe(2 * 1024 * 1024);
  });

  it("accepts exactly two MiB and rejects the next byte", async () => {
    const root = await temporaryDirectory("guard-exact-file-cap");
    const exactBytes = new Uint8Array(2 * 1024 * 1024);
    exactBytes.fill(0x61);
    await writeFile(join(root, "exact.md"), exactBytes);
    await writeFile(join(root, "over.md"), new Uint8Array(exactBytes.byteLength + 1).fill(0x61));
    const guard = await createPathGuardForTesting(root);

    await expect(guard.readFileBytes("exact.md")).resolves.toMatchObject({
      size: exactBytes.byteLength,
    });
    await expect(guard.readFileBytes("over.md")).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });

  it("blocks credential names, configured deny globs, binary content, and oversized files", async () => {
    const root = await temporaryDirectory("guard-deny");
    await mkdir(join(root, "private"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".hg"));
    await mkdir(join(root, ".svn"));
    await mkdir(join(root, ".aimd-git"));
    await writeFile(join(root, ".env"), "TOKEN=secret\n", "utf8");
    await writeFile(join(root, ".envrc"), "TOKEN=secret-too\n", "utf8");
    await writeFile(join(root, ".git", "config"), "url=https://token@example.invalid\n", "utf8");
    await writeFile(join(root, ".hg", "hgrc"), "password=hidden\n", "utf8");
    await writeFile(join(root, ".svn", "entries"), "hidden\n", "utf8");
    await writeFile(join(root, ".aimd-git", "config"), "hidden\n", "utf8");
    await writeFile(join(root, "private", "notes.md"), "secret notes\n", "utf8");
    await writeFile(join(root, "nul.txt"), new Uint8Array([65, 0, 66]));
    await writeFile(join(root, "large.md"), "x".repeat(65));
    const guard = await createPathGuardForTesting(root, { denyGlobs: ["private/**"], maxFileBytes: 64 });

    await expect(guard.resolveReadableFile(".env")).rejects.toMatchObject({ code: "CREDENTIAL_FILE" });
    await expect(guard.resolveReadableFile(".envrc")).rejects.toMatchObject({ code: "CREDENTIAL_FILE" });
    await expect(guard.resolveReadableFile(".git")).rejects.toMatchObject({ code: "DENIED_PATH" });
    await expect(guard.resolveReadableFile(".git/config")).rejects.toMatchObject({ code: "DENIED_PATH" });
    await expect(guard.resolveReadableFile(".hg/hgrc")).rejects.toMatchObject({ code: "DENIED_PATH" });
    await expect(guard.resolveReadableFile(".svn/entries")).rejects.toMatchObject({ code: "DENIED_PATH" });
    await expect(guard.resolveReadableFile(".aimd-git/config")).rejects.toMatchObject({ code: "DENIED_PATH" });
    await expect(guard.resolveReadableFile("private/notes.md")).rejects.toMatchObject({ code: "DENIED_PATH" });
    await expect(guard.resolveReadableFile("nul.txt")).rejects.toMatchObject({ code: "BINARY_FILE" });
    await expect(guard.resolveReadableFile("large.md")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("reclassifies canonical targets so in-root aliases cannot bypass deny policy", async () => {
    const root = await temporaryDirectory("guard-deny-alias");
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "private"));
    await writeFile(join(root, ".git", "config"), "credential=hidden\n", "utf8");
    await writeFile(join(root, ".env"), "TOKEN=hidden\n", "utf8");
    await writeFile(join(root, "private", "notes.md"), "hidden\n", "utf8");
    await symlink(join(root, ".git"), join(root, "public-git"), process.platform === "win32" ? "junction" : "dir");
    await symlink(join(root, "private"), join(root, "public-private"), process.platform === "win32" ? "junction" : "dir");
    const guard = await createPathGuardForTesting(root, { denyGlobs: ["private/**"] });

    await expect(guard.resolveReadableFile("public-git/config")).rejects.toMatchObject({ code: "DENIED_PATH" });
    await expect(guard.resolveReadableFile("public-private/notes.md")).rejects.toMatchObject({ code: "DENIED_PATH" });
  });

  it("denies credential-directory descendants in direct reads, aliases, and search", async () => {
    const root = await temporaryDirectory("guard-credential-directories");
    await mkdir(join(root, "credentials"));
    await mkdir(join(root, ".env"));
    await writeFile(join(root, "credentials", "prod.json"), "TOKEN=credential-secret\n", "utf8");
    await writeFile(join(root, ".env", "prod.txt"), "TOKEN=environment-secret\n", "utf8");
    await writeFile(join(root, "safe.md"), "safe\n", "utf8");
    await symlink(
      join(root, "credentials"),
      join(root, "public-config"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const guard = await createPathGuardForTesting(root);

    await expect(guard.resolveReadableFile("credentials/prod.json")).rejects.toMatchObject({
      code: "CREDENTIAL_FILE",
    });
    await expect(guard.resolveReadableFile(".env/prod.txt")).rejects.toMatchObject({
      code: "CREDENTIAL_FILE",
    });
    await expect(guard.resolveReadableFile("public-config/prod.json")).rejects.toMatchObject({
      code: "CREDENTIAL_FILE",
    });

    const workspace = await openReadOnlyWorkspaceForTesting(root);
    const result = await workspace.search("TOKEN");
    expect(result.matches).toEqual([]);
    // The rg backend may eliminate non-matching authorized files before the
    // guarded excerpt pass. Credential paths must never enter either list.
    expect(result.inspectedPaths.every(path => path === "safe.md")).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("rejects multiply-linked files so hard links cannot rename denied content", async () => {
    const root = await temporaryDirectory("guard-hardlink");
    await writeFile(join(root, ".env"), "TOKEN=hidden\n", "utf8");
    await link(join(root, ".env"), join(root, "public.md"));
    const guard = await createPathGuardForTesting(root);

    await expect(guard.resolveReadableFile("public.md")).rejects.toMatchObject({ code: "DENIED_PATH" });
  });

  it("enforces one-based inclusive line ranges with a configured maximum", async () => {
    const root = await temporaryDirectory("guard-lines");
    const guard = await createPathGuardForTesting(root, { maxExcerptLines: 3 });

    expect(guard.validateLineRange(2, 4)).toEqual({ startLine: 2, endLine: 4 });
    expect(() => guard.validateLineRange(0, 1)).toThrowError(WorkspaceAccessError);
    expect(() => guard.validateLineRange(4, 2)).toThrowError(WorkspaceAccessError);
    expect(() => guard.validateLineRange(1, 4)).toThrowError(/bounded line range/i);
  });
});
