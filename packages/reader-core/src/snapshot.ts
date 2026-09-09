import {
  InternalWorkspaceSnapshotSchema,
  OpaqueIdSchema,
  RelativePathSchema,
  Sha256DigestSchema,
  WorkspaceSnapshotRefSchema,
  type InternalWorkspaceSnapshot,
  type WorkspaceSnapshotRef,
} from "@aimd/contracts";

import { digestCanonicalJson } from "./hash.js";

export type GitWorkspaceState =
  | { readonly kind: "clean"; readonly status?: string }
  | {
      readonly kind: "dirty";
      readonly status: string;
      /**
       * Lowercase SHA-256 of a service-owned canonical manifest covering every
       * dirty path, its current bytes (or deletion marker), and untracked file.
       * A sampled sentinel is not sufficient.
       */
      readonly contentDigest: string;
    };

export type RelevantFileHash = {
  readonly path: string;
  readonly hash: string;
};

export type WorkspaceSnapshotInput = {
  readonly projectRoot: string;
  readonly rootId: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly createdAt: string;
  readonly gitState: GitWorkspaceState;
  readonly relevantFileHashes: readonly RelevantFileHash[];
};

export type CreatedWorkspaceSnapshot = {
  readonly internalSnapshot: InternalWorkspaceSnapshot;
  readonly publicSnapshot: WorkspaceSnapshotRef;
  readonly relevantFileHashes: readonly RelevantFileHash[];
  readonly snapshotDigest: string;
};

/**
 * Internal authority passed only between trusted services. It deliberately
 * carries the canonical root required for a byte-for-byte recapture and must
 * never be serialized into an MCP/UI response.
 */
export type WorkspaceSnapshotRecapturePlan = Readonly<{
  projectRoot: string;
  rootId: string;
  relevantPaths: readonly string[];
  snapshotDigest: string;
}>;

export const TRUSTED_SNAPSHOT_REGISTRY_LIMIT = 256;

type TrustedSnapshotRegistration = {
  readonly manifestDigest: string;
  readonly fileHashes: ReadonlyMap<string, string>;
};

/**
 * A process-local issuance registry. Evidence packets are transient run
 * objects, so a digest that has expired must be recreated under a new
 * snapshot/generation before more evidence can be issued.
 */
const trustedSnapshots = new Map<string, TrustedSnapshotRegistration>();
const issuedSnapshotHandles = new WeakMap<object, WorkspaceSnapshotRecapturePlan>();

function normalizeGitText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function canonicalRelevantFileHashes(
  values: readonly RelevantFileHash[],
): readonly RelevantFileHash[] {
  const normalized = values.map((value) => ({
    path: RelativePathSchema.parse(value.path),
    hash: Sha256DigestSchema.parse(value.hash),
  }));
  normalized.sort((left, right) =>
    left.path === right.path ? 0 : left.path < right.path ? -1 : 1,
  );

  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]?.path === normalized[index]?.path) {
      throw new TypeError(`Relevant file path appears more than once: ${normalized[index]?.path}`);
    }
  }
  return normalized;
}

function dirtyStateDigest(gitState: GitWorkspaceState): string {
  const kind = (gitState as { readonly kind: unknown }).kind;
  if (kind !== "clean" && kind !== "dirty") {
    throw new TypeError("Git state kind must be clean or dirty");
  }
  if (kind === "dirty") {
    const dirtyState = gitState as Extract<GitWorkspaceState, { kind: "dirty" }>;
    const contentDigest = Sha256DigestSchema.parse(dirtyState.contentDigest);
    return digestCanonicalJson({
      version: 1,
      kind,
      status: normalizeGitText(dirtyState.status),
      contentDigest,
    });
  }

  const cleanState = gitState as Extract<GitWorkspaceState, { kind: "clean" }>;
  return digestCanonicalJson({
    version: 1,
    kind,
    status: normalizeGitText(cleanState.status ?? ""),
  });
}

export function snapshotDigest(
  snapshot: InternalWorkspaceSnapshot,
  relevantFileHashes: readonly RelevantFileHash[],
): string {
  const normalizedFiles = canonicalRelevantFileHashes(relevantFileHashes);
  const parsedSnapshot = InternalWorkspaceSnapshotSchema.parse(snapshot);

  // createdAt intentionally does not participate: observing the same workspace
  // twice must produce the same freshness key.
  return digestCanonicalJson({
    version: 1,
    root: { kind: "canonical_root", value: parsedSnapshot.projectRoot },
    branch: parsedSnapshot.branch,
    head: parsedSnapshot.head,
    dirtyStateDigest: parsedSnapshot.dirtyStateDigest,
    relevantFileHashes: normalizedFiles,
  });
}

