import { describe, expect, it } from "vitest";

import {
  AnnotationThreadSchema,
  AnswerClaimSchema,
  AnswerReviewStatusSchema,
  BindingStatusSchema,
  CanonicalManifestAttestationSchema,
  ClaimCategorySchema,
  CompletedQuestionRunEventSequenceSchema,
  ContextModeSchema,
  DispositionSchema,
  EditIntentBatchSchema,
  EditIntentSchema,
  EditOperationSchema,
  EvidenceAnswerSchema,
  EvidenceKindSchema,
  EvidenceReferenceSchema,
  EvidenceExpansionRequestSchema,
  EvidenceSupportReviewSchema,
  InternalWorkspaceSnapshotSchema,
  ModelAnswerCandidateSchema,
  ModelQuestionOutputSchema,
  QuestionRecordSchema,
  QuestionRunCursorSchema,
  QuestionRunEventSchema,
  QuestionRunEventSequenceSchema,
  QuestionRunPageSchema,
  QuestionRunPollStateSchema,
  QuestionRunStatusSchema,
  ReaderSessionSchema,
  SourceAnchorSchema,
  WorkspaceSnapshotSchema,
  WorkspaceSnapshotRefSchema,
  advanceQuestionRunPageTransition,
  normalizeQuestionRunEventReplay,
  validateQuestionRunEventSequence,
} from "./index.js";

const SNAPSHOT_DIGEST = "a".repeat(64);
const DOCUMENT_HASH = "b".repeat(64);
const EXCERPT_HASH = "c".repeat(64);
const FILE_HASH = "d".repeat(64);
const CREATED_AT = "2026-09-01T12:00:00.000Z";
const RUN_ID = "run-1";
const GENERATION = "generation-1";
const CANDIDATE_DIGEST = "9".repeat(64);

function sourceAnchor(overrides: Record<string, unknown> = {}) {
  return {
    documentPath: "docs/design.md",
    documentHash: DOCUMENT_HASH,
    headingPath: ["Architecture"],
    selectedText: "The gateway calls the worker.",
    prefix: "Flow: ",
    suffix: " This is current.",
    startOffset: 10,
    endOffset: 39,
    ...overrides,
  };
}

function projectEvidence(overrides: Record<string, unknown> = {}) {
  return {
    id: "evidence-code-1",
    kind: "code_excerpt",
    path: "src/api.ts",
    startLine: 1,
    endLine: 4,
    excerpt: "export function api() { return worker(); }",
    excerptHash: EXCERPT_HASH,
    fileHash: FILE_HASH,
    snapshotDigest: SNAPSHOT_DIGEST,
    provenance: {
      issuer: "workspace_service",
      packetId: "packet-1",
      runId: RUN_ID,
      generation: GENERATION,
    },
    ...overrides,
  };
}

function documentEvidence(overrides: Record<string, unknown> = {}) {
  return projectEvidence({
    id: "evidence-doc-1",
    kind: "project_document",
    path: "docs/design.md",
    excerpt: "The gateway calls the worker.",
    ...overrides,
  });
}

function taskEvidence(overrides: Record<string, unknown> = {}) {
  return {
    id: "evidence-task-1",
    kind: "task_decision",
    sourceRef: "decision-ref-1",
    excerpt: "Use a side conversation for reader questions.",
    excerptHash: EXCERPT_HASH,
    snapshotDigest: SNAPSHOT_DIGEST,
    provenance: {
      issuer: "context_bridge",
      packetId: "packet-1",
      runId: RUN_ID,
      generation: GENERATION,
    },
    ...overrides,
  };
}

function inferenceEvidence(overrides: Record<string, unknown> = {}) {
  return {
    id: "evidence-inference-1",
    kind: "inference",
    rationale: "The two excerpts indicate a call relationship.",
    basisEvidenceIds: ["evidence-code-1"],
    snapshotDigest: SNAPSHOT_DIGEST,
    provenance: {
      issuer: "answer_service",
      runId: RUN_ID,
      generation: GENERATION,
    },
    ...overrides,
  };
}

function claim(overrides: Record<string, unknown> = {}) {
  return {
    id: "claim-1",
    statement: "The API enters through src/api.ts.",
    category: "code_fact",
    evidenceIds: ["evidence-code-1"],
    ...overrides,
  };
}

function unknownRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "unknown-1",
    code: "missing_evidence",
    statement: "The current project does not contain enough evidence for this claim.",
    claimIds: ["claim-1"],
    evidenceIds: [],
    ...overrides,
  };
}

function supportReview(overrides: Record<string, unknown> = {}) {
  return {
    id: "audit-1",
    reviewer: "independent_model",
    modelAssisted: true,
    runId: RUN_ID,
    generation: GENERATION,
    candidateDigest: CANDIDATE_DIGEST,
    snapshotDigest: SNAPSHOT_DIGEST,
    records: [
      {
        id: "audit-record-1",
        claimId: "claim-1",
        evidenceIds: ["evidence-code-1"],
        verdict: "directly_supported",
        rationale: "The cited excerpt directly names the API entry.",
      },
    ],
    ...overrides,
  };
}

function canonicalManifestAttestation(overrides: Record<string, unknown> = {}) {
  return {
    id: "attestation-1",
    authority: "workspace_service",
    claimId: "claim-1",
    evidenceId: "evidence-code-1",
    packetId: "packet-1",
    runId: RUN_ID,
    generation: GENERATION,
    candidateDigest: CANDIDATE_DIGEST,
    snapshotDigest: SNAPSHOT_DIGEST,
    path: "package.json",
    fileHash: FILE_HASH,
    startLine: 1,
    endLine: 4,
    ...overrides,
  };
}

function answer(overrides: Record<string, unknown> = {}) {
  return {
    conclusionClaimId: "claim-1",
    runId: RUN_ID,
    generation: GENERATION,
    candidateDigest: CANDIDATE_DIGEST,
    claims: [claim()],
    reviewStatus: "citation_validated",
    contextMode: "task_and_project",
    evidence: [projectEvidence()],
    unknowns: [],
    snapshotDigest: SNAPSHOT_DIGEST,
    ...overrides,
  };
}

function largeEvidenceAnswer(
  evidenceCount: number,
  runId = RUN_ID,
  generation = GENERATION,
  prefix = "large",
) {
  const evidence = Array.from({ length: evidenceCount }, (_, index) =>
    projectEvidence({
      id: `${prefix}-evidence-${index}`,
      path: `src/${prefix}-${index}.ts`,
      excerpt: "界".repeat(16_000),
      provenance: {
        issuer: "workspace_service",
        packetId: `${prefix}-packet-${index}`,
        runId,
        generation,
      },
    }),
  );
  return answer({
    runId,
    generation,
    conclusionClaimId: `${prefix}-claim`,
    claims: [
      claim({
        id: `${prefix}-claim`,
        evidenceIds: evidence.map((item) => item.id),
      }),
    ],
    evidence,
  });
}

function unsupportedInferenceAnswer(overrides: Record<string, unknown> = {}) {
  return answer({
    claims: [claim({ category: "inference", evidenceIds: [] })],
    evidence: [],
    reviewStatus: "unsupported",
    unknowns: [unknownRecord()],
    ...overrides,
  });
}

function staleAnswer(overrides: Record<string, unknown> = {}) {
  return answer({
    reviewStatus: "stale",
    unknowns: [
      unknownRecord({
        code: "stale_snapshot",
        statement: "The workspace changed after evidence issuance.",
        evidenceIds: ["evidence-code-1"],
      }),
    ],
    ...overrides,
  });
}

function event(
  sequence: number,
  type: string = "progress",
  payload: Record<string, unknown> = { status: "inspecting", message: "Inspecting source." },
  overrides: Record<string, unknown> = {},
) {
  return {
    runId: "run-1",
    generation: "generation-1",
    sequence,
    type,
    createdAt: CREATED_AT,
    payload,
    ...overrides,
  };
}

