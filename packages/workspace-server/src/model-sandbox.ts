import {
  lstat,
  mkdtemp,
  readdir,
  realpath,
  rmdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

import {
  isCanonicalPathContained,
  sameCanonicalPath,
} from "./canonical-path.js";

export type ModelSandboxErrorCode =
  | "MODEL_SANDBOX_UNAVAILABLE"
  | "MODEL_SANDBOX_WORKSPACE_OVERLAP"
  | "MODEL_SANDBOX_IDENTITY_CHANGED"
  | "MODEL_SANDBOX_NOT_EMPTY"
  | "MODEL_SANDBOX_CLOSED"
  | "MODEL_SANDBOX_LEASE_INVALID";

export class ModelSandboxError extends Error {
  readonly code: ModelSandboxErrorCode;

  constructor(code: ModelSandboxErrorCode) {
    super(code);
    this.name = "ModelSandboxError";
    this.code = code;
  }
}

export type ModelSandboxDirectoryIdentity = Readonly<{
  device: string;
  inode: string;
}>;

export type ModelSandboxDirectoryInspection = Readonly<{
  canonicalPath: string;
  directory: boolean;
  symbolicLink: boolean;
  identity: ModelSandboxDirectoryIdentity;
}>;

/**
 * Trusted host/test seams. Production uses OS temporary-directory creation and
 * never accepts a project-selected base directory or cwd fallback.
 */
export interface ModelSandboxDependencies {
  readonly platform: NodeJS.Platform;
  createTemporaryDirectory(): Promise<string>;
  canonicalize(path: string): Promise<string>;
  inspectDirectory(path: string): Promise<ModelSandboxDirectoryInspection>;
  readDirectory(path: string): Promise<readonly string[]>;
  beforeRemove?(path: string): void | Promise<void>;
  /** Must remove only an empty directory; recursive deletion is forbidden. */
  removeEmptyDirectory(path: string): Promise<void>;
}

export interface ModelSandboxLease {
  readonly path: string;
  assertTrustedEmpty(this: ModelSandboxLease): Promise<void>;
  close(this: ModelSandboxLease): Promise<void>;
}

type LeaseLifecycle = "active" | "closing" | "closed" | "failed";

type ModelSandboxLeaseState = {
  readonly path: string;
  readonly identity: ModelSandboxDirectoryIdentity;
  readonly dependencies: ModelSandboxDependencies;
  lifecycle: LeaseLifecycle;
  failure?: ModelSandboxError;
  closePromise?: Promise<void>;
};

const MAX_PATH_CODE_UNITS = 4_096;
const ISSUED_MODEL_SANDBOX_LEASES = new WeakMap<object, ModelSandboxLeaseState>();

function fixedError(code: ModelSandboxErrorCode): ModelSandboxError {
  return new ModelSandboxError(code);
}

function pathIsAbsolute(path: string, platform: NodeJS.Platform): boolean {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > MAX_PATH_CODE_UNITS ||
    path.includes("\0")
  ) return false;
  return platform === "win32" ? win32.isAbsolute(path) : posix.isAbsolute(path);
}

function validIdentity(identity: ModelSandboxDirectoryIdentity): boolean {
  return typeof identity === "object" && identity !== null &&
    typeof identity.device === "string" && identity.device.length > 0 &&
    typeof identity.inode === "string" && identity.inode.length > 0;
}

