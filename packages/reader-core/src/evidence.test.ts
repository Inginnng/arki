import type {
  EvidenceSupportReview,
  ModelAnswerCandidate,
} from "@aimd/contracts";
import { describe, expect, it } from "vitest";

import {
  authenticateValidatedEvidenceAnswerForAudit,
  issueEvidencePacket,
  serializeIssuedEvidenceForModel,
  validateEvidenceQuestionOutput,
  validateEvidence,
  validateEvidenceSupportAudit,
  type EvidenceIdFactory,
  type EvidencePacket,
} from "./evidence.js";
import { digestCanonicalJson, sha256Text } from "./hash.js";
import { createWorkspaceSnapshot } from "./snapshot.js";

const RUN_ID = "run-1";
const GENERATION = "generation-1";
const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "src/gateway.ts": "export const gateway = 'dirty sentinel';\nexport const next = worker;\n",
  "tests/gateway.test.ts": "it('routes to worker', () => expect(route()).toBe('worker'));\n",
  "src/expanded-gateway.ts": "export const gateway = worker;\n",
  "src/worker.ts": "export const worker = 'ready';\n",
  "src/real.ts": "export const real = 1;\n",
  "src/alias.ts": "export const real = 1;\n",
  "src/other.ts": "export const other = 2;\n",
  "src/same-real.ts": "export const value = 1;\n",
  "src/same-alias.ts": "export const value = 1;\n",
  ...Object.fromEntries(
    Array.from(
      { length: 4 },
      (_, index) => [`src/${index}.ts`, `export const value${index} = ${index};\n`],
    ),
  ),
};

function trustedSnapshot(contentLabel: string): string {
  return createWorkspaceSnapshot({
    projectRoot: "D:/Project/evidence-fixture",
    rootId: "root-evidence-fixture",
    branch: "main",
    head: "1".repeat(40),
    createdAt: "2026-09-02T00:00:00.000Z",
    gitState: {
      kind: "dirty",
      status: " M src/gateway.ts",
      contentDigest: sha256Text(contentLabel),
    },
    relevantFileHashes: Object.entries(FIXTURE_FILES).map(([path, content]) => ({
      path,
      hash: sha256Text(content),
    })),
  }).snapshotDigest;
}

const SNAPSHOT = trustedSnapshot("evidence fixture dirty state");
const OTHER_SNAPSHOT = trustedSnapshot("changed evidence fixture dirty state");

const deterministicIds: EvidenceIdFactory = (scope, index) =>
  scope === "packet" ? "packet-1" : `evidence-${index + 1}`;

function issueTwoFiles(): EvidencePacket {
  return issueEvidencePacket(
    {
      runId: RUN_ID,
      generation: GENERATION,
      snapshotDigest: SNAPSHOT,
      sources: [
        {
          kind: "code_excerpt",
          path: "src\\gateway.ts",
          excerpt: "export const gateway = 'dirty sentinel';",
          fileHash: sha256Text("export const gateway = 'dirty sentinel';\nexport const next = worker;\n"),
          sourceLocationKey: "location-gateway",
          startLine: 1,
          endLine: 1,
        },
        {
          kind: "test_excerpt",
          path: "tests/gateway.test.ts",
          excerpt: "it('routes to worker', () => expect(route()).toBe('worker'));",
          fileHash: sha256Text("it('routes to worker', () => expect(route()).toBe('worker'));\n"),
          sourceLocationKey: "location-gateway-test",
          startLine: 1,
          endLine: 1,
        },
      ],
    },
    { idFactory: deterministicIds },
  );
}

function issueOneFile(
  path: string,
  sourceLocationKey: string,
  packetId: string,
  evidenceId: string,
  text: string,
  snapshotDigest = SNAPSHOT,
): EvidencePacket {
  return issueEvidencePacket(
    {
      runId: RUN_ID,
      generation: GENERATION,
      snapshotDigest,
      sources: [
        {
          kind: "code_excerpt",
          path,
          excerpt: text,
          fileHash: sha256Text(`${text}\n`),
          sourceLocationKey,
          startLine: 1,
          endLine: 1,
        },
      ],
    },
    {
      idFactory: (scope) => scope === "packet" ? packetId : evidenceId,
    },
  );
}

function architectureCandidate(
  evidenceIds: string[] = ["evidence-1", "evidence-2"],
): ModelAnswerCandidate {
  return {
    conclusionClaimId: "claim-1",
    claims: [
      {
        id: "claim-1",
        statement: "The gateway routes work to the worker.",
        category: "architecture",
        evidenceIds,
      },
    ],
    unknowns: [],
  };
}

function files(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    "src/gateway.ts": "export const gateway = 'dirty sentinel';\nexport const next = worker;\n",
    "tests/gateway.test.ts": "it('routes to worker', () => expect(route()).toBe('worker'));\n",
    ...overrides,
  };
  return async (path: string, startLine: number, endLine: number) => {
    const value = values[path];
    if (value === undefined) throw new Error(`missing fixture: ${path}`);
    const lines = value.split(/\r\n|\n|\r/);
    if (/\r\n$|[\n\r]$/.test(value)) lines.pop();
    return {
      excerpt: lines.slice(startLine - 1, endLine).join("\n"),
      fileHash: sha256Text(value),
    };
  };
}