describe("reader contracts", () => {
  it("rejects an evidence-reviewed answer without project evidence", () => {
    expect(() =>
      EvidenceAnswerSchema.parse({
        conclusionClaimId: "claim-1",
        claims: [
          {
            id: "claim-1",
            statement: "The API enters through src/api.ts.",
            category: "architecture",
            evidenceIds: [],
          },
        ],
        reviewStatus: "evidence_reviewed",
        contextMode: "task_and_project",
        evidence: [],
        unknowns: [],
        snapshotDigest: "a".repeat(64),
      }),
    ).toThrow();
  });

  it("does not expose a parent thread id in a reader session", () => {
    const session = ReaderSessionSchema.parse({
      id: "session-1",
      bindingStatus: "unavailable",
      contextMode: "project_only",
      rootId: "root-1",
      workspaceLabel: "repo",
      documentPath: "README.md",
    });
    expect(session).not.toHaveProperty("parentThreadId");
  });

  it("requires enough text to relocate an anchor", () => {
    expect(() =>
      SourceAnchorSchema.parse({
        documentPath: "README.md",
        documentHash: "b".repeat(64),
        headingPath: [],
        selectedText: "",
        prefix: "",
        suffix: "",
        startOffset: 0,
        endOffset: 0,
      }),
    ).toThrow();
  });
});

describe("enum schemas", () => {
  it.each([
    [BindingStatusSchema, ["verified", "unavailable", "mismatch", "stale"]],
    [ContextModeSchema, ["task_and_project", "project_only", "document_only"]],
    [EvidenceKindSchema, ["code_excerpt", "test_excerpt", "project_document", "task_decision", "inference"]],
    [ClaimCategorySchema, ["code_fact", "architecture", "cross_module_flow", "configuration", "document_literal", "task_decision", "inference"]],
    [AnswerReviewStatusSchema, ["citation_validated", "evidence_reviewed", "stale", "unsupported", "conflict"]],
    [DispositionSchema, ["reading_only", "inline", "replace", "glossary", "faq", "ignore"]],
    [EditOperationSchema, ["insert_after", "replace", "append_section"]],
    [QuestionRunStatusSchema, ["draft", "queued", "inspecting", "streaming_unverified", "validating", "completed", "stale", "failed", "cancelled"]],
  ])("accepts only the declared values", (schema, values) => {
    for (const value of values) expect(schema.parse(value)).toBe(value);
    expect(() => schema.parse("invented_value")).toThrow();
  });
});

