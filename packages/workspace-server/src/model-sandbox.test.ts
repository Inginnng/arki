import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { isCanonicalPathContained } from "./canonical-path.js";
import * as workspaceServer from "./index.js";
import {
  createModelSandboxLease,
  isIssuedModelSandboxLease,
  type ModelSandboxDependencies,
  type ModelSandboxDirectoryInspection,
  type ModelSandboxLease,
} from "./model-sandbox.js";

type FakeHarnessOptions = Readonly<{
  platform?: NodeJS.Platform;
  workspaceRoot?: string;
  canonicalWorkspaceRoot?: string;
  temporaryPath?: string;
  canonicalSandboxPath?: string;
  entries?: readonly string[];
}>;

function createFakeHarness(options: FakeHarnessOptions = {}) {
  const platform = options.platform ?? "linux";
  const workspaceRoot = options.workspaceRoot ?? "/workspace/project";
  const canonicalWorkspaceRoot = options.canonicalWorkspaceRoot ?? workspaceRoot;
  const temporaryPath = options.temporaryPath ?? "/private/tmp/aimd-model-sandbox-1";
  const canonicalSandboxPath = options.canonicalSandboxPath ?? temporaryPath;
  let exists = true;
  let inspection: ModelSandboxDirectoryInspection = {
    canonicalPath: canonicalSandboxPath,
    directory: true,
    symbolicLink: false,
    identity: { device: "7", inode: "11" },
  };
  let entries = [...(options.entries ?? [])];
  let beforeRemove: (() => void | Promise<void>) | undefined;

  const createTemporaryDirectory = vi.fn(async () => temporaryPath);
  const canonicalize = vi.fn(async (path: string) => {
    if (path === workspaceRoot) return canonicalWorkspaceRoot;
    if (path === temporaryPath || path === canonicalSandboxPath) return canonicalSandboxPath;
    throw new Error("ENOENT");
  });
  const inspectDirectory = vi.fn(async (path: string) => {
    if (!exists || path !== canonicalSandboxPath) throw new Error("ENOENT");
    return {
      ...inspection,
      identity: { ...inspection.identity },
    };
  });
  const readDirectory = vi.fn(async (path: string) => {
    if (!exists || path !== canonicalSandboxPath) throw new Error("ENOENT");
    return [...entries];
  });
  const removeEmptyDirectory = vi.fn(async (path: string) => {
    if (!exists || path !== canonicalSandboxPath) throw new Error("ENOENT");
    if (entries.length !== 0) throw new Error("ENOTEMPTY");
    exists = false;
  });
  const dependencies: ModelSandboxDependencies = {
    platform,
    createTemporaryDirectory,
    canonicalize,
    inspectDirectory,
    readDirectory,
    beforeRemove: async () => await beforeRemove?.(),
    removeEmptyDirectory,
  };

  return {
    workspaceRoot,
    canonicalSandboxPath,
    dependencies,
    createTemporaryDirectory,
    inspectDirectory,
    readDirectory,
    removeEmptyDirectory,
    setEntries(next: readonly string[]) {
      entries = [...next];
    },
    setIdentity(device: string, inode: string) {
      inspection = {
        ...inspection,
        identity: { device, inode },
      };
    },
    setCanonicalPath(path: string) {
      inspection = { ...inspection, canonicalPath: path };
    },
    setSymbolicLink(symbolicLink: boolean) {
      inspection = { ...inspection, symbolicLink };
    },
    setBeforeRemove(hook: () => void | Promise<void>) {
      beforeRemove = hook;
    },
  };
}

function expectSandboxError(
  promise: Promise<unknown>,
  code:
    | "MODEL_SANDBOX_UNAVAILABLE"
    | "MODEL_SANDBOX_WORKSPACE_OVERLAP"
    | "MODEL_SANDBOX_IDENTITY_CHANGED"
    | "MODEL_SANDBOX_NOT_EMPTY"
    | "MODEL_SANDBOX_CLOSED"
    | "MODEL_SANDBOX_LEASE_INVALID",
) {
  return expect(promise).rejects.toMatchObject({
    name: "ModelSandboxError",
    code,
    message: code,
  });
}