function matchingAudit(answer: Awaited<ReturnType<typeof validateEvidence>>): EvidenceSupportReview {
  return {
    id: "audit-1",
    reviewer: "independent_model",
    modelAssisted: true,
    runId: answer.runId,
    generation: answer.generation,
    candidateDigest: answer.candidateDigest,
    snapshotDigest: answer.snapshotDigest,
    records: [
      {
        id: "audit-record-1",
        claimId: "claim-1",
        evidenceIds: ["evidence-1", "evidence-2"],
        verdict: "directly_supported",
        rationale: "Both excerpts directly describe the route.",
      },
    ],
  };
}

describe("server-issued evidence", () => {
  it("serializes only live workspace-issued packets for the exact run and snapshot", () => {
    const packet = issueTwoFiles();

    expect(
      serializeIssuedEvidenceForModel({
        packets: [packet],
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        expectedSnapshotDigest: SNAPSHOT,
      }),
    ).toEqual({
      version: 1,
      runId: RUN_ID,
      generation: GENERATION,
      snapshotDigest: SNAPSHOT,
      packetIds: ["packet-1"],
      evidence: packet.evidence,
    });
  });

  it("rejects copied, cross-run, and cross-snapshot packets before model serialization", () => {
    const packet = issueTwoFiles();
    const copied = JSON.parse(JSON.stringify(packet)) as EvidencePacket;

    expect(() =>
      serializeIssuedEvidenceForModel({
        packets: [copied],
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        expectedSnapshotDigest: SNAPSHOT,
      }),
    ).toThrow(/issued/i);
    expect(() =>
      serializeIssuedEvidenceForModel({
        packets: [packet],
        expectedRunId: "run-other",
        expectedGeneration: GENERATION,
        expectedSnapshotDigest: SNAPSHOT,
      }),
    ).toThrow(/run/i);
    expect(() =>
      serializeIssuedEvidenceForModel({
        packets: [packet],
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        expectedSnapshotDigest: OTHER_SNAPSHOT,
      }),
    ).toThrow(/snapshot/i);
  });

  it.each(["packet", "packets"] as const)(
    "rejects an accessor-shaped %s selection without invoking its getter",
    (property) => {
      const packet = issueTwoFiles();
      let getterCalls = 0;
      const selection = {
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        expectedSnapshotDigest: SNAPSHOT,
      } as Record<string, unknown>;
      Object.defineProperty(selection, property, {
        enumerable: true,
        get() {
          getterCalls += 1;
          return property === "packet" ? packet : [packet];
        },
      });

      expect(() => serializeIssuedEvidenceForModel(selection as never)).toThrow(/packet.*input|data property/i);
      expect(getterCalls).toBe(0);
    },
  );

  it("issues canonical hash-bound excerpts with run, generation, and packet provenance", () => {
    const packet = issueTwoFiles();
    expect(issueTwoFiles()).toEqual(packet);

    expect(packet.evidence[0]).toMatchObject({
      id: "evidence-1",
      path: "src/gateway.ts",
      startLine: 1,
      endLine: 1,
      excerpt: "export const gateway = 'dirty sentinel';",
      snapshotDigest: SNAPSHOT,
      provenance: {
        issuer: "workspace_service",
        packetId: "packet-1",
        runId: RUN_ID,
        generation: GENERATION,
      },
    });
    expect(packet.evidence[0]?.excerptHash).toBe(
      sha256Text("export const gateway = 'dirty sentinel';"),
    );
    expect(packet.evidence[0]?.fileHash).toBe(
      sha256Text("export const gateway = 'dirty sentinel';\nexport const next = worker;\n"),
    );
  });

  it("rejects malformed or excerpt-inconsistent 1-based ranges", () => {
    const base = {
      runId: RUN_ID,
      generation: GENERATION,
      snapshotDigest: SNAPSHOT,
      sources: [
        {
          kind: "code_excerpt" as const,
          path: "src/a.ts",
          excerpt: "one\ntwo",
          fileHash: sha256Text("one\ntwo\n"),
          sourceLocationKey: "location-a",
          startLine: 1,
          endLine: 3,
        },
      ],
    };

    expect(() => issueEvidencePacket(base, { idFactory: deterministicIds })).toThrow(/line count/i);
    const source = base.sources[0]!;
    expect(() =>
      issueEvidencePacket(
        {
          ...base,
          sources: [{ ...source, startLine: 2, endLine: 1 }],
        },
        { idFactory: deterministicIds },
      ),
    ).toThrow(/range/i);
  });

  it("rejects absolute, traversal, ADS, and control-character evidence paths", () => {
    const source = {
      kind: "code_excerpt" as const,
      excerpt: "one",
      fileHash: sha256Text("one\n"),
      sourceLocationKey: "location-a",
      startLine: 1,
      endLine: 1,
    };
    for (const path of ["D:/outside.ts", "../outside.ts", "/outside.ts", "src/a.ts:secret", "src/a\n.ts"]) {
      expect(() =>
        issueEvidencePacket(
          {
            runId: RUN_ID,
            generation: GENERATION,
            snapshotDigest: SNAPSHOT,
            sources: [{ ...source, path }],
          },
          { idFactory: deterministicIds },
        ),
      ).toThrow(/relative|traversal/i);
    }
  });

  it("validates two distinct citations but does not claim semantic entailment", async () => {
    const answer = await validateEvidence({
      candidate: architectureCandidate(),
      packet: issueTwoFiles(),
      expectedRunId: RUN_ID,
      expectedGeneration: GENERATION,
      currentSnapshotDigest: SNAPSHOT,
      contextMode: "project_only",
      readEvidence: files(),
    });

    expect(answer.reviewStatus).toBe("citation_validated");
    expect(answer.evidence.map((item) => "path" in item ? item.path : null)).toEqual([
      "src/gateway.ts",
      "tests/gateway.test.ts",
    ]);
    expect(answer.supportReview).toBeUndefined();
  });

  it("rejects an unissued evidence id", async () => {
    await expect(
      validateEvidence({
        candidate: architectureCandidate(["evidence-1", "unissued-id"]),
        packet: issueTwoFiles(),
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: SNAPSHOT,
        contextMode: "project_only",
        readEvidence: files(),
      }),
    ).rejects.toThrow(/not issued/i);
  });

  it("validates same-run evidence expansion packets as one issued evidence set", async () => {
    const gateway = issueOneFile(
      "src/expanded-gateway.ts",
      "physical-gateway",
      "packet-gateway",
      "evidence-gateway",
      "export const gateway = worker;",
    );
    const worker = issueOneFile(
      "src/worker.ts",
      "physical-worker",
      "packet-worker",
      "evidence-worker",
      "export const worker = 'ready';",
    );

    const answer = await validateEvidence({
      candidate: architectureCandidate(["evidence-gateway", "evidence-worker"]),
      packets: [gateway, worker],
      expectedRunId: RUN_ID,
      expectedGeneration: GENERATION,
      currentSnapshotDigest: SNAPSHOT,
      contextMode: "project_only",
      readEvidence: files({
        "src/expanded-gateway.ts": "export const gateway = worker;\n",
        "src/worker.ts": "export const worker = 'ready';\n",
      }),
    });

    expect(answer.reviewStatus).toBe("citation_validated");
    expect(answer.evidence.map((item) => "path" in item ? item.path : null)).toEqual([
      "src/expanded-gateway.ts",
      "src/worker.ts",
    ]);
  });

  it("requires exactly one packet input and one snapshot across the expansion chain", async () => {
    const first = issueOneFile(
      "src/real.ts",
      "physical-real",
      "packet-input-a",
      "evidence-input-a",
      "export const real = 1;",
    );
    const changedSnapshot = issueOneFile(
      "src/other.ts",
      "physical-other",
      "packet-input-b",
      "evidence-input-b",
      "export const other = 2;",
      OTHER_SNAPSHOT,
    );
    const base = {
      candidate: architectureCandidate(["evidence-input-a", "evidence-input-b"]),
      expectedRunId: RUN_ID,
      expectedGeneration: GENERATION,
      currentSnapshotDigest: SNAPSHOT,
      contextMode: "project_only" as const,
      readEvidence: files(),
    };

    await expect(
      validateEvidence({ ...base, packets: [first, changedSnapshot] }),
    ).rejects.toThrow(/share one snapshot/i);
    await expect(
      validateEvidence({
        ...base,
        packet: first,
        packets: [first],
      } as unknown as Parameters<typeof validateEvidence>[0]),
    ).rejects.toThrow(/exactly one/i);
    await expect(
      validateEvidence(base as unknown as Parameters<typeof validateEvidence>[0]),
    ).rejects.toThrow(/exactly one/i);
    for (const packet of [undefined, null]) {
      await expect(
        validateEvidence({
          ...base,
          packet,
        } as unknown as Parameters<typeof validateEvidence>[0]),
      ).rejects.toThrow(/evidence packet input is invalid/i);
    }
  });

  it("rejects cross-packet ids and physical aliases before they can satisfy multi-file rules", async () => {
    const first = issueOneFile(
      "src/real.ts",
      "same-physical-file",
      "packet-1",
      "evidence-real",
      "export const real = 1;",
    );
    const alias = issueOneFile(
      "src/alias.ts",
      "same-physical-file",
      "packet-2",
      "evidence-alias",
      "export const real = 1;",
    );
    await expect(
      validateEvidence({
        candidate: architectureCandidate(["evidence-real", "evidence-alias"]),
        packets: [first, alias],
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: SNAPSHOT,
        contextMode: "project_only",
        readEvidence: files({
          "src/real.ts": "export const real = 1;\n",
          "src/alias.ts": "export const real = 1;\n",
        }),
      }),
    ).rejects.toThrow(/physical.*alias|alias.*physical/i);

    const duplicateId = issueOneFile(
      "src/other.ts",
      "physical-other",
      "packet-3",
      "evidence-real",
      "export const other = 2;",
    );
    await expect(
      validateEvidence({
        candidate: architectureCandidate(["evidence-real"]),
        packets: [first, duplicateId],
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: SNAPSHOT,
        contextMode: "project_only",
        readEvidence: files(),
      }),
    ).rejects.toThrow(/evidence ids.*unique|duplicate evidence/i);
  });

  it("caps one initial packet plus two expansion packets", async () => {
    const packets = Array.from({ length: 4 }, (_, index) =>
      issueOneFile(
        `src/${index}.ts`,
        `physical-${index}`,
        `packet-${index}`,
        `evidence-${index}`,
        `export const value${index} = ${index};`,
      ),
    );
    await expect(
      validateEvidence({
        candidate: architectureCandidate(["evidence-0", "evidence-1"]),
        packets,
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: SNAPSHOT,
        contextMode: "project_only",
        readEvidence: files(),
      }),
    ).rejects.toThrow(/expansion|packet limit/i);
  });

  it("applies source-count limits across the entire expansion chain", async () => {
    const issueMany = (packetId: string, prefix: string): EvidencePacket =>
      issueEvidencePacket(
        {
          runId: RUN_ID,
          generation: GENERATION,
          snapshotDigest: SNAPSHOT,
          sources: Array.from({ length: 33 }, () => ({
            kind: "code_excerpt" as const,
            path: "src/gateway.ts",
            excerpt: "export const gateway = 'dirty sentinel';",
            fileHash: sha256Text(FIXTURE_FILES["src/gateway.ts"]!),
            sourceLocationKey: "location-gateway",
            startLine: 1,
            endLine: 1,
          })),
        },
        {
          idFactory: (scope, index) =>
            scope === "packet" ? packetId : `${prefix}-${index}`,
        },
      );
    const first = issueMany("packet-many-a", "many-a");
    const second = issueMany("packet-many-b", "many-b");

    await expect(
      validateEvidence({
        candidate: architectureCandidate(["many-a-0", "many-b-0"]),
        packets: [first, second],
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: SNAPSHOT,
        contextMode: "project_only",
        readEvidence: files(),
      }),
    ).rejects.toThrow(/aggregate|chain|source count/i);
  });

  it("applies UTF-8 byte limits across the entire expansion chain", async () => {
    const excerpt = "x".repeat(16_000);
    const content = `${excerpt}\n`;
    const snapshotDigest = createWorkspaceSnapshot({
      projectRoot: "D:/Project/evidence-byte-fixture",
      rootId: "root-evidence-byte-fixture",
      branch: "main",
      head: "1".repeat(40),
      createdAt: "2026-09-02T00:00:00.000Z",
      gitState: {
        kind: "dirty",
        status: " M src/large.ts",
        contentDigest: sha256Text("large evidence fixture"),
      },
      relevantFileHashes: [{ path: "src/large.ts", hash: sha256Text(content) }],
    }).snapshotDigest;
    const issueLarge = (packetId: string, prefix: string): EvidencePacket =>
      issueEvidencePacket(
        {
          runId: RUN_ID,
          generation: GENERATION,
          snapshotDigest,
          sources: Array.from({ length: 17 }, () => ({
            kind: "code_excerpt" as const,
            path: "src/large.ts",
            excerpt,
            fileHash: sha256Text(content),
            sourceLocationKey: "physical-large",
            startLine: 1,
            endLine: 1,
          })),
        },
        {
          idFactory: (scope, index) =>
            scope === "packet" ? packetId : `${prefix}-${index}`,
        },
      );

    await expect(
      validateEvidence({
        candidate: architectureCandidate(["large-a-0", "large-b-0"]),
        packets: [
          issueLarge("packet-large-a", "large-a"),
          issueLarge("packet-large-b", "large-b"),
        ],
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: snapshotDigest,
        contextMode: "project_only",
        readEvidence: files(),
      }),
    ).rejects.toThrow(/bytes.*aggregate|aggregate.*bytes/i);
  });

  it("rejects a structurally resealed packet because it was not issued by this broker", async () => {
    const original = issueTwoFiles();
    const forgedText = "export const forged = worker;";
    const forgedEvidence = {
      ...original.evidence[0]!,
      path: "src/forged.ts",
      excerpt: forgedText,
      excerptHash: sha256Text(forgedText),
      fileHash: sha256Text(`${forgedText}\n`),
    };
    const evidence = [forgedEvidence, ...original.evidence.slice(1)] as EvidencePacket["evidence"];
    const forgedPacket = {
      ...original,
      evidence,
      integrityDigest: digestCanonicalJson({
        version: 1,
        packetId: original.packetId,
        runId: original.runId,
        generation: original.generation,
        snapshotDigest: original.snapshotDigest,
        evidence,
      }),
    };

    await expect(
      validateEvidence({
        candidate: architectureCandidate(),
        packet: forgedPacket,
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: SNAPSHOT,
        contextMode: "project_only",
        readEvidence: files({ "src/forged.ts": `${forgedText}\n` }),
      }),
    ).rejects.toThrow(/not issued.*broker|trusted broker/i);
  });

  it("rejects model-minted raw citation coordinates before reading the workspace", async () => {
    let reads = 0;
    const candidate = architectureCandidate() as ModelAnswerCandidate & {
      claims: Array<ModelAnswerCandidate["claims"][number] & { path?: string; startLine?: number }>;
    };
    candidate.claims[0] = {
      ...candidate.claims[0]!,
      path: "src/gateway.ts",
      startLine: 1,
    };

    await expect(
      validateEvidence({
        candidate,
        packet: issueTwoFiles(),
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: SNAPSHOT,
        contextMode: "project_only",
        readEvidence: async (...args) => {
          reads += 1;
          return files()(...args);
        },
      }),
    ).rejects.toThrow();
    expect(reads).toBe(0);
  });

  it("rejects evidence issued for a different run", async () => {
    await expect(
      validateEvidence({
        candidate: architectureCandidate(),
        packet: issueTwoFiles(),
        expectedRunId: "run-2",
        expectedGeneration: GENERATION,
        currentSnapshotDigest: SNAPSHOT,
        contextMode: "project_only",
        readEvidence: files(),
      }),
    ).rejects.toThrow(/run/i);
  });

  it("rejects evidence issued for a different generation", async () => {
    await expect(
      validateEvidence({
        candidate: architectureCandidate(),
        packet: issueTwoFiles(),
        expectedRunId: RUN_ID,
        expectedGeneration: "generation-2",
        currentSnapshotDigest: SNAPSHOT,
        contextMode: "project_only",
        readEvidence: files(),
      }),
    ).rejects.toThrow(/generation/i);
  });

  it("keeps run and generation identifiers in distinct opaque roles", () => {
    expect(() =>
      issueEvidencePacket({
        runId: "same-role-id",
        generation: "same-role-id",
        snapshotDigest: SNAPSHOT,
        sources: [],
      }),
    ).toThrow(/run.*generation.*distinct|distinct.*run.*generation/i);
  });

  it("rejects unknown evidence not cited by its named claims before workspace reads", async () => {
    let reads = 0;
    const candidate: ModelAnswerCandidate = {
      ...architectureCandidate(["evidence-1"]),
      unknowns: [
        {
          id: "unknown-1",
          code: "missing_evidence",
          statement: "The second excerpt is not evidence for the named claim.",
          claimIds: ["claim-1"],
          evidenceIds: ["evidence-2"],
        },
      ],
    };

    await expect(
      validateEvidence({
        candidate,
        packet: issueTwoFiles(),
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: SNAPSHOT,
        contextMode: "project_only",
        readEvidence: async (...args) => {
          reads += 1;
          return files()(...args);
        },
      }),
    ).rejects.toThrow(/unknown evidence.*cited|named claims/i);
    expect(reads).toBe(0);
  });

  it("marks evidence stale when the current snapshot changed", async () => {
    const answer = await validateEvidence({
      candidate: architectureCandidate(),
      packet: issueTwoFiles(),
      expectedRunId: RUN_ID,
      expectedGeneration: GENERATION,
      currentSnapshotDigest: OTHER_SNAPSHOT,
      contextMode: "project_only",
      readEvidence: files(),
      idFactory: () => "stale-unknown-1",
    });

    expect(answer.reviewStatus).toBe("stale");
    expect(answer.unknowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "stale_snapshot", evidenceIds: ["evidence-1", "evidence-2"] }),
      ]),
    );
  });

  it("fails closed instead of hiding a candidate conflict when evidence becomes stale", async () => {
    const candidate: ModelAnswerCandidate = {
      ...architectureCandidate(),
      unknowns: [
        {
          id: "unknown-conflict",
          code: "evidence_conflict",
          statement: "The issued sources disagree.",
          claimIds: ["claim-1"],
          evidenceIds: ["evidence-1", "evidence-2"],
        },
      ],
    };

    await expect(
      validateEvidence({
        candidate,
        packet: issueTwoFiles(),
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: OTHER_SNAPSHOT,
        contextMode: "project_only",
        readEvidence: files(),
        idFactory: () => "server-stale-1",
      }),
    ).rejects.toThrow(/candidate uncertainty.*stale|stale.*candidate uncertainty/i);
  });

  it("replaces model-reported stale state with the server-authoritative stale record", async () => {
    const candidate: ModelAnswerCandidate = {
      ...architectureCandidate(),
      unknowns: [
        {
          id: "model-stale",
          code: "stale_snapshot",
          statement: "The model guessed that the snapshot was stale.",
          claimIds: ["claim-1"],
          evidenceIds: ["evidence-1"],
        },
      ],
    };

    await expect(
      validateEvidence({
        candidate,
        packet: issueTwoFiles(),
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: OTHER_SNAPSHOT,
        contextMode: "project_only",
        readEvidence: files(),
        idFactory: () => "server-stale-1",
      }),
    ).resolves.toMatchObject({
      reviewStatus: "stale",
      unknowns: [
        {
          id: "server-stale-1",
          code: "stale_snapshot",
          evidenceIds: ["evidence-1", "evidence-2"],
        },
      ],
    });
  });

  it("requires the claimed current snapshot to be freshly registered", async () => {
    await expect(
      validateEvidence({
        candidate: architectureCandidate(),
        packet: issueTwoFiles(),
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: "d".repeat(64),
        contextMode: "project_only",
        readEvidence: files(),
        idFactory: () => "stale-unknown-1",
      }),
    ).rejects.toThrow(/not registered|expired/i);
  });

  it("fails closed on a changed snapshot when no issued evidence can carry a stale answer", async () => {
    const packet = issueEvidencePacket({
      runId: RUN_ID,
      generation: GENERATION,
      snapshotDigest: SNAPSHOT,
      sources: [],
    });
    const candidate: ModelAnswerCandidate = {
      conclusionClaimId: "claim-unsupported",
      claims: [
        {
          id: "claim-unsupported",
          statement: "The entry point could not be established.",
          category: "architecture",
          evidenceIds: [],
        },
      ],
      unknowns: [
        {
          id: "unknown-missing",
          code: "missing_evidence",
          statement: "No current project evidence was available.",
          claimIds: ["claim-unsupported"],
          evidenceIds: [],
        },
      ],
    };

    await expect(
      validateEvidence({
        candidate,
        packet,
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: OTHER_SNAPSHOT,
        contextMode: "project_only",
        readEvidence: files(),
      }),
    ).rejects.toThrow(/snapshot changed/i);
    await expect(
      validateEvidence({
        candidate,
        packet,
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: SNAPSHOT,
        contextMode: "project_only",
        readEvidence: files(),
      }),
    ).resolves.toMatchObject({ reviewStatus: "unsupported", evidence: [] });
  });

  it("marks evidence stale when a cited file hash or exact range no longer matches", async () => {
    const answer = await validateEvidence({
      candidate: architectureCandidate(),
      packet: issueTwoFiles(),
      expectedRunId: RUN_ID,
      expectedGeneration: GENERATION,
      currentSnapshotDigest: SNAPSHOT,
      contextMode: "project_only",
      readEvidence: files({
        "src/gateway.ts": "// inserted\nexport const gateway = 'dirty sentinel';\nexport const next = worker;\n",
      }),
      idFactory: () => "stale-unknown-1",
    });

    expect(answer.reviewStatus).toBe("stale");
    expect(answer.unknowns[0]?.evidenceIds).toContain("evidence-1");
  });

  it("marks deleted cited files stale without exposing the read failure", async () => {
    const answer = await validateEvidence({
      candidate: architectureCandidate(),
      packet: issueTwoFiles(),
      expectedRunId: RUN_ID,
      expectedGeneration: GENERATION,
      currentSnapshotDigest: SNAPSHOT,
      contextMode: "project_only",
      readEvidence: async (path, startLine, endLine) => {
        if (path === "src/gateway.ts") {
          throw new Error("ENOENT D:\\private\\deleted-secret.ts");
        }
        return files()(path, startLine, endLine);
      },
      idFactory: () => "stale-unknown-1",
    });

    expect(answer.reviewStatus).toBe("stale");
    expect(answer.unknowns[0]?.evidenceIds).toContain("evidence-1");
    expect(JSON.stringify(answer)).not.toContain("deleted-secret");
  });

  it("bounds evidence packet source count and total source bytes", () => {
    const source = {
      kind: "code_excerpt" as const,
      path: "src/a.ts",
      excerpt: "one",
      fileHash: sha256Text("one\n"),
      sourceLocationKey: "location-a",
      startLine: 1,
      endLine: 1,
    };
    expect(() => issueEvidencePacket({
      runId: RUN_ID,
      generation: GENERATION,
      snapshotDigest: SNAPSHOT,
      sources: Array.from({ length: 65 }, (_, index) => ({ ...source, path: `src/${index}.ts` })),
    })).toThrow(/source count/i);
    expect(() => issueEvidencePacket({
      runId: RUN_ID,
      generation: GENERATION,
      snapshotDigest: SNAPSHOT,
      sources: [{ ...source, excerpt: `one\n${"x".repeat(512 * 1024)}`, endLine: 2 }],
    })).toThrow(/source bytes/i);
    expect(() => issueEvidencePacket({
      runId: RUN_ID,
      generation: GENERATION,
      snapshotDigest: SNAPSHOT,
      sources: [{
        ...source,
        excerpt: Array.from({ length: 201 }, () => "x").join("\n"),
        endLine: 201,
      }],
    })).toThrow(/line.*limit|too many.*lines/i);
  });

  it("issues evidence only for an exact path/hash in a trusted workspace snapshot", () => {
    const source = {
      kind: "code_excerpt" as const,
      path: "src/gateway.ts",
      excerpt: "export const gateway = 'dirty sentinel';",
      fileHash: sha256Text("changed after snapshot\n"),
      sourceLocationKey: "location-gateway",
      startLine: 1,
      endLine: 1,
    };
    expect(() =>
      issueEvidencePacket({
        runId: RUN_ID,
        generation: GENERATION,
        snapshotDigest: SNAPSHOT,
        sources: [source],
      }),
    ).toThrow(/snapshot|file hash/i);
    expect(() =>
      issueEvidencePacket({
        runId: RUN_ID,
        generation: GENERATION,
        snapshotDigest: "f".repeat(64),
        sources: [{ ...source, fileHash: sha256Text(FIXTURE_FILES["src/gateway.ts"]!) }],
      }),
    ).toThrow(/not registered|expired/i);
    expect(() =>
      issueEvidencePacket({
        runId: RUN_ID,
        generation: GENERATION,
        snapshotDigest: "e".repeat(64),
        sources: [],
      }),
    ).toThrow(/not registered|expired/i);
  });

  it("rejects two public paths that alias the same physical source", () => {
    const common = {
      kind: "code_excerpt" as const,
      excerpt: "export const value = 1;",
      fileHash: sha256Text("export const value = 1;\n"),
      sourceLocationKey: "same-physical-location",
      startLine: 1,
      endLine: 1,
    };
    expect(() => issueEvidencePacket({
      runId: RUN_ID,
      generation: GENERATION,
      snapshotDigest: SNAPSHOT,
      sources: [
        { ...common, path: "src/same-real.ts" },
        { ...common, path: "src/same-alias.ts" },
      ],
    })).toThrow(/alias.*physical|physical.*alias/i);

    expect(() => issueEvidencePacket({
      runId: RUN_ID,
      generation: GENERATION,
      snapshotDigest: SNAPSHOT,
      sources: [
        { ...common, path: "src/same-real.ts", sourceLocationKey: "physical-before" },
        { ...common, path: "src/same-real.ts", sourceLocationKey: "physical-after" },
      ],
    })).toThrow(/path.*physical|physical.*path/i);
  });

  it("rejects a packet whose issued range or hash was changed after issuance", async () => {
    const packet = issueTwoFiles();
    const first = packet.evidence[0];
    if (!first) {
      throw new Error("bad fixture");
    }
    const tampered = {
      ...packet,
      evidence: [
        { ...first, startLine: 2, excerptHash: "f".repeat(64) },
        ...packet.evidence.slice(1),
      ],
    } as EvidencePacket;

    await expect(
      validateEvidence({
        candidate: architectureCandidate(),
        packet: tampered,
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: SNAPSHOT,
        contextMode: "project_only",
        readEvidence: files(),
      }),
    ).rejects.toThrow(/packet.*integrity/i);
  });

  it("rejects a resealed packet whose excerpt hash does not match its exact excerpt", async () => {
    const packet = issueTwoFiles();
    const first = packet.evidence[0]!;
    const evidence = [
      { ...first, excerptHash: "f".repeat(64) },
      ...packet.evidence.slice(1),
    ] as EvidencePacket["evidence"];
    const resealed = {
      ...packet,
      evidence,
      integrityDigest: digestCanonicalJson({
        version: 1,
        packetId: packet.packetId,
        runId: packet.runId,
        generation: packet.generation,
        snapshotDigest: packet.snapshotDigest,
        evidence,
      }),
    };

    await expect(
      validateEvidence({
        candidate: architectureCandidate(),
        packet: resealed,
        expectedRunId: RUN_ID,
        expectedGeneration: GENERATION,
        currentSnapshotDigest: OTHER_SNAPSHOT,
        contextMode: "project_only",
        readEvidence: files(),
      }),
    ).rejects.toThrow(/excerpt hash/i);
  });
});