describe("workspace and anchor schemas", () => {
  it("accepts an opaque, hash-bound workspace snapshot", () => {
    expect(
      WorkspaceSnapshotSchema.parse({
        rootId: "root-1",
        branch: "codex/main",
        head: "e".repeat(40),
        dirtyStateDigest: SNAPSHOT_DIGEST,
        createdAt: CREATED_AT,
      }),
    ).toEqual({
      rootId: "root-1",
      branch: "codex/main",
      head: "e".repeat(40),
      dirtyStateDigest: SNAPSHOT_DIGEST,
      createdAt: CREATED_AT,
    });
    expect(() =>
      WorkspaceSnapshotRefSchema.parse({
        rootId: "root-1",
        branch: null,
        head: null,
        dirtyStateDigest: SNAPSHOT_DIGEST,
        createdAt: CREATED_AT,
      }),
    ).not.toThrow();
  });

  it("keeps the canonical project root in an internal-only snapshot contract", () => {
    expect(
      InternalWorkspaceSnapshotSchema.parse({
        projectRoot: "D:\\Project\\AIMD",
        branch: "codex/main",
        head: "e".repeat(40),
        dirtyStateDigest: SNAPSHOT_DIGEST,
        createdAt: CREATED_AT,
      }),
    ).toMatchObject({ projectRoot: "D:\\Project\\AIMD" });
    expect(() =>
      InternalWorkspaceSnapshotSchema.parse({
        projectRoot: "relative/project",
        branch: null,
        head: null,
        dirtyStateDigest: SNAPSHOT_DIGEST,
        createdAt: CREATED_AT,
      }),
    ).toThrow();
  });

  it("rejects a real project root and unknown snapshot fields", () => {
    expect(() =>
      WorkspaceSnapshotSchema.parse({
        rootId: "root-1",
        branch: null,
        head: null,
        dirtyStateDigest: SNAPSHOT_DIGEST,
        createdAt: CREATED_AT,
        projectRoot: "C:\\private\\repo",
      }),
    ).toThrow();
  });

  it("accepts a relocatable source anchor", () => {
    expect(SourceAnchorSchema.parse(sourceAnchor())).toMatchObject({
      documentPath: "docs/design.md",
      selectedText: "The gateway calls the worker.",
    });
  });

  it("allows a source span widened by Markdown syntax", () => {
    expect(() =>
      SourceAnchorSchema.parse(
        sourceAnchor({
          selectedText: "gateway",
          startOffset: 10,
          endOffset: 19,
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    "/etc/passwd",
    "C:\\private\\README.md",
    "../README.md",
    "docs/../../secret.md",
    "docs\\README.md",
    "docs/hidden\u0085name.md",
    "docs/unpaired\ud800name.md",
  ])(
    "rejects unsafe document path %s",
    (documentPath) => {
      expect(() => SourceAnchorSchema.parse(sourceAnchor({ documentPath }))).toThrow();
    },
  );

  it("rejects illegal anchor hashes, ranges, blank headings, and unknown keys", () => {
    expect(() => SourceAnchorSchema.parse(sourceAnchor({ documentHash: "not-a-hash" }))).toThrow();
    expect(() => SourceAnchorSchema.parse(sourceAnchor({ startOffset: 40, endOffset: 39 }))).toThrow();
    expect(() => SourceAnchorSchema.parse(sourceAnchor({ headingPath: [" "] }))).toThrow();
    expect(() => SourceAnchorSchema.parse(sourceAnchor({ absolutePath: "C:\\private\\README.md" }))).toThrow();
  });
});

describe("evidence reference schemas", () => {
  it("accepts strict project, task, and inference evidence variants", () => {
    expect(EvidenceReferenceSchema.parse(projectEvidence()).kind).toBe("code_excerpt");
    expect(EvidenceReferenceSchema.parse(taskEvidence()).kind).toBe("task_decision");
    expect(EvidenceReferenceSchema.parse(inferenceEvidence()).kind).toBe("inference");
  });

  it("requires bounded project paths, line ranges, hashes, excerpts, and issuance provenance", () => {
    expect(() => EvidenceReferenceSchema.parse(projectEvidence({ path: "../secret.ts" }))).toThrow();
    expect(() => EvidenceReferenceSchema.parse(projectEvidence({ path: "C:\\repo\\src\\api.ts" }))).toThrow();
    expect(() => EvidenceReferenceSchema.parse(projectEvidence({ startLine: 0 }))).toThrow();
    expect(() => EvidenceReferenceSchema.parse(projectEvidence({ startLine: 5, endLine: 4 }))).toThrow();
    expect(() => EvidenceReferenceSchema.parse(projectEvidence({ excerpt: " " }))).toThrow();
    expect(() => EvidenceReferenceSchema.parse(projectEvidence({ excerptHash: "bad" }))).toThrow();
    expect(() => EvidenceReferenceSchema.parse(projectEvidence({ fileHash: "bad" }))).toThrow();
    expect(() => EvidenceReferenceSchema.parse(projectEvidence({ provenance: undefined }))).toThrow();
  });

  it("keeps task provenance distinct from project path provenance", () => {
    expect(() => EvidenceReferenceSchema.parse(taskEvidence({ path: "src/api.ts" }))).toThrow();
    expect(() => EvidenceReferenceSchema.parse(taskEvidence({ turnId: "real-turn-id" }))).toThrow();
    expect(() => EvidenceReferenceSchema.parse(projectEvidence({ sourceRef: "decision-ref-1" }))).toThrow();
  });

  it("rejects inference evidence that cites itself or repeats a basis", () => {
    expect(() =>
      EvidenceReferenceSchema.parse(
        inferenceEvidence({ basisEvidenceIds: ["evidence-inference-1"] }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceReferenceSchema.parse(
        inferenceEvidence({ basisEvidenceIds: ["evidence-code-1", "evidence-code-1"] }),
      ),
    ).toThrow();
  });

  it("rejects unknown evidence and provenance fields", () => {
    expect(() => EvidenceReferenceSchema.parse(projectEvidence({ signatureVerified: true }))).toThrow();
    expect(() =>
      EvidenceReferenceSchema.parse(
        projectEvidence({
          provenance: {
            issuer: "workspace_service",
            packetId: "packet-1",
            runId: "run-1",
            rawRoot: "C:\\private\\repo",
          },
        }),
      ),
    ).toThrow();
  });
});

describe("evidence answer invariants", () => {
  it("accepts a citation-validated current project fact", () => {
    expect(EvidenceAnswerSchema.parse(answer())).toMatchObject({
      conclusionClaimId: "claim-1",
      reviewStatus: "citation_validated",
    });
  });

  it("requires server binding fields on the final answer envelope", () => {
    const { runId: _runId, ...withoutRunId } = answer();
    const { generation: _generation, ...withoutGeneration } = answer();
    const { candidateDigest: _candidateDigest, ...withoutCandidateDigest } = answer();
    expect(() => EvidenceAnswerSchema.parse(withoutRunId)).toThrow();
    expect(() => EvidenceAnswerSchema.parse(withoutGeneration)).toThrow();
    expect(() => EvidenceAnswerSchema.parse(withoutCandidateDigest)).toThrow();
  });

  it("binds project, task, and inference evidence to the answer run and generation", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          evidence: [
            projectEvidence({
              provenance: {
                issuer: "workspace_service",
                packetId: "packet-1",
                runId: "run-2",
                generation: GENERATION,
              },
            }),
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          claims: [claim({ category: "task_decision", evidenceIds: ["evidence-task-1"] })],
          evidence: [
            taskEvidence({
              provenance: {
                issuer: "context_bridge",
                packetId: "packet-1",
                runId: RUN_ID,
                generation: "generation-2",
              },
            }),
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          claims: [claim({ category: "inference", evidenceIds: ["evidence-inference-1"] })],
          evidence: [
            projectEvidence(),
            inferenceEvidence({
              provenance: {
                issuer: "answer_service",
                runId: "run-2",
                generation: GENERATION,
              },
            }),
          ],
        }),
      ),
    ).toThrow();
  });

  it("allows evidence expansion packets only within the same run generation", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          claims: [claim({ evidenceIds: ["evidence-code-1", "evidence-code-2"] })],
          evidence: [
            projectEvidence(),
            projectEvidence({
              id: "evidence-code-2",
              path: "src/worker.ts",
              provenance: {
                issuer: "workspace_service",
                packetId: "packet-2",
                runId: RUN_ID,
                generation: GENERATION,
              },
            }),
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects an audit from another run, generation, or answer candidate", () => {
    for (const oldAudit of [
      supportReview({ runId: "run-2" }),
      supportReview({ generation: "generation-2" }),
      supportReview({ candidateDigest: "8".repeat(64) }),
    ]) {
      expect(() =>
        EvidenceAnswerSchema.parse(
          answer({ reviewStatus: "evidence_reviewed", supportReview: oldAudit }),
        ),
      ).toThrow();
    }
  });

  it("rejects a canonical-manifest attestation from another generation or candidate", () => {
    for (const oldAttestation of [
      canonicalManifestAttestation({ generation: "generation-2" }),
      canonicalManifestAttestation({ candidateDigest: "8".repeat(64) }),
    ]) {
      expect(() =>
        EvidenceAnswerSchema.parse(
          answer({
            claims: [claim({ category: "architecture" })],
            evidence: [projectEvidence({ kind: "project_document", path: "package.json" })],
            canonicalManifestAttestations: [oldAttestation],
          }),
        ),
      ).toThrow();
    }
  });

  it("requires nonblank, unique claim and evidence ids", () => {
    expect(() => AnswerClaimSchema.parse(claim({ id: " ", statement: " " }))).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(answer({ claims: [claim(), claim({ statement: "Duplicate." })] })),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({ evidence: [projectEvidence(), projectEvidence({ path: "src/other.ts" })] }),
      ),
    ).toThrow();
  });

  it("requires the conclusion and claim citations to reference records in this envelope", () => {
    expect(() => EvidenceAnswerSchema.parse(answer({ conclusionClaimId: "missing-claim" }))).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({ claims: [claim({ evidenceIds: ["evidence-from-another-run"] })] }),
      ),
    ).toThrow();
  });

  it("rejects project, task, or inference evidence unreachable from answer roots", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          evidence: [
            projectEvidence(),
            projectEvidence({ id: "evidence-code-2", path: "src/unused.ts" }),
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({ evidence: [projectEvidence(), taskEvidence()] }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({ evidence: [projectEvidence(), inferenceEvidence()] }),
      ),
    ).toThrow();
  });

  it("allows recursively reachable inference premises grounded in project evidence", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          claims: [claim({ category: "inference", evidenceIds: ["evidence-inference-2"] })],
          evidence: [
            projectEvidence(),
            inferenceEvidence(),
            inferenceEvidence({
              id: "evidence-inference-2",
              basisEvidenceIds: ["evidence-inference-1"],
            }),
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects cyclic inference evidence even when the cycle is claim-reachable", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          claims: [claim({ category: "inference", evidenceIds: ["evidence-inference-1"] })],
          evidence: [
            inferenceEvidence({ basisEvidenceIds: ["evidence-inference-2"] }),
            inferenceEvidence({
              id: "evidence-inference-2",
              basisEvidenceIds: ["evidence-inference-1"],
            }),
          ],
        }),
      ),
    ).toThrow();
  });

  it("binds unknown evidence to the claims named by that unknown", () => {
    const secondClaim = claim({
      id: "claim-2",
      statement: "The worker lives in src/worker.ts.",
      evidenceIds: ["evidence-code-2"],
    });
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          reviewStatus: "conflict",
          claims: [claim(), secondClaim],
          evidence: [
            projectEvidence(),
            projectEvidence({ id: "evidence-code-2", path: "src/worker.ts" }),
          ],
          unknowns: [
            unknownRecord({
              code: "evidence_conflict",
              claimIds: ["claim-1"],
              evidenceIds: ["evidence-code-1", "evidence-code-2"],
            }),
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          reviewStatus: "stale",
          claims: [claim(), secondClaim],
          evidence: [
            projectEvidence(),
            projectEvidence({ id: "evidence-code-2", path: "src/worker.ts" }),
          ],
          unknowns: [
            unknownRecord({
              code: "stale_snapshot",
              claimIds: ["claim-1"],
              evidenceIds: ["evidence-code-2"],
            }),
          ],
        }),
      ),
    ).toThrow();
  });

  it("requires every evidence record and audit to match the answer snapshot", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({ evidence: [projectEvidence({ snapshotDigest: "f".repeat(64) })] }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          reviewStatus: "evidence_reviewed",
          supportReview: supportReview({ snapshotDigest: "f".repeat(64) }),
        }),
      ),
    ).toThrow();

    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          claims: [
            claim({
              category: "architecture",
              evidenceIds: ["evidence-code-1", "evidence-code-2"],
            }),
          ],
          evidence: [
            projectEvidence({ kind: "project_document", path: "package.json" }),
            projectEvidence({
              id: "evidence-code-2",
              kind: "project_document",
              path: "packages/worker/package.json",
            }),
          ],
          canonicalManifestAttestations: [
            canonicalManifestAttestation({ fileHash: "f".repeat(64) }),
          ],
        }),
      ),
    ).toThrow();
  });

  it("requires project evidence for current project facts", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({ claims: [claim({ evidenceIds: ["evidence-task-1"] })], evidence: [taskEvidence()] }),
      ),
    ).toThrow();
  });

  it("requires two distinct project paths for architecture and cross-module claims", () => {
    for (const category of ["architecture", "cross_module_flow"] as const) {
      expect(() =>
        EvidenceAnswerSchema.parse(
          answer({ claims: [claim({ category })] }),
        ),
      ).toThrow();

      expect(() =>
        EvidenceAnswerSchema.parse(
          answer({
            claims: [claim({ category, evidenceIds: ["evidence-code-1", "evidence-code-2"] })],
            evidence: [
              projectEvidence(),
              projectEvidence({ id: "evidence-code-2", startLine: 8, endLine: 10 }),
            ],
          }),
        ),
      ).toThrow();

      expect(() =>
        EvidenceAnswerSchema.parse(
          answer({
            claims: [claim({ category, evidenceIds: ["evidence-code-1", "evidence-code-2"] })],
            evidence: [projectEvidence(), projectEvidence({ id: "evidence-code-2", path: "src/worker.ts" })],
          }),
        ),
      ).not.toThrow();
    }
  });

  it("allows the one-path architecture exception only on server-issued canonical-manifest provenance", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          claims: [claim({ category: "architecture" })],
          evidence: [
            projectEvidence({
              kind: "project_document",
              path: "package.json",
            }),
          ],
          canonicalManifestAttestations: [canonicalManifestAttestation()],
        }),
      ),
    ).not.toThrow();

    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          claims: [claim({ category: "architecture", canonicalManifest: true })],
        }),
      ),
    ).toThrow();

    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          claims: [claim({ category: "architecture" })],
          evidence: [projectEvidence({ kind: "project_document", path: "package.json" })],
          canonicalManifestAttestations: [
            canonicalManifestAttestation({ fileHash: "f".repeat(64) }),
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects task-decision claims and evidence in project-only mode", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          contextMode: "project_only",
          claims: [claim({ category: "task_decision", evidenceIds: ["evidence-task-1"] })],
          evidence: [taskEvidence()],
        }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({ contextMode: "project_only", evidence: [projectEvidence(), taskEvidence()] }),
      ),
    ).toThrow();
  });

  it("limits document-only answers to literal citations in the selected document", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          contextMode: "document_only",
          documentPath: "docs/design.md",
          claims: [
            claim({
              statement: "The document says the gateway calls the worker.",
              category: "document_literal",
              evidenceIds: ["evidence-doc-1"],
            }),
          ],
          evidence: [documentEvidence()],
        }),
      ),
    ).not.toThrow();

    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({ contextMode: "document_only", documentPath: "docs/design.md" }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          contextMode: "document_only",
          documentPath: "README.md",
          claims: [claim({ category: "document_literal", evidenceIds: ["evidence-doc-1"] })],
          evidence: [documentEvidence()],
        }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          contextMode: "document_only",
          documentPath: "docs/design.md",
          claims: [claim({ category: "document_literal", evidenceIds: ["evidence-task-1"] })],
          evidence: [taskEvidence()],
        }),
      ),
    ).toThrow();
  });

  it("permits evidence-reviewed document literals only with a complete independent audit", () => {
    const documentClaim = claim({
      category: "document_literal",
      evidenceIds: ["evidence-doc-1"],
    });
    const documentReview = supportReview({
      records: [
        {
          id: "audit-record-1",
          claimId: "claim-1",
          evidenceIds: ["evidence-doc-1"],
          verdict: "directly_supported",
          rationale: "The literal statement appears in the document excerpt.",
        },
      ],
    });

    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          contextMode: "document_only",
          documentPath: "docs/design.md",
          claims: [documentClaim],
          evidence: [documentEvidence()],
          reviewStatus: "evidence_reviewed",
          supportReview: documentReview,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          contextMode: "document_only",
          documentPath: "docs/design.md",
          claims: [documentClaim],
          evidence: [documentEvidence()],
          reviewStatus: "evidence_reviewed",
        }),
      ),
    ).toThrow();
  });

  it("requires an exact, independent, all-supported audit for evidence-reviewed answers", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({ reviewStatus: "evidence_reviewed", supportReview: supportReview() }),
      ),
    ).not.toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(answer({ reviewStatus: "evidence_reviewed" })),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          reviewStatus: "evidence_reviewed",
          supportReview: supportReview({ records: [] }),
        }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          reviewStatus: "evidence_reviewed",
          supportReview: supportReview({
            records: [
              {
                id: "claim-1",
                claimId: "claim-1",
                evidenceIds: ["evidence-code-1"],
                verdict: "directly_supported",
                rationale: "Self-referential audit id.",
              },
            ],
          }),
        }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          reviewStatus: "evidence_reviewed",
          supportReview: supportReview({
            records: [
              {
                id: "audit-record-1",
                claimId: "claim-1",
                evidenceIds: ["evidence-code-1"],
                verdict: "partially_supported",
                rationale: "Only part of the statement is supported.",
              },
            ],
          }),
        }),
      ),
    ).toThrow();
  });

  it("does not evidence-review an inference against an empty evidence set", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          claims: [claim({ category: "inference", evidenceIds: [] })],
          evidence: [],
          unknowns: [unknownRecord()],
          reviewStatus: "evidence_reviewed",
          supportReview: supportReview({
            records: [
              {
                id: "audit-record-1",
                claimId: "claim-1",
                evidenceIds: [],
                verdict: "directly_supported",
                rationale: "An empty packet cannot directly support the inference.",
              },
            ],
          }),
        }),
      ),
    ).toThrow();
  });

  it("does not let a citation-valid label override a negative semantic audit", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          supportReview: supportReview({
            records: [
              {
                id: "audit-record-1",
                claimId: "claim-1",
                evidenceIds: ["evidence-code-1"],
                verdict: "unsupported",
                rationale: "The excerpt does not support the claim.",
              },
            ],
          }),
        }),
      ),
    ).toThrow();
  });

  it("keeps positive review states free of negative unknowns and misplaced audits", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({ unknowns: [unknownRecord()] }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({ supportReview: supportReview() }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          reviewStatus: "evidence_reviewed",
          supportReview: supportReview(),
          unknowns: [unknownRecord()],
        }),
      ),
    ).toThrow();
  });

  it("requires negative statuses to contain only compatible structured reasons", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          reviewStatus: "unsupported",
          unknowns: [
            unknownRecord({
              code: "stale_snapshot",
              evidenceIds: ["evidence-code-1"],
            }),
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        staleAnswer({
          unknowns: [
            unknownRecord({
              code: "stale_snapshot",
              evidenceIds: ["evidence-code-1"],
            }),
            unknownRecord({
              id: "unknown-2",
              code: "evidence_conflict",
              evidenceIds: ["evidence-code-1", "evidence-code-2"],
            }),
          ],
          claims: [claim({ evidenceIds: ["evidence-code-1", "evidence-code-2"] })],
          evidence: [
            projectEvidence(),
            projectEvidence({ id: "evidence-code-2", path: "src/worker.ts" }),
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          reviewStatus: "conflict",
          claims: [claim({ evidenceIds: ["evidence-code-1", "evidence-code-2"] })],
          evidence: [
            projectEvidence(),
            projectEvidence({ id: "evidence-code-2", path: "src/worker.ts" }),
          ],
          unknowns: [
            unknownRecord({
              code: "evidence_conflict",
              evidenceIds: ["evidence-code-1", "evidence-code-2"],
            }),
            unknownRecord({
              id: "unknown-2",
              code: "stale_snapshot",
              evidenceIds: ["evidence-code-1"],
            }),
          ],
        }),
      ),
    ).toThrow();
  });

  it("requires an unsupported audit to contain a negative verdict tied to its unknown", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          reviewStatus: "unsupported",
          unknowns: [unknownRecord()],
          supportReview: supportReview(),
        }),
      ),
    ).toThrow();

    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          reviewStatus: "unsupported",
          unknowns: [
            unknownRecord({
              code: "unsupported_claim",
              evidenceIds: ["evidence-code-1"],
            }),
          ],
          supportReview: supportReview({
            records: [
              {
                id: "audit-record-1",
                claimId: "claim-1",
                evidenceIds: ["evidence-code-1"],
                verdict: "unsupported",
                rationale: "The excerpt does not entail the claim.",
              },
            ],
          }),
        }),
      ),
    ).not.toThrow();
  });

  it("allows individually direct audit records when their claims conflict", () => {
    const conflict = answer({
      conclusionClaimId: "claim-code",
      reviewStatus: "conflict",
      claims: [
        claim({
          id: "claim-code",
          statement: "The current code enables the worker.",
          evidenceIds: ["evidence-code-1"],
        }),
        claim({
          id: "claim-design",
          statement: "The normative design requires the worker to remain disabled.",
          category: "document_literal",
          evidenceIds: ["evidence-doc-1"],
        }),
      ],
      evidence: [
        projectEvidence(),
        documentEvidence(),
      ],
      unknowns: [
        unknownRecord({
          code: "evidence_conflict",
          claimIds: ["claim-code", "claim-design"],
          evidenceIds: ["evidence-code-1", "evidence-doc-1"],
        }),
      ],
      supportReview: supportReview({
        records: [
          {
            id: "audit-record-code",
            claimId: "claim-code",
            evidenceIds: ["evidence-code-1"],
            verdict: "directly_supported",
            rationale: "The current code excerpt directly supports the code claim.",
          },
          {
            id: "audit-record-design",
            claimId: "claim-design",
            evidenceIds: ["evidence-doc-1"],
            verdict: "directly_supported",
            rationale: "The normative document directly supports the design claim.",
          },
        ],
      }),
    });
    expect(() => EvidenceAnswerSchema.parse(conflict)).not.toThrow();
    expect(() => EvidenceAnswerSchema.parse({ ...conflict, unknowns: [] })).toThrow();
  });

  it("allows stale answers to retain an old all-direct audit", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        staleAnswer({ supportReview: supportReview() }),
      ),
    ).not.toThrow();
  });

  it("allows evidence-free claims only as matching unsupported outcomes", () => {
    for (const category of ["code_fact", "document_literal", "task_decision"] as const) {
      const contextMode = category === "document_literal" ? "document_only" : "task_and_project";
      expect(() =>
        EvidenceAnswerSchema.parse(
          answer({
            contextMode,
            documentPath: category === "document_literal" ? "docs/design.md" : undefined,
            claims: [claim({ category, evidenceIds: [] })],
            evidence: [],
            reviewStatus: "unsupported",
            unknowns: [unknownRecord()],
          }),
        ),
      ).not.toThrow();
    }
  });

  it("allows an empty-evidence inference only as unsupported", () => {
    expect(() => EvidenceAnswerSchema.parse(unsupportedInferenceAnswer())).not.toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        unsupportedInferenceAnswer({ reviewStatus: "citation_validated", unknowns: [] }),
      ),
    ).toThrow();
  });

  it("requires honest details for unsupported, stale, and conflict statuses", () => {
    for (const reviewStatus of ["unsupported", "stale", "conflict"] as const) {
      expect(() =>
        EvidenceAnswerSchema.parse(answer({ reviewStatus, unknowns: [] })),
      ).toThrow();
    }
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({ reviewStatus: "unsupported", unknowns: [unknownRecord()] }),
      ),
    ).not.toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({ reviewStatus: "conflict", unknowns: [unknownRecord()] }),
      ),
    ).toThrow();

    const secondEvidence = projectEvidence({
      id: "evidence-code-2",
      path: "src/worker.ts",
      excerpt: "export function worker() { return legacy(); }",
    });
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          reviewStatus: "conflict",
          claims: [claim({ evidenceIds: ["evidence-code-1", "evidence-code-2"] })],
          evidence: [projectEvidence(), secondEvidence],
          unknowns: [
            unknownRecord({
              code: "evidence_conflict",
              statement: "The API and worker excerpts describe incompatible current flows.",
              evidenceIds: ["evidence-code-1", "evidence-code-2"],
            }),
          ],
        }),
      ),
    ).not.toThrow();

    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          reviewStatus: "stale",
          unknowns: [
            unknownRecord({
              code: "stale_snapshot",
              statement: "The workspace changed after this evidence was issued.",
              evidenceIds: ["evidence-code-1"],
            }),
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("requires inference claims to stay labelled and have evidence or an explicit unknown", () => {
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          claims: [claim({ category: "inference", evidenceIds: [] })],
          evidence: [],
        }),
      ),
    ).toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          claims: [claim({ category: "inference", evidenceIds: [] })],
          evidence: [],
          reviewStatus: "unsupported",
          unknowns: [
            unknownRecord({
              statement: "This inference cannot be verified from the current project.",
            }),
          ],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      EvidenceAnswerSchema.parse(
        answer({
          claims: [claim({ evidenceIds: ["evidence-inference-1"] })],
          evidence: [inferenceEvidence()],
        }),
      ),
    ).toThrow();
  });

  it("rejects malformed support reviews and unknown answer fields", () => {
    expect(() => EvidenceSupportReviewSchema.parse(supportReview({ reviewerNotes: "hidden" }))).toThrow();
    expect(() =>
      CanonicalManifestAttestationSchema.parse(
        canonicalManifestAttestation({ signatureVerified: true }),
      ),
    ).toThrow();
    expect(() => EvidenceAnswerSchema.parse(answer({ prose: "uncited free-form answer" }))).toThrow();
  });
});