function registerTrustedSnapshot(
  snapshot: InternalWorkspaceSnapshot,
  relevantFileHashes: readonly RelevantFileHash[],
  digest: string,
): void {
  const manifestDigest = digestCanonicalJson({
    version: 1,
    projectRoot: snapshot.projectRoot,
    branch: snapshot.branch,
    head: snapshot.head,
    dirtyStateDigest: snapshot.dirtyStateDigest,
    relevantFileHashes,
  });
  const existing = trustedSnapshots.get(digest);
  if (existing && existing.manifestDigest !== manifestDigest) {
    throw new TypeError("Trusted snapshot digest conflicts with an existing manifest");
  }

  const registration = existing ?? {
    manifestDigest,
    fileHashes: new Map(relevantFileHashes.map(({ path, hash }) => [path, hash])),
  };
  // Refresh insertion order so eviction is deterministic least-recently-used.
  trustedSnapshots.delete(digest);
  trustedSnapshots.set(digest, registration);
  while (trustedSnapshots.size > TRUSTED_SNAPSHOT_REGISTRY_LIMIT) {
    const oldest = trustedSnapshots.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    trustedSnapshots.delete(oldest);
  }
}

/**
 * Trusted snapshot-issuer check. Messages are deliberately fixed and do not
 * echo paths or workspace data.
 */
function requireTrustedSnapshot(
  rawSnapshotDigest: string,
): { readonly digest: string; readonly registration: TrustedSnapshotRegistration } {
  const digest = Sha256DigestSchema.parse(rawSnapshotDigest);
  const registration = trustedSnapshots.get(digest);
  if (!registration) {
    throw new TypeError("Trusted snapshot is not registered or has expired");
  }
  return { digest, registration };
}

function touchTrustedSnapshot(
  digest: string,
  registration: TrustedSnapshotRegistration,
): void {
  trustedSnapshots.delete(digest);
  trustedSnapshots.set(digest, registration);
}

export function assertSnapshotRegistration(rawSnapshotDigest: string): void {
  const { digest, registration } = requireTrustedSnapshot(rawSnapshotDigest);
  touchTrustedSnapshot(digest, registration);
}

export function assertSnapshotEvidenceBinding(
  rawSnapshotDigest: string,
  rawPath: string,
  rawFileHash: string,
): void {
  const { digest, registration } = requireTrustedSnapshot(rawSnapshotDigest);
  const path = RelativePathSchema.parse(rawPath);
  const fileHash = Sha256DigestSchema.parse(rawFileHash);
  if (registration.fileHashes.get(path) !== fileHash) {
    throw new TypeError("Evidence path or file hash is not bound to the trusted snapshot");
  }
  touchTrustedSnapshot(digest, registration);
}

export function createWorkspaceSnapshot(
  input: WorkspaceSnapshotInput,
): CreatedWorkspaceSnapshot {
  OpaqueIdSchema.parse(input.rootId);
  const relevantFileHashes = canonicalRelevantFileHashes(input.relevantFileHashes);
  const state = {
    branch: input.branch,
    head: input.head,
    dirtyStateDigest: dirtyStateDigest(input.gitState),
    createdAt: input.createdAt,
  };
  const internalSnapshot = InternalWorkspaceSnapshotSchema.parse({
    projectRoot: input.projectRoot,
    ...state,
  });
  const publicSnapshot = WorkspaceSnapshotRefSchema.parse({
    rootId: input.rootId,
    ...state,
  });

  const digest = snapshotDigest(internalSnapshot, relevantFileHashes);
  registerTrustedSnapshot(internalSnapshot, relevantFileHashes, digest);

  const frozenRelevantFileHashes = Object.freeze(
    relevantFileHashes.map((entry) => Object.freeze({ ...entry })),
  );
  const created = Object.freeze({
    internalSnapshot: Object.freeze({ ...internalSnapshot }),
    publicSnapshot: Object.freeze({ ...publicSnapshot }),
    relevantFileHashes: frozenRelevantFileHashes,
    snapshotDigest: digest,
  });
  const plan = Object.freeze({
    projectRoot: internalSnapshot.projectRoot,
    rootId: publicSnapshot.rootId,
    relevantPaths: Object.freeze(frozenRelevantFileHashes.map(({ path }) => path)),
    snapshotDigest: digest,
  });
  issuedSnapshotHandles.set(created, plan);
  return created;
}

/**
 * Accepts only the exact live object issued by createWorkspaceSnapshot. The
 * WeakMap lookup occurs before reading any caller-controlled property, so
 * copied/accessor/proxy-shaped objects cannot run code or mint authority.
 */
export function authenticateWorkspaceSnapshotForRecapture(
  rawSnapshot: unknown,
): WorkspaceSnapshotRecapturePlan {
  if (typeof rawSnapshot !== "object" || rawSnapshot === null) {
    throw new TypeError("Workspace snapshot recapture authority is missing");
  }
  const plan = issuedSnapshotHandles.get(rawSnapshot);
  if (!plan) {
    throw new TypeError("Workspace snapshot recapture authority is missing");
  }
  return plan;
}