describe("bounded evidence expansion outputs", () => {
  const request = {
    kind: "evidence_request" as const,
    request: {
      query: "worker entry point",
      reason: "The issued packet does not contain the worker implementation.",
      requestedKinds: ["code_excerpt"] as const,
    },
  };

  it("allows at most two typed evidence requests before requiring an answer", () => {
    expect(validateEvidenceQuestionOutput(request, 0)).toEqual(request);
    expect(validateEvidenceQuestionOutput(request, 1)).toEqual(request);
    expect(() => validateEvidenceQuestionOutput(request, 2)).toThrow(/two|limit|budget/i);

    const answer = { kind: "answer" as const, answer: architectureCandidate() };
    expect(validateEvidenceQuestionOutput(answer, 2)).toEqual(answer);
  });

  it("rejects request-minted paths/ranges and invalid retry counters", () => {
    expect(() =>
      validateEvidenceQuestionOutput(
        {
          ...request,
          request: {
            ...request.request,
            path: "src/worker.ts",
            startLine: 1,
            endLine: 20,
          },
        },
        0,
      ),
    ).toThrow();
    for (const used of [-1, 1.5, 3]) {
      expect(() => validateEvidenceQuestionOutput(request, used)).toThrow(/counter|budget/i);
    }
  });
});