describe("model output boundary", () => {
  it("accepts only claim ids, typed claims, and unknowns from the answering model", () => {
    const candidate = {
      conclusionClaimId: "claim-1",
      claims: [claim()],
      unknowns: [],
    };
    expect(ModelAnswerCandidateSchema.parse(candidate)).toEqual(candidate);
    for (const injected of [
      { runId: RUN_ID },
      { generation: GENERATION },
      { candidateDigest: CANDIDATE_DIGEST },
      { reviewStatus: "evidence_reviewed" },
      { contextMode: "task_and_project" },
      { evidence: [projectEvidence()] },
      { snapshotDigest: SNAPSHOT_DIGEST },
      { supportReview: supportReview() },
      { canonicalManifestAttestations: [canonicalManifestAttestation()] },
    ]) {
      expect(() => ModelAnswerCandidateSchema.parse({ ...candidate, ...injected })).toThrow();
    }
  });

  it("rejects model-minted raw citation locators on claims", () => {
    expect(() =>
      ModelAnswerCandidateSchema.parse({
        conclusionClaimId: "claim-1",
        claims: [claim({ path: "src/api.ts", startLine: 1, endLine: 4 })],
        unknowns: [],
      }),
    ).toThrow();
  });

  it("uses a strict answer-or-bounded-evidence-request union", () => {
    expect(() =>
      ModelQuestionOutputSchema.parse({
        kind: "answer",
        answer: {
          conclusionClaimId: "claim-1",
          claims: [claim()],
          unknowns: [],
        },
      }),
    ).not.toThrow();
    expect(() =>
      EvidenceExpansionRequestSchema.parse({
        query: "worker entry point",
        reason: "The issued packet does not contain the worker implementation.",
        requestedKinds: ["code_excerpt", "test_excerpt"],
      }),
    ).not.toThrow();
    expect(() =>
      ModelQuestionOutputSchema.parse({
        kind: "evidence_request",
        request: {
          query: "worker entry point",
          reason: "Need more evidence.",
          requestedKinds: ["code_excerpt"],
          path: "src/worker.ts",
        },
      }),
    ).toThrow();
  });
});

