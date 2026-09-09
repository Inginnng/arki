import {
  InternalWorkspaceSnapshotSchema,
  WorkspaceSnapshotRefSchema,
} from "@aimd/contracts";
import { describe, expect, it } from "vitest";

import { sha256Text } from "./hash.js";
import {
  TRUSTED_SNAPSHOT_REGISTRY_LIMIT,
  authenticateWorkspaceSnapshotForRecapture,
  assertSnapshotEvidenceBinding,
  createWorkspaceSnapshot,
  snapshotDigest,
} from "./snapshot.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const DIRTY_A = sha256Text("complete dirty content manifest a");
const DIRTY_B = sha256Text("complete dirty content manifest b");
const CREATED_AT = "2026-09-02T00:00:00.000Z";

function dirtyInput(overrides: Record<string, unknown> = {}) {
  return {
    projectRoot: "D:/Project/fixture",
    rootId: "root-fixture",
    branch: "main",
    head: "1".repeat(40),
    createdAt: CREATED_AT,
    gitState: {
      kind: "dirty" as const,
      status: " M src/architecture.ts",
      contentDigest: DIRTY_A,
    },
    relevantFileHashes: [{ path: "src/architecture.ts", hash: HASH_A }],
    ...overrides,
  };
}

describe("workspace snapshots", () => {
  it("returns contracts-compatible internal and public snapshots", () => {
    const result = createWorkspaceSnapshot(dirtyInput());

    expect(InternalWorkspaceSnapshotSchema.parse(result.internalSnapshot)).toEqual(
      result.internalSnapshot,
    );
    expect(WorkspaceSnapshotRefSchema.parse(result.publicSnapshot)).toEqual(
      result.publicSnapshot,
    );
    expect(result.publicSnapshot).not.toHaveProperty("projectRoot");
    expect(result.internalSnapshot).not.toHaveProperty("rootId");
  });

  it("changes the snapshot and dirty-state digests when dirty content changes", () => {
    const before = createWorkspaceSnapshot(dirtyInput());
    const after = createWorkspaceSnapshot(
      dirtyInput({
        gitState: {
          kind: "dirty",
          status: " M src/architecture.ts",
          contentDigest: DIRTY_B,
        },
      }),
    );

    expect(after.internalSnapshot.dirtyStateDigest).not.toBe(
      before.internalSnapshot.dirtyStateDigest,
    );
    expect(after.snapshotDigest).not.toBe(before.snapshotDigest);
  });

  it("binds relevant file hashes into the snapshot digest", () => {
    const before = createWorkspaceSnapshot(dirtyInput());
    const after = createWorkspaceSnapshot(
      dirtyInput({
        relevantFileHashes: [{ path: "src/architecture.ts", hash: HASH_B }],
      }),
    );

    expect(after.snapshotDigest).not.toBe(before.snapshotDigest);
  });

  it("binds branch and HEAD while remaining deterministic across file order and observation time", () => {
    const files = [
      { path: "src/a.ts", hash: HASH_A },
      { path: "src/b.ts", hash: HASH_B },
    ];
    const baseline = createWorkspaceSnapshot(
      dirtyInput({ relevantFileHashes: files }),
    );
    const reordered = createWorkspaceSnapshot(
      dirtyInput({ relevantFileHashes: [...files].reverse() }),
    );
    const otherBranch = createWorkspaceSnapshot(
      dirtyInput({ branch: "feature", relevantFileHashes: files }),
    );
    const otherHead = createWorkspaceSnapshot(
      dirtyInput({ head: "2".repeat(40), relevantFileHashes: files }),
    );
    const observedLater = createWorkspaceSnapshot(
      dirtyInput({
        createdAt: "2026-09-02T00:05:00.000Z",
        relevantFileHashes: files,
      }),
    );

    expect(reordered.snapshotDigest).toBe(baseline.snapshotDigest);
    expect(observedLater.snapshotDigest).toBe(baseline.snapshotDigest);
    expect(otherBranch.snapshotDigest).not.toBe(baseline.snapshotDigest);
    expect(otherHead.snapshotDigest).not.toBe(baseline.snapshotDigest);
  });

  it("generates the authoritative digest only from the canonical internal root", () => {
    const built = createWorkspaceSnapshot(dirtyInput());

    expect(
      snapshotDigest(built.internalSnapshot, built.relevantFileHashes),
    ).not.toBe(
      snapshotDigest(
        { ...built.internalSnapshot, projectRoot: "D:/Project/other" },
        built.relevantFileHashes,
      ),
    );
    expect(() =>
      snapshotDigest(
        built.publicSnapshot as unknown as Parameters<typeof snapshotDigest>[0],
        built.relevantFileHashes,
      ),
    ).toThrow(/internal|canonical|projectRoot/i);
  });

  it("requires a lowercase SHA-256 digest of the complete dirty content manifest", () => {
    expect(() =>
      createWorkspaceSnapshot(
        dirtyInput({
          gitState: { kind: "dirty", status: " M src/architecture.ts", contentDigest: "sentinel" },
        }),
      ),
    ).toThrow(/content.*digest|sha-256/i);
    expect(() =>
      createWorkspaceSnapshot(
        dirtyInput({
          gitState: {
            kind: "sampled",
            status: " M src/architecture.ts",
            contentDigest: DIRTY_A,
          },
        }),
      ),
    ).toThrow(/git state.*kind|clean.*dirty/i);
  });

  it("registers exact snapshot path/hash bindings for evidence issuance", () => {
    const built = createWorkspaceSnapshot(dirtyInput());

    expect(() =>
      assertSnapshotEvidenceBinding(
        built.snapshotDigest,
        "src/architecture.ts",
        HASH_A,
      ),
    ).not.toThrow();
    expect(() =>
      assertSnapshotEvidenceBinding(
        built.snapshotDigest,
        "src/architecture.ts",
        HASH_B,
      ),
    ).toThrow(/file hash|snapshot/i);
    expect(() =>
      assertSnapshotEvidenceBinding(
        built.snapshotDigest,
        "src/missing.ts",
        HASH_A,
      ),
    ).toThrow(/not.*snapshot|snapshot.*path/i);
  });

  it("issues a frozen process-local recapture plan for the exact live snapshot", () => {
    const built = createWorkspaceSnapshot(dirtyInput({
      relevantFileHashes: [
        { path: "src/z.ts", hash: HASH_B },
        { path: "src/a.ts", hash: HASH_A },
      ],
    }));

    expect(authenticateWorkspaceSnapshotForRecapture(built)).toEqual({
      projectRoot: "D:/Project/fixture",
      rootId: "root-fixture",
      relevantPaths: ["src/a.ts", "src/z.ts"],
      snapshotDigest: built.snapshotDigest,
    });
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.internalSnapshot)).toBe(true);
    expect(Object.isFrozen(built.publicSnapshot)).toBe(true);
    expect(Object.isFrozen(built.relevantFileHashes)).toBe(true);
    expect(Object.isFrozen(built.relevantFileHashes[0])).toBe(true);
  });

  it("rejects copied, inherited, and accessor-shaped snapshot handles without invoking getters", () => {
    const built = createWorkspaceSnapshot(dirtyInput());
    const copied = JSON.parse(JSON.stringify(built));
    const inherited = Object.create(built) as unknown;
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "snapshotDigest", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return built.snapshotDigest;
      },
    });

    expect(() => authenticateWorkspaceSnapshotForRecapture(copied)).toThrow(/authority/i);
    expect(() => authenticateWorkspaceSnapshotForRecapture(inherited)).toThrow(/authority/i);
    expect(() => authenticateWorkspaceSnapshotForRecapture(accessor)).toThrow(/authority/i);
    expect(getterCalls).toBe(0);
  });

  it("bounds the trusted snapshot registry with deterministic LRU eviction", () => {
    const snapshots = Array.from(
      { length: TRUSTED_SNAPSHOT_REGISTRY_LIMIT + 1 },
      (_, index) =>
        createWorkspaceSnapshot(
          dirtyInput({
            projectRoot: `D:/Project/fixture-${index}`,
            rootId: `root-fixture-${index}`,
            gitState: {
              kind: "dirty",
              status: " M src/architecture.ts",
              contentDigest: sha256Text(`dirty-${index}`),
            },
          }),
        ),
    );

    expect(() =>
      assertSnapshotEvidenceBinding(
        snapshots[0]!.snapshotDigest,
        "src/architecture.ts",
        HASH_A,
      ),
    ).toThrow(/not registered|expired/i);
    expect(() =>
      assertSnapshotEvidenceBinding(
        snapshots.at(-1)!.snapshotDigest,
        "src/architecture.ts",
        HASH_A,
      ),
    ).not.toThrow();
  });
});