describe("independent evidence-support audit validation", () => {
  it("authenticates only the live, unmodified validateEvidence result for audit", async () => {
    const answer = await validateEvidence({
      candidate: architectureCandidate(),
      packet: issueTwoFiles(),
      expectedRunId: RUN_ID,
      expectedGeneration: GENERATION,
      currentSnapshotDigest: SNAPSHOT,
      contextMode: "project_only",
      readEvidence: files(),
    });

    expect(authenticateValidatedEvidenceAnswerForAudit(answer)).toEqual(answer);
    expect(() => authenticateValidatedEvidenceAnswerForAudit(
      JSON.parse(JSON.stringify(answer)) as typeof answer,
    )).toThrow(/validated|issued|authority/i);

    answer.claims[0]!.statement = "Mutated after validation";
    expect(() => authenticateValidatedEvidenceAnswerForAudit(answer)).toThrow(/mutated|authority/i);
  });

  it("rejects an accessor-shaped audit answer without executing it", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "reviewStatus", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "citation_validated";
      },
    });

    expect(() => authenticateValidatedEvidenceAnswerForAudit(
      accessor as Awaited<ReturnType<typeof validateEvidence>>,
    )).toThrow(/validated|issued|authority/i);
    expect(getterCalls).toBe(0);
  });

  it("rejects a replaced nested proxy without entering its traps", async () => {
    const answer = await validateEvidence({
      candidate: architectureCandidate(),
      packet: issueTwoFiles(),
      expectedRunId: RUN_ID,
      expectedGeneration: GENERATION,
      currentSnapshotDigest: SNAPSHOT,
      contextMode: "project_only",
      readEvidence: files(),
    });
    let trapCalls = 0;
    answer.claims[0] = new Proxy({ ...answer.claims[0]! }, {
      ownKeys() {
        trapCalls += 1;
        throw new Error("hostile nested proxy");
      },
    });

    expect(() => authenticateValidatedEvidenceAnswerForAudit(answer)).toThrow(/mutated|authority/i);
    expect(trapCalls).toBe(0);
  });

  it("promotes only an all-directly-supported, exactly corresponding audit", async () => {
    const answer = await validateEvidence({
      candidate: architectureCandidate(),
      packet: issueTwoFiles(),
      expectedRunId: RUN_ID,
      expectedGeneration: GENERATION,
      currentSnapshotDigest: SNAPSHOT,
      contextMode: "project_only",
      readEvidence: files(),
    });

    expect(validateEvidenceSupportAudit(answer, matchingAudit(answer))).toEqual({
      reviewStatus: "evidence_reviewed",
      supportReview: matchingAudit(answer),
      unsupportedClaimIds: [],
    });
  });

  it("rejects an audit that changes a claim's cited evidence set", async () => {
    const answer = await validateEvidence({
      candidate: architectureCandidate(),
      packet: issueTwoFiles(),
      expectedRunId: RUN_ID,
      expectedGeneration: GENERATION,
      currentSnapshotDigest: SNAPSHOT,
      contextMode: "project_only",
      readEvidence: files(),
    });
    const audit = matchingAudit(answer);
    audit.records[0] = { ...audit.records[0]!, evidenceIds: ["evidence-1"] };

    expect(() => validateEvidenceSupportAudit(answer, audit)).toThrow(/exactly.*cited/i);
  });

  it("rejects an audit from another candidate generation", async () => {
    const answer = await validateEvidence({
      candidate: architectureCandidate(),
      packet: issueTwoFiles(),
      expectedRunId: RUN_ID,
      expectedGeneration: GENERATION,
      currentSnapshotDigest: SNAPSHOT,
      contextMode: "project_only",
      readEvidence: files(),
    });
    const audit = matchingAudit(answer);
    audit.generation = "generation-2";

    expect(() => validateEvidenceSupportAudit(answer, audit)).toThrow(/candidate.*run/i);
  });

  it("reports unsupported honestly when any audit verdict is not direct support", async () => {
    const answer = await validateEvidence({
      candidate: architectureCandidate(),
      packet: issueTwoFiles(),
      expectedRunId: RUN_ID,
      expectedGeneration: GENERATION,
      currentSnapshotDigest: SNAPSHOT,
      contextMode: "project_only",
      readEvidence: files(),
    });
    const audit = matchingAudit(answer);
    audit.records[0] = {
      ...audit.records[0]!,
      verdict: "partially_supported",
      rationale: "The test does not establish every part of the claim.",
    };

    expect(validateEvidenceSupportAudit(answer, audit)).toMatchObject({
      reviewStatus: "unsupported",
      unsupportedClaimIds: ["claim-1"],
    });
  });

  it("cannot promote a stale answer even when an audit claims direct support", async () => {
    const answer = await validateEvidence({
      candidate: architectureCandidate(),
      packet: issueTwoFiles(),
      expectedRunId: RUN_ID,
      expectedGeneration: GENERATION,
      currentSnapshotDigest: OTHER_SNAPSHOT,
      contextMode: "project_only",
      readEvidence: files(),
      idFactory: () => "stale-unknown-1",
    });

    expect(() => validateEvidenceSupportAudit(answer, matchingAudit(answer))).toThrow(/citation.validated/i);
  });
});