describe("reader session", () => {
  it("rejects caller-controlled task ids, roots, unsafe document paths, and unknown keys", () => {
    const base = {
      id: "session-1",
      bindingStatus: "verified",
      contextMode: "task_and_project",
      rootId: "root-1",
      workspaceLabel: "repo",
      documentPath: "README.md",
    };
    expect(() => ReaderSessionSchema.parse({ ...base, parentThreadId: "thread-secret" })).toThrow();
    expect(() => ReaderSessionSchema.parse({ ...base, rootId: "C:\\private\\repo" })).toThrow();
    expect(() => ReaderSessionSchema.parse({ ...base, workspaceLabel: "C:\\private\\repo" })).toThrow();
    expect(() => ReaderSessionSchema.parse({ ...base, documentPath: "../README.md" })).toThrow();
    expect(() => ReaderSessionSchema.parse({ ...base, workspaceRoot: "C:\\private\\repo" })).toThrow();
  });

  it("does not claim task context for an unverified binding", () => {
    expect(() =>
      ReaderSessionSchema.parse({
        id: "session-1",
        bindingStatus: "unavailable",
        contextMode: "task_and_project",
        rootId: "root-1",
        workspaceLabel: "repo",
        documentPath: "README.md",
      }),
    ).toThrow();
  });
});