describe("model sandbox lease", () => {
  it("is available through the workspace-server public boundary", () => {
    expect(workspaceServer).toMatchObject({
      createModelSandboxLease: expect.any(Function),
      isIssuedModelSandboxLease: expect.any(Function),
    });
  });

  it("issues a frozen, canonical, empty POSIX lease and closes it once", async () => {
    const harness = createFakeHarness();
    const lease = await createModelSandboxLease(
      harness.workspaceRoot,
      harness.dependencies,
    );

    expect(lease.path).toBe(harness.canonicalSandboxPath);
    expect(Object.isFrozen(lease)).toBe(true);
    expect(isIssuedModelSandboxLease(lease)).toBe(true);
    await expect(lease.assertTrustedEmpty()).resolves.toBeUndefined();

    const firstClose = lease.close();
    const secondClose = lease.close();
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();
    expect(harness.removeEmptyDirectory).toHaveBeenCalledTimes(1);
    await expectSandboxError(lease.assertTrustedEmpty(), "MODEL_SANDBOX_CLOSED");
  });

  it("does not accept a structurally identical ordinary object as an issued lease", async () => {
    const harness = createFakeHarness();
    const lease = await createModelSandboxLease(
      harness.workspaceRoot,
      harness.dependencies,
    );
    const forged: ModelSandboxLease = {
      path: lease.path,
      assertTrustedEmpty: async () => undefined,
      close: async () => undefined,
    };

    expect(isIssuedModelSandboxLease(forged)).toBe(false);
    await expectSandboxError(
      lease.assertTrustedEmpty.call(forged),
      "MODEL_SANDBOX_LEASE_INVALID",
    );
    await lease.close();
  });

  it("snapshots dependency operations so callers cannot rewrite lease authority after issuance", async () => {
    const harness = createFakeHarness();
    const lease = await createModelSandboxLease(
      harness.workspaceRoot,
      harness.dependencies,
    );
    const rewrittenInspect = vi.fn(async () => {
      throw new Error("rewritten inspect must not run");
    });
    const rewrittenRemove = vi.fn(async () => undefined);
    Object.assign(harness.dependencies as unknown as Record<string, unknown>, {
      inspectDirectory: rewrittenInspect,
      removeEmptyDirectory: rewrittenRemove,
    });

    await expect(lease.assertTrustedEmpty()).resolves.toBeUndefined();
    await expect(lease.close()).resolves.toBeUndefined();
    expect(rewrittenInspect).not.toHaveBeenCalled();
    expect(rewrittenRemove).not.toHaveBeenCalled();
    expect(harness.removeEmptyDirectory).toHaveBeenCalledTimes(1);
  });

  it("uses injected Windows path semantics without treating sibling prefixes as children", async () => {
    const harness = createFakeHarness({
      platform: "win32",
      workspaceRoot: "c:\\Project",
      canonicalWorkspaceRoot: "C:\\Project",
      temporaryPath: "C:\\ProjectOther\\aimd-model-sandbox-1",
    });

    const lease = await createModelSandboxLease(
      harness.workspaceRoot,
      harness.dependencies,
    );
    expect(lease.path).toBe("C:\\ProjectOther\\aimd-model-sandbox-1");
    await lease.close();
  });

  it.each([
    {
      name: "the POSIX workspace itself",
      platform: "linux" as const,
      workspaceRoot: "/workspace/project",
      temporaryPath: "/workspace/project",
    },
    {
      name: "a POSIX workspace child",
      platform: "linux" as const,
      workspaceRoot: "/workspace/project",
      temporaryPath: "/workspace/project/model",
    },
    {
      name: "a POSIX workspace ancestor",
      platform: "linux" as const,
      workspaceRoot: "/workspace/project",
      temporaryPath: "/workspace",
    },
    {
      name: "the Windows workspace itself",
      platform: "win32" as const,
      workspaceRoot: "C:\\Project",
      temporaryPath: "c:\\Project",
    },
    {
      name: "a Windows workspace child",
      platform: "win32" as const,
      workspaceRoot: "C:\\Project",
      temporaryPath: "C:\\Project\\model",
    },
    {
      name: "a Windows workspace ancestor",
      platform: "win32" as const,
      workspaceRoot: "C:\\Project",
      temporaryPath: "C:\\",
    },
  ])("rejects and safely removes a newly-created empty directory at $name", async ({
    platform,
    workspaceRoot,
    temporaryPath,
  }) => {
    const harness = createFakeHarness({
      platform,
      workspaceRoot,
      canonicalWorkspaceRoot: workspaceRoot,
      temporaryPath,
      canonicalSandboxPath: temporaryPath,
    });

    await expectSandboxError(
      createModelSandboxLease(workspaceRoot, harness.dependencies),
      "MODEL_SANDBOX_WORKSPACE_OVERLAP",
    );
    expect(harness.removeEmptyDirectory).toHaveBeenCalledTimes(1);
  });

  it("rejects relative workspace and temporary paths instead of resolving them from cwd", async () => {
    const relativeWorkspace = createFakeHarness({ workspaceRoot: "project" });
    await expectSandboxError(
      createModelSandboxLease("project", relativeWorkspace.dependencies),
      "MODEL_SANDBOX_UNAVAILABLE",
    );
    expect(relativeWorkspace.createTemporaryDirectory).not.toHaveBeenCalled();

    const relativeTemporary = createFakeHarness({ temporaryPath: "model-sandbox" });
    await expectSandboxError(
      createModelSandboxLease(relativeTemporary.workspaceRoot, relativeTemporary.dependencies),
      "MODEL_SANDBOX_UNAVAILABLE",
    );
    expect(relativeTemporary.removeEmptyDirectory).not.toHaveBeenCalled();
  });

  it("refuses to issue a lease when the newly created directory is not empty", async () => {
    const harness = createFakeHarness({ entries: ["unexpected"] });

    await expectSandboxError(
      createModelSandboxLease(harness.workspaceRoot, harness.dependencies),
      "MODEL_SANDBOX_NOT_EMPTY",
    );
    expect(harness.removeEmptyDirectory).not.toHaveBeenCalled();
  });

  it("fails an emptiness assertion when an entry appears after issuance", async () => {
    const harness = createFakeHarness();
    const lease = await createModelSandboxLease(
      harness.workspaceRoot,
      harness.dependencies,
    );
    harness.setEntries(["unexpected"]);

    await expectSandboxError(lease.assertTrustedEmpty(), "MODEL_SANDBOX_NOT_EMPTY");
    const close = lease.close();
    await expectSandboxError(close, "MODEL_SANDBOX_NOT_EMPTY");
    expect(lease.close()).toBe(close);
    expect(harness.removeEmptyDirectory).not.toHaveBeenCalled();
  });

  it("fails close without deleting when directory identity changes", async () => {
    const harness = createFakeHarness();
    const lease = await createModelSandboxLease(
      harness.workspaceRoot,
      harness.dependencies,
    );
    harness.setIdentity("7", "99");

    await expectSandboxError(lease.assertTrustedEmpty(), "MODEL_SANDBOX_IDENTITY_CHANGED");
    const close = lease.close();
    await expectSandboxError(close, "MODEL_SANDBOX_IDENTITY_CHANGED");
    expect(lease.close()).toBe(close);
    expect(harness.removeEmptyDirectory).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "canonical path changed",
      mutate(harness: ReturnType<typeof createFakeHarness>) {
        harness.setCanonicalPath("/private/tmp/replacement");
      },
    },
    {
      name: "path became a symbolic link",
      mutate(harness: ReturnType<typeof createFakeHarness>) {
        harness.setSymbolicLink(true);
      },
    },
  ])("fails closed when $name", async ({ mutate }) => {
    const harness = createFakeHarness();
    const lease = await createModelSandboxLease(
      harness.workspaceRoot,
      harness.dependencies,
    );
    mutate(harness);

    await expectSandboxError(lease.assertTrustedEmpty(), "MODEL_SANDBOX_IDENTITY_CHANGED");
    await expectSandboxError(lease.close(), "MODEL_SANDBOX_IDENTITY_CHANGED");
    expect(harness.removeEmptyDirectory).not.toHaveBeenCalled();
  });

  it("rechecks identity after the pre-remove hook and never removes a replacement", async () => {
    const harness = createFakeHarness();
    const lease = await createModelSandboxLease(
      harness.workspaceRoot,
      harness.dependencies,
    );
    harness.setBeforeRemove(() => harness.setIdentity("7", "100"));

    await expectSandboxError(lease.close(), "MODEL_SANDBOX_IDENTITY_CHANGED");
    expect(harness.inspectDirectory.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(harness.removeEmptyDirectory).not.toHaveBeenCalled();
  });

  it("creates and removes a real canonical empty directory outside the workspace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "aimd-model-workspace-"));
    let lease: ModelSandboxLease | undefined;
    try {
      lease = await createModelSandboxLease(await realpath(workspaceRoot));
      expect(isAbsolute(lease.path)).toBe(true);
      expect(await realpath(lease.path)).toBe(lease.path);
      expect(await readdir(lease.path)).toEqual([]);
      expect(isCanonicalPathContained(await realpath(workspaceRoot), lease.path)).toBe(false);
      await lease.assertTrustedEmpty();
      await lease.close();
      await expect(access(lease.path)).rejects.toBeDefined();
    } finally {
      await lease?.close().catch(() => undefined);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("preserves a real replacement directory when the signed path identity changes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "aimd-model-workspace-"));
    const lease = await createModelSandboxLease(await realpath(workspaceRoot));
    const displaced = `${lease.path}-displaced`;
    try {
      await rename(lease.path, displaced);
      await mkdir(lease.path);
      await writeFile(join(lease.path, "keep.txt"), "replacement survives", "utf8");

      await expectSandboxError(lease.close(), "MODEL_SANDBOX_IDENTITY_CHANGED");
      await expect(readFile(join(lease.path, "keep.txt"), "utf8"))
        .resolves.toBe("replacement survives");
    } finally {
      await rm(lease.path, { recursive: true, force: true });
      await rm(displaced, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