function identitiesMatch(
  left: ModelSandboxDirectoryIdentity,
  right: ModelSandboxDirectoryIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function defaultInspectDirectory(path: string): Promise<ModelSandboxDirectoryInspection> {
  const [state, canonicalPath] = await Promise.all([
    lstat(path, { bigint: true }),
    realpath(path),
  ]);
  return {
    canonicalPath,
    directory: state.isDirectory(),
    symbolicLink: state.isSymbolicLink(),
    identity: {
      device: state.dev.toString(),
      inode: state.ino.toString(),
    },
  };
}

const DEFAULT_MODEL_SANDBOX_DEPENDENCIES: ModelSandboxDependencies = Object.freeze({
  platform: process.platform,
  createTemporaryDirectory: async () =>
    await mkdtemp(join(tmpdir(), "aimd-model-sandbox-")),
  canonicalize: realpath,
  inspectDirectory: defaultInspectDirectory,
  readDirectory: async (path: string) => await readdir(path),
  removeEmptyDirectory: async (path: string) => await rmdir(path),
});

function snapshotDependencies(
  dependencies: ModelSandboxDependencies,
): ModelSandboxDependencies {
  const snapshot: ModelSandboxDependencies = {
    platform: dependencies.platform,
    createTemporaryDirectory: dependencies.createTemporaryDirectory,
    canonicalize: dependencies.canonicalize,
    inspectDirectory: dependencies.inspectDirectory,
    readDirectory: dependencies.readDirectory,
    removeEmptyDirectory: dependencies.removeEmptyDirectory,
    ...(dependencies.beforeRemove === undefined
      ? {}
      : { beforeRemove: dependencies.beforeRemove }),
  };
  return Object.freeze(snapshot);
}

async function canonicalAbsolutePath(
  value: string,
  dependencies: ModelSandboxDependencies,
): Promise<string> {
  if (!pathIsAbsolute(value, dependencies.platform)) {
    throw fixedError("MODEL_SANDBOX_UNAVAILABLE");
  }
  try {
    const canonicalPath = await dependencies.canonicalize(value);
    if (!pathIsAbsolute(canonicalPath, dependencies.platform)) {
      throw fixedError("MODEL_SANDBOX_UNAVAILABLE");
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof ModelSandboxError) throw error;
    throw fixedError("MODEL_SANDBOX_UNAVAILABLE");
  }
}

function assertInspection(
  path: string,
  expectedIdentity: ModelSandboxDirectoryIdentity | undefined,
  inspection: ModelSandboxDirectoryInspection,
  dependencies: ModelSandboxDependencies,
  failureCode: "MODEL_SANDBOX_UNAVAILABLE" | "MODEL_SANDBOX_IDENTITY_CHANGED",
): ModelSandboxDirectoryIdentity {
  if (
    typeof inspection !== "object" ||
    inspection === null ||
    inspection.directory !== true ||
    inspection.symbolicLink !== false ||
    !pathIsAbsolute(inspection.canonicalPath, dependencies.platform) ||
    !sameCanonicalPath(path, inspection.canonicalPath, dependencies.platform) ||
    !validIdentity(inspection.identity) ||
    (expectedIdentity !== undefined && !identitiesMatch(expectedIdentity, inspection.identity))
  ) {
    throw fixedError(failureCode);
  }
  return Object.freeze({ ...inspection.identity });
}

async function inspectStableDirectory(
  path: string,
  expectedIdentity: ModelSandboxDirectoryIdentity | undefined,
  dependencies: ModelSandboxDependencies,
  failureCode: "MODEL_SANDBOX_UNAVAILABLE" | "MODEL_SANDBOX_IDENTITY_CHANGED",
): Promise<ModelSandboxDirectoryIdentity> {
  try {
    const inspection = await dependencies.inspectDirectory(path);
    return assertInspection(path, expectedIdentity, inspection, dependencies, failureCode);
  } catch (error) {
    if (error instanceof ModelSandboxError) throw error;
    throw fixedError(failureCode);
  }
}

async function assertDirectoryEmpty(
  path: string,
  identity: ModelSandboxDirectoryIdentity,
  dependencies: ModelSandboxDependencies,
  identityFailureCode: "MODEL_SANDBOX_UNAVAILABLE" | "MODEL_SANDBOX_IDENTITY_CHANGED",
): Promise<void> {
  await inspectStableDirectory(path, identity, dependencies, identityFailureCode);
  let entries: readonly string[];
  try {
    entries = await dependencies.readDirectory(path);
    if (!Array.isArray(entries)) throw fixedError(identityFailureCode);
  } catch (error) {
    if (error instanceof ModelSandboxError) throw error;
    throw fixedError(identityFailureCode);
  }
  await inspectStableDirectory(path, identity, dependencies, identityFailureCode);
  if (entries.length !== 0) throw fixedError("MODEL_SANDBOX_NOT_EMPTY");
}

async function safelyRemoveNewDirectory(
  path: string,
  identity: ModelSandboxDirectoryIdentity,
  dependencies: ModelSandboxDependencies,
): Promise<void> {
  try {
    await assertDirectoryEmpty(path, identity, dependencies, "MODEL_SANDBOX_UNAVAILABLE");
    await dependencies.beforeRemove?.(path);
    await assertDirectoryEmpty(path, identity, dependencies, "MODEL_SANDBOX_UNAVAILABLE");
    await dependencies.removeEmptyDirectory(path);
  } catch {
    // Creation already fails closed. Never broaden cleanup to an unverified or
    // non-empty target merely to avoid leaving a temporary directory behind.
  }
}

function leaseState(receiver: unknown): ModelSandboxLeaseState {
  if (typeof receiver !== "object" || receiver === null) {
    throw fixedError("MODEL_SANDBOX_LEASE_INVALID");
  }
  const state = ISSUED_MODEL_SANDBOX_LEASES.get(receiver);
  if (!state) throw fixedError("MODEL_SANDBOX_LEASE_INVALID");
  return state;
}

async function assertActiveLeaseEmpty(state: ModelSandboxLeaseState): Promise<void> {
  if (state.lifecycle === "failed" && state.failure) throw state.failure;
  if (state.lifecycle !== "active") throw fixedError("MODEL_SANDBOX_CLOSED");
  await assertDirectoryEmpty(
    state.path,
    state.identity,
    state.dependencies,
    "MODEL_SANDBOX_IDENTITY_CHANGED",
  );
}

function assertTrustedEmptyMethod(this: ModelSandboxLease): Promise<void> {
  try {
    return assertActiveLeaseEmpty(leaseState(this));
  } catch (error) {
    return Promise.reject(error);
  }
}

async function closeLease(state: ModelSandboxLeaseState): Promise<void> {
  try {
    await assertDirectoryEmpty(
      state.path,
      state.identity,
      state.dependencies,
      "MODEL_SANDBOX_IDENTITY_CHANGED",
    );
    await state.dependencies.beforeRemove?.(state.path);
    await assertDirectoryEmpty(
      state.path,
      state.identity,
      state.dependencies,
      "MODEL_SANDBOX_IDENTITY_CHANGED",
    );
    await state.dependencies.removeEmptyDirectory(state.path);
    state.lifecycle = "closed";
  } catch (error) {
    const failure = error instanceof ModelSandboxError
      ? error
      : fixedError("MODEL_SANDBOX_UNAVAILABLE");
    state.lifecycle = "failed";
    state.failure = failure;
    throw failure;
  }
}

function closeMethod(this: ModelSandboxLease): Promise<void> {
  let state: ModelSandboxLeaseState;
  try {
    state = leaseState(this);
  } catch (error) {
    return Promise.reject(error);
  }
  if (state.closePromise) return state.closePromise;
  state.lifecycle = "closing";
  state.closePromise = closeLease(state);
  return state.closePromise;
}

function issueLease(
  path: string,
  identity: ModelSandboxDirectoryIdentity,
  dependencies: ModelSandboxDependencies,
): ModelSandboxLease {
  const lease: ModelSandboxLease = Object.freeze({
    path,
    assertTrustedEmpty: assertTrustedEmptyMethod,
    close: closeMethod,
  });
  ISSUED_MODEL_SANDBOX_LEASES.set(lease, {
    path,
    identity: Object.freeze({ ...identity }),
    dependencies,
    lifecycle: "active",
  });
  return lease;
}

export function isIssuedModelSandboxLease(value: unknown): value is ModelSandboxLease {
  return typeof value === "object" && value !== null &&
    ISSUED_MODEL_SANDBOX_LEASES.has(value);
}

export async function createModelSandboxLease(
  canonicalWorkspaceRoot: string,
  suppliedDependencies: ModelSandboxDependencies = DEFAULT_MODEL_SANDBOX_DEPENDENCIES,
): Promise<ModelSandboxLease> {
  const dependencies = snapshotDependencies(suppliedDependencies);
  const workspaceRoot = await canonicalAbsolutePath(canonicalWorkspaceRoot, dependencies);

  let temporaryPath: string;
  try {
    temporaryPath = await dependencies.createTemporaryDirectory();
  } catch {
    throw fixedError("MODEL_SANDBOX_UNAVAILABLE");
  }
  if (!pathIsAbsolute(temporaryPath, dependencies.platform)) {
    throw fixedError("MODEL_SANDBOX_UNAVAILABLE");
  }

  const sandboxPath = await canonicalAbsolutePath(temporaryPath, dependencies);
  const identity = await inspectStableDirectory(
    sandboxPath,
    undefined,
    dependencies,
    "MODEL_SANDBOX_UNAVAILABLE",
  );

  if (
    isCanonicalPathContained(workspaceRoot, sandboxPath, dependencies.platform) ||
    isCanonicalPathContained(sandboxPath, workspaceRoot, dependencies.platform)
  ) {
    await safelyRemoveNewDirectory(sandboxPath, identity, dependencies);
    throw fixedError("MODEL_SANDBOX_WORKSPACE_OVERLAP");
  }

  await assertDirectoryEmpty(
    sandboxPath,
    identity,
    dependencies,
    "MODEL_SANDBOX_UNAVAILABLE",
  );
  return issueLease(sandboxPath, identity, dependencies);
}