describe("question run protocol", () => {
  it("requires canonical millisecond-precision ISO event timestamps", () => {
    expect(() => QuestionRunEventSchema.parse(event(1))).not.toThrow();
    expect(() =>
      QuestionRunEventSchema.parse(event(1, "progress", undefined, {
        createdAt: "2026-09-01T12:00:00Z",
      })),
    ).toThrow();
    expect(() =>
      QuestionRunEventSchema.parse(event(1, "progress", undefined, {
        createdAt: "2026-09-01T12:00:00.000001Z",
      })),
    ).toThrow();
  });

  it("validates strict single-event variants and terminal payloads", () => {
    expect(() => QuestionRunEventSchema.parse(event(1))).not.toThrow();
    expect(() =>
      QuestionRunEventSchema.parse(
        event(2, "text_delta", { text: "Unverified draft", unverified: true }),
      ),
    ).toThrow();
    expect(() =>
      QuestionRunEventSchema.parse(
        event(3, "completed", { status: "completed", answer: answer() }),
      ),
    ).not.toThrow();
    expect(() =>
      QuestionRunEventSchema.parse(event(3, "failed", { status: "completed", code: "FAILED", message: "Bad", retryable: true })),
    ).toThrow();
  });

  it("binds a completed event to its answer run and generation", () => {
    expect(() =>
      QuestionRunEventSchema.parse(
        event(1, "completed", { status: "completed", answer: answer() }, { runId: "run-2" }),
      ),
    ).toThrow();
    expect(() =>
      QuestionRunEventSchema.parse(
        event(
          1,
          "completed",
          { status: "completed", answer: answer() },
          { generation: "generation-2" },
        ),
      ),
    ).toThrow();
  });

  it("keeps completed and stale terminal answer states consistent", () => {
    expect(() =>
      QuestionRunEventSchema.parse(
        event(1, "completed", { status: "completed", answer: staleAnswer() }),
      ),
    ).toThrow();
    expect(() =>
      QuestionRunEventSchema.parse(
        event(1, "completed", { status: "completed", answer: unsupportedInferenceAnswer() }),
      ),
    ).not.toThrow();
    expect(() =>
      QuestionRunEventSchema.parse(
        event(1, "stale", {
          status: "stale",
          reason: "Workspace changed.",
          retryable: true,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      QuestionRunEventSchema.parse(
        event(1, "stale", {
          status: "stale",
          reason: "Workspace changed.",
          retryable: true,
          answer: staleAnswer(),
        }),
      ),
    ).not.toThrow();
    expect(() =>
      QuestionRunEventSchema.parse(
        event(1, "stale", {
          status: "stale",
          reason: "Workspace changed.",
          retryable: true,
          answer: answer(),
        }),
      ),
    ).toThrow();
  });

  it("requires a positive sequence and rejects unknown event or payload fields", () => {
    expect(() => QuestionRunEventSchema.parse(event(0))).toThrow();
    expect(() => QuestionRunEventSchema.parse(event(1, "invented", {}))).toThrow();
    expect(() => QuestionRunEventSchema.parse(event(1, "progress", { status: "inspecting", message: "ok", secret: "x" }))).toThrow();
    expect(() => QuestionRunEventSchema.parse(event(1, "progress", { status: "inspecting", message: "ok" }, { parentThreadId: "secret" }))).toThrow();
  });

  it("validates strict cursors", () => {
    expect(QuestionRunCursorSchema.parse({ runId: "run-1", generation: "generation-1", sequence: 2 })).toEqual({
      runId: "run-1",
      generation: "generation-1",
      sequence: 2,
    });
    expect(() => QuestionRunCursorSchema.parse({ runId: "run-1", generation: "generation-1", sequence: -1 })).toThrow();
    expect(() => QuestionRunCursorSchema.parse({ runId: "run-1", generation: "generation-1", sequence: 0 })).toThrow();
    expect(() => QuestionRunCursorSchema.parse({ generation: "generation-1", sequence: 1 })).toThrow();
    expect(() => QuestionRunCursorSchema.parse({ runId: "run-1", generation: "generation-1", sequence: 1, parentThreadId: "secret" })).toThrow();
  });

  it("accepts a same-generation sequence beginning at one", () => {
    const events = [
      event(1),
      event(2, "progress", { status: "validating", message: "Validating structured output." }),
      event(3, "completed", { status: "completed", answer: answer() }),
    ];
    expect(QuestionRunEventSequenceSchema.parse(events)).toHaveLength(3);
    expect(validateQuestionRunEventSequence(events)).toEqual(events);
    expect(CompletedQuestionRunEventSequenceSchema.parse(events)).toHaveLength(3);
  });

  it("deduplicates identical replay but rejects gaps, mixed generations, mixed runs, and multiple terminals", () => {
    expect(QuestionRunEventSequenceSchema.parse([event(1), event(1)])).toHaveLength(1);
    expect(() => QuestionRunEventSequenceSchema.parse([event(1), event(3)])).toThrow();
    expect(() => QuestionRunEventSequenceSchema.parse([event(1), event(2, "progress", { status: "inspecting", message: "x" }, { generation: "generation-2" })])).toThrow();
    expect(() => QuestionRunEventSequenceSchema.parse([event(1), event(2, "progress", { status: "inspecting", message: "x" }, { runId: "run-2" })])).toThrow();
    expect(() =>
      QuestionRunEventSequenceSchema.parse([
        event(1),
        event(2, "failed", { status: "failed", code: "MODEL_FAILED", message: "Failed.", retryable: true }),
        event(3, "cancelled", { status: "cancelled", reason: "Cancelled." }),
      ]),
    ).toThrow();
  });

  it("treats only byte-for-byte-equivalent event replay as idempotent", () => {
    const original = event(1);
    expect(normalizeQuestionRunEventReplay([original, { ...original }])).toEqual([original]);
    expect(() =>
      normalizeQuestionRunEventReplay([
        original,
        event(1, "progress", { status: "inspecting", message: "Different payload." }),
      ]),
    ).toThrow();
  });

  it("rejects events after a terminal and can require a terminal for a completed history", () => {
    expect(() =>
      QuestionRunEventSequenceSchema.parse([
        event(1, "cancelled", { status: "cancelled", reason: "Cancelled." }),
        event(2),
      ]),
    ).toThrow();
    expect(() => CompletedQuestionRunEventSequenceSchema.parse([event(1)])).toThrow();
  });

  it("bounds a generation history to 512 raw events", () => {
    expect(() =>
      QuestionRunEventSequenceSchema.parse(
        Array.from({ length: 513 }, (_, index) => event(index + 1)),
      ),
    ).toThrow();
  });

  it("applies the event history budget to UTF-8 JSON bytes, not JavaScript characters", () => {
    const events = Array.from({ length: 180 }, (_, index) =>
      event(index + 1, "progress", { status: "inspecting", message: "界".repeat(2_048) }),
    );
    expect(JSON.stringify(events).length).toBeLessThan(1_048_576);
    expect(new TextEncoder().encode(JSON.stringify(events)).byteLength).toBeGreaterThan(1_048_576);
    expect(() => QuestionRunEventSequenceSchema.parse(events)).toThrow();
  });

  it("validates an event page continuously after an arbitrary cursor", () => {
    const cursor = { runId: RUN_ID, generation: GENERATION, sequence: 5 };
    const page = {
      outcome: "events",
      runId: RUN_ID,
      generation: GENERATION,
      cursor,
      nextCursor: { runId: RUN_ID, generation: GENERATION, sequence: 7 },
      events: [event(6), event(7)],
    };
    expect(QuestionRunPageSchema.parse(page)).toEqual(page);
    expect(() =>
      QuestionRunPageSchema.parse({
        ...page,
        cursor: null,
        nextCursor: { runId: RUN_ID, generation: GENERATION, sequence: 1 },
        events: [event(1)],
      }),
    ).not.toThrow();
    expect(() => QuestionRunPageSchema.parse({ ...page, events: [event(7)] })).toThrow();
    expect(() =>
      QuestionRunPageSchema.parse({
        ...page,
        events: [event(6, "progress", undefined, { runId: "run-2" })],
      }),
    ).toThrow();
    expect(() =>
      QuestionRunPageSchema.parse({
        ...page,
        nextCursor: { runId: RUN_ID, generation: GENERATION, sequence: 6 },
      }),
    ).toThrow();
  });

  it("folds exact page replay but rejects conflicting replay before returning it", () => {
    const cursor = { runId: RUN_ID, generation: GENERATION, sequence: 5 };
    const first = event(6);
    const base = {
      outcome: "events",
      runId: RUN_ID,
      generation: GENERATION,
      cursor,
      nextCursor: { runId: RUN_ID, generation: GENERATION, sequence: 6 },
    };
    const parsed = QuestionRunPageSchema.parse({ ...base, events: [first, { ...first }] });
    expect(parsed.outcome).toBe("events");
    if (parsed.outcome !== "events") throw new Error("Expected an events page");
    expect(parsed.events).toEqual([first]);
    expect(() =>
      QuestionRunPageSchema.parse({
        ...base,
        events: [
          first,
          event(6, "progress", { status: "inspecting", message: "Different." }),
        ],
      }),
    ).toThrow();
  });

  it("budgets the raw event page before idempotent replay is folded", () => {
    const cursor = { runId: RUN_ID, generation: GENERATION, sequence: 5 };
    const largeEvent = event(6, "progress", {
      status: "inspecting",
      message: "界".repeat(2_048),
    });
    const page = {
      outcome: "events",
      runId: RUN_ID,
      generation: GENERATION,
      cursor,
      nextCursor: { runId: RUN_ID, generation: GENERATION, sequence: 6 },
      events: Array.from({ length: 180 }, () => ({ ...largeEvent })),
    };
    expect(JSON.stringify(page).length).toBeLessThan(1_048_576);
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeGreaterThan(1_048_576);
    expect(() => QuestionRunPageSchema.parse(page)).toThrow();
  });

  it("uses strict structured outcomes for generation changes, expired cursors, and gaps", () => {
    const generationChanged = {
      outcome: "GENERATION_CHANGED",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: { runId: RUN_ID, generation: "generation-old", sequence: 9 },
      currentCursor: { runId: RUN_ID, generation: GENERATION, sequence: 2 },
    };
    const expired = {
      outcome: "CURSOR_EXPIRED",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: { runId: RUN_ID, generation: GENERATION, sequence: 2 },
      oldestAvailableCursor: { runId: RUN_ID, generation: GENERATION, sequence: 5 },
      currentCursor: { runId: RUN_ID, generation: GENERATION, sequence: 9 },
    };
    const gap = {
      outcome: "CURSOR_GAP",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: { runId: RUN_ID, generation: GENERATION, sequence: 5 },
      expectedSequence: 6,
      actualSequence: 8,
    };
    expect(() => QuestionRunPageSchema.parse(generationChanged)).not.toThrow();
    expect(() => QuestionRunPageSchema.parse(expired)).not.toThrow();
    expect(() => QuestionRunPageSchema.parse(gap)).not.toThrow();
    expect(() => QuestionRunPageSchema.parse("CURSOR_GAP")).toThrow();
    expect(() => QuestionRunPageSchema.parse({ ...gap, actualSequence: 6 })).toThrow();
    expect(() =>
      QuestionRunPageSchema.parse({
        ...expired,
        oldestAvailableCursor: { runId: RUN_ID, generation: GENERATION, sequence: 1 },
      }),
    ).toThrow();
    for (const outcome of [generationChanged, expired, gap]) {
      expect(() => QuestionRunPageSchema.parse({ ...outcome, parentThreadId: "secret" })).toThrow();
    }
  });

  it("allows generation change before the client has received its first event", () => {
    const initial = {
      phase: "active",
      runId: RUN_ID,
      generation: "generation-old",
      cursor: null,
      terminalSequence: null,
    };
    const page = {
      outcome: "GENERATION_CHANGED",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: null,
      currentCursor: null,
    };
    expect(() => QuestionRunPageSchema.parse(page)).not.toThrow();
    expect(advanceQuestionRunPageTransition(initial, page)).toEqual({
      phase: "generation_changed",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: null,
      terminalSequence: null,
    });
    expect(() =>
      advanceQuestionRunPageTransition(
        { ...initial, generation: GENERATION },
        page,
      ),
    ).toThrow();
    expect(() =>
      QuestionRunPageSchema.parse({
        ...page,
        cursor: { runId: "run-other", generation: "generation-old", sequence: 1 },
      }),
    ).toThrow();
    expect(() =>
      QuestionRunPageSchema.parse({
        ...page,
        cursor: { runId: RUN_ID, generation: GENERATION, sequence: 1 },
      }),
    ).toThrow();
  });

  it("validates a strict initial poll state", () => {
    const initial = {
      phase: "active",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: null,
      terminalSequence: null,
    };
    expect(QuestionRunPollStateSchema.parse(initial)).toEqual(initial);
    expect(() =>
      QuestionRunPollStateSchema.parse({ ...initial, parentThreadId: "secret" }),
    ).toThrow();
    expect(() =>
      QuestionRunPollStateSchema.parse({ ...initial, phase: "terminal", terminalSequence: 1 }),
    ).toThrow();
  });

  it("advances normal pages and preserves exact replay idempotence", () => {
    const initial = QuestionRunPollStateSchema.parse({
      phase: "active",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: null,
      terminalSequence: null,
    });
    const firstEvent = event(1);
    const afterFirst = advanceQuestionRunPageTransition(initial, {
      outcome: "events",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: null,
      nextCursor: { runId: RUN_ID, generation: GENERATION, sequence: 1 },
      events: [firstEvent, { ...firstEvent }],
    });
    expect(afterFirst).toEqual({
      ...initial,
      cursor: { runId: RUN_ID, generation: GENERATION, sequence: 1 },
    });
    expect(
      advanceQuestionRunPageTransition(afterFirst, {
        outcome: "events",
        runId: RUN_ID,
        generation: GENERATION,
        cursor: afterFirst.cursor,
        nextCursor: { runId: RUN_ID, generation: GENERATION, sequence: 2 },
        events: [event(2)],
      }),
    ).toEqual({
      ...initial,
      cursor: { runId: RUN_ID, generation: GENERATION, sequence: 2 },
    });
  });

  it("rejects every cross-page event after a terminal but accepts an empty terminal poll", () => {
    const initial = {
      phase: "active",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: null,
      terminalSequence: null,
    };
    const failedPage = {
      outcome: "events",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: null,
      nextCursor: { runId: RUN_ID, generation: GENERATION, sequence: 1 },
      events: [
        event(1, "failed", {
          status: "failed",
          code: "MODEL_FAILED",
          message: "The model failed.",
          retryable: true,
        }),
      ],
    };
    const terminalState = advanceQuestionRunPageTransition(initial, failedPage);
    expect(terminalState).toEqual({
      phase: "terminal",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: { runId: RUN_ID, generation: GENERATION, sequence: 1 },
      terminalSequence: 1,
    });

    const progressAfterTerminal = {
      outcome: "events",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: terminalState.cursor,
      nextCursor: { runId: RUN_ID, generation: GENERATION, sequence: 2 },
      events: [event(2)],
    };
    const secondTerminal = {
      ...progressAfterTerminal,
      events: [event(2, "cancelled", { status: "cancelled", reason: "Too late." })],
    };
    expect(() => QuestionRunPageSchema.parse(progressAfterTerminal)).not.toThrow();
    expect(() => QuestionRunPageSchema.parse(secondTerminal)).not.toThrow();
    expect(() =>
      advanceQuestionRunPageTransition(terminalState, progressAfterTerminal),
    ).toThrow();
    expect(() => advanceQuestionRunPageTransition(terminalState, secondTerminal)).toThrow();

    expect(
      advanceQuestionRunPageTransition(terminalState, {
        outcome: "events",
        runId: RUN_ID,
        generation: GENERATION,
        cursor: terminalState.cursor,
        nextCursor: terminalState.cursor,
        events: [],
      }),
    ).toEqual(terminalState);
  });

  it("halts polling on non-event outcomes until the caller explicitly resets state", () => {
    const active = {
      phase: "active",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: { runId: RUN_ID, generation: GENERATION, sequence: 1 },
      terminalSequence: null,
    };
    const generationChanged = advanceQuestionRunPageTransition(active, {
      outcome: "GENERATION_CHANGED",
      runId: RUN_ID,
      generation: "generation-2",
      cursor: active.cursor,
      currentCursor: null,
    });
    expect(generationChanged).toEqual({
      phase: "generation_changed",
      runId: RUN_ID,
      generation: "generation-2",
      cursor: null,
      terminalSequence: null,
    });

    const expired = advanceQuestionRunPageTransition(active, {
      outcome: "CURSOR_EXPIRED",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: active.cursor,
      oldestAvailableCursor: { runId: RUN_ID, generation: GENERATION, sequence: 2 },
      currentCursor: { runId: RUN_ID, generation: GENERATION, sequence: 4 },
    });
    expect(expired.phase).toBe("cursor_expired");

    const gap = advanceQuestionRunPageTransition(active, {
      outcome: "CURSOR_GAP",
      runId: RUN_ID,
      generation: GENERATION,
      cursor: active.cursor,
      expectedSequence: 2,
      actualSequence: 4,
    });
    expect(gap.phase).toBe("cursor_gap");

    const normalNewGenerationPage = {
      outcome: "events",
      runId: RUN_ID,
      generation: "generation-2",
      cursor: null,
      nextCursor: { runId: RUN_ID, generation: "generation-2", sequence: 1 },
      events: [event(1, "progress", undefined, { generation: "generation-2" })],
    };
    expect(() =>
      advanceQuestionRunPageTransition(generationChanged, normalNewGenerationPage),
    ).toThrow();
  });
});

describe("annotation and edit contracts", () => {
  it("bounds evidence answers by UTF-8 JSON bytes", () => {
    const oversized = largeEvidenceAnswer(22);
    expect(JSON.stringify(oversized).length).toBeLessThan(1_048_576);
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(1_048_576);
    expect(() => EvidenceAnswerSchema.parse(oversized)).toThrow();
    expect(() => EvidenceAnswerSchema.parse(largeEvidenceAnswer(13))).not.toThrow();
  });

  it("bounds annotation question count and aggregate UTF-8 JSON bytes", () => {
    const thread = {
      id: "annotation-large",
      sessionId: "session-1",
      anchor: sourceAnchor(),
      disposition: "reading_only",
      stale: false,
    };
    const queuedQuestions = Array.from({ length: 65 }, (_, index) => ({
      id: `question-${index}`,
      question: "Bounded?",
      runId: `run-${index}`,
      generation: `generation-${index}`,
      status: "queued",
      createdAt: CREATED_AT,
    }));
    expect(() => AnnotationThreadSchema.parse({ ...thread, questions: queuedQuestions })).toThrow();

    const firstAnswer = largeEvidenceAnswer(13, "run-large-1", "generation-large-1", "one");
    const secondAnswer = largeEvidenceAnswer(13, "run-large-2", "generation-large-2", "two");
    const questions = [firstAnswer, secondAnswer].map((largeAnswer, index) => ({
      id: `large-question-${index}`,
      question: "界😀 evidence?",
      runId: largeAnswer.runId,
      generation: largeAnswer.generation,
      status: "completed",
      createdAt: CREATED_AT,
      answer: largeAnswer,
    }));
    const oversized = { ...thread, questions };
    expect(JSON.stringify(oversized).length).toBeLessThan(1_048_576);
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(1_048_576);
    expect(() => AnnotationThreadSchema.parse(oversized)).toThrow();
  });

  it("validates a strict question record and annotation thread", () => {
    const question = QuestionRecordSchema.parse({
      id: "question-1",
      question: "Where does the request enter?",
      runId: "run-1",
      generation: "generation-1",
      status: "completed",
      createdAt: CREATED_AT,
      answer: answer(),
    });
    expect(() =>
      AnnotationThreadSchema.parse({
        id: "annotation-1",
        sessionId: "session-1",
        anchor: sourceAnchor(),
        questions: [question],
        disposition: "reading_only",
        stale: false,
      }),
    ).not.toThrow();
    expect(() => QuestionRecordSchema.parse({ ...question, rawThreadId: "secret" })).toThrow();
  });

  it("rejects duplicate question ids or run ids in an annotation thread", () => {
    const first = {
      id: "question-1",
      question: "Where does the request enter?",
      runId: "run-1",
      generation: "generation-1",
      status: "queued",
      createdAt: CREATED_AT,
    };
    const thread = {
      id: "annotation-1",
      sessionId: "session-1",
      anchor: sourceAnchor(),
      disposition: "reading_only",
      stale: false,
    };
    expect(() =>
      AnnotationThreadSchema.parse({
        ...thread,
        questions: [first, { ...first, runId: "run-2", generation: "generation-2" }],
      }),
    ).toThrow();
    expect(() =>
      AnnotationThreadSchema.parse({
        ...thread,
        questions: [first, { ...first, id: "question-2", question: "Follow up?" }],
      }),
    ).toThrow();
  });

  it("requires completed question records to contain a durable answer only", () => {
    const base = {
      id: "question-1",
      question: "Where does the request enter?",
      runId: "run-1",
      createdAt: CREATED_AT,
    };
    expect(() => QuestionRecordSchema.parse({ ...base, status: "completed" })).toThrow();
    expect(() => QuestionRecordSchema.parse({ ...base, status: "inspecting", answer: answer() })).toThrow();
  });

  it("binds non-draft question records to a generation and keeps stale state consistent", () => {
    const base = {
      id: "question-1",
      question: "Where does the request enter?",
      runId: "run-1",
      createdAt: CREATED_AT,
    };
    expect(() => QuestionRecordSchema.parse({ ...base, status: "queued" })).toThrow();
    expect(() =>
      QuestionRecordSchema.parse({
        ...base,
        generation: "generation-1",
        status: "stale",
      }),
    ).not.toThrow();
    expect(() =>
      QuestionRecordSchema.parse({
        ...base,
        generation: "generation-1",
        status: "stale",
        answer: answer(),
      }),
    ).toThrow();
    expect(() =>
      QuestionRecordSchema.parse({
        ...base,
        generation: "generation-1",
        status: "stale",
        answer: answer({
          reviewStatus: "stale",
          unknowns: [
            unknownRecord({
              code: "stale_snapshot",
              statement: "The workspace changed after evidence issuance.",
              evidenceIds: ["evidence-code-1"],
            }),
          ],
        }),
      }),
    ).not.toThrow();
  });

  it("binds durable question answers to the record run and generation", () => {
    const completed = {
      id: "question-1",
      question: "Where does the request enter?",
      runId: "run-2",
      generation: GENERATION,
      status: "completed",
      createdAt: CREATED_AT,
      answer: answer(),
    };
    expect(() => QuestionRecordSchema.parse(completed)).toThrow();
    expect(() =>
      QuestionRecordSchema.parse({
        ...completed,
        runId: RUN_ID,
        generation: "generation-2",
      }),
    ).toThrow();

    const stale = answer({
      reviewStatus: "stale",
      unknowns: [
        unknownRecord({
          code: "stale_snapshot",
          statement: "The workspace changed after evidence issuance.",
          evidenceIds: ["evidence-code-1"],
        }),
      ],
    });
    expect(() =>
      QuestionRecordSchema.parse({
        ...completed,
        status: "stale",
        answer: stale,
      }),
    ).toThrow();
  });

  it("does not store a stale answer as a completed question", () => {
    expect(() =>
      QuestionRecordSchema.parse({
        id: "question-1",
        question: "Where does the request enter?",
        runId: RUN_ID,
        generation: GENERATION,
        status: "completed",
        createdAt: CREATED_AT,
        answer: staleAnswer(),
      }),
    ).toThrow();
    expect(() =>
      QuestionRecordSchema.parse({
        id: "question-1",
        question: "Can this be verified?",
        runId: RUN_ID,
        generation: GENERATION,
        status: "completed",
        createdAt: CREATED_AT,
        answer: unsupportedInferenceAnswer(),
      }),
    ).not.toThrow();
  });

  it("validates strict edit intents and rejects unsafe or empty content", () => {
    const intent = {
      annotationId: "annotation-1",
      operation: "insert_after",
      targetAnchor: sourceAnchor(),
      markdown: "\n\nThe API enters through `src/api.ts`.",
      rationale: "Adds the evidence-reviewed explanation.",
      evidenceIds: ["evidence-code-1"],
    };
    expect(() => EditIntentSchema.parse(intent)).not.toThrow();
    expect(() => EditIntentSchema.parse({ ...intent, markdown: " " })).toThrow();
    expect(() => EditIntentSchema.parse({ ...intent, rationale: " " })).toThrow();
    expect(() => EditIntentSchema.parse({ ...intent, evidenceIds: [] })).toThrow();
    expect(() => EditIntentSchema.parse({ ...intent, parentThreadId: "secret" })).toThrow();
  });

  it("requires one synthesis outcome per annotation", () => {
    const intent = EditIntentSchema.parse({
      annotationId: "annotation-1",
      operation: "insert_after",
      targetAnchor: sourceAnchor(),
      markdown: "\n\nExplanation.",
      rationale: "Adds accepted content.",
      evidenceIds: ["evidence-code-1"],
    });
    expect(() => EditIntentBatchSchema.parse({ intents: [intent], conflicts: [] })).not.toThrow();
    expect(() => EditIntentBatchSchema.parse({ intents: [intent, intent], conflicts: [] })).toThrow();
    expect(() =>
      EditIntentBatchSchema.parse({
        intents: [intent],
        conflicts: [
          {
            annotationId: "annotation-1",
            reason: "The target is ambiguous.",
          },
        ],
      }),
    ).toThrow();
  });
});
