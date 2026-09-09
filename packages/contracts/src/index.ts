import { z } from "zod";
export * from "./side-question.js";
export * from "./architecture.js";

const MAX_ID_LENGTH = 160;
const MAX_PATH_LENGTH = 1_024;
const MAX_TEXT_LENGTH = 16_384;
const MAX_STATEMENT_LENGTH = 8_192;
const MAX_COLLECTION_LENGTH = 256;
const MAX_EVENT_WINDOW_LENGTH = 512;
const MAX_EVENT_WINDOW_BYTES = 1_048_576;
const MAX_EVIDENCE_ANSWER_BYTES = 1_048_576;
const MAX_ANNOTATION_QUESTIONS = 64;
const MAX_ANNOTATION_THREAD_BYTES = 1_048_576;
const UTF8_ENCODER = new TextEncoder();

function jsonUtf8ByteLength(value: unknown): number {
  return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function isSafeRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    /[\p{Cc}\p{Cs}]/u.test(value)
  ) {
    return false;
  }

  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function isSyntacticallyAbsolutePath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PATH_LENGTH || value.includes("\0")) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/");
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) {
    return false;
  }
  return normalized
    .split("/")
    .filter((segment) => segment.length > 0 && !/^[A-Za-z]:$/.test(segment))
    .every((segment) => segment !== "." && segment !== "..");
}

const NonBlankTextSchema = z
  .string()
  .min(1)
  .max(MAX_TEXT_LENGTH)
  .refine((value) => value.trim().length > 0, "Text must not be blank");

const StatementSchema = z
  .string()
  .min(1)
  .max(MAX_STATEMENT_LENGTH)
  .refine((value) => value.trim().length > 0, "Statement must not be blank");

export const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._~-]*$/,
    "Opaque ids must not contain whitespace, path separators, or drive prefixes",
  );

export const Sha256DigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest");

export const RelativePathSchema = z
  .string()
  .refine(isSafeRelativePath, "Expected a normalized relative path without traversal");

const CreatedAtSchema = z.iso.datetime({ offset: true, precision: 3 }).max(35);
const UniqueIdsSchema = z
  .array(OpaqueIdSchema)
  .max(MAX_COLLECTION_LENGTH)
  .superRefine((values, context) => {
    if (hasDuplicates(values)) {
      context.addIssue({
        code: "custom",
        message: "Ids must be unique",
      });
    }
  });

export const BindingStatusSchema = z.enum([
  "verified",
  "unavailable",
  "mismatch",
  "stale",
]);

export const ContextModeSchema = z.enum([
  "task_and_project",
  "project_only",
  "document_only",
]);

export const EvidenceKindSchema = z.enum([
  "code_excerpt",
  "test_excerpt",
  "project_document",
  "task_decision",
  "inference",
]);

export const ClaimCategorySchema = z.enum([
  "code_fact",
  "architecture",
  "cross_module_flow",
  "configuration",
  "document_literal",
  "task_decision",
  "inference",
]);

export const AnswerReviewStatusSchema = z.enum([
  "citation_validated",
  "evidence_reviewed",
  "stale",
  "unsupported",
  "conflict",
]);

export const DispositionSchema = z.enum([
  "reading_only",
  "inline",
  "replace",
  "glossary",
  "faq",
  "ignore",
]);

export const EditOperationSchema = z.enum([
  "insert_after",
  "replace",
  "append_section",
]);

export const QuestionRunStatusSchema = z.enum([
  "draft",
  "queued",
  "inspecting",
  "streaming_unverified",
  "validating",
  "completed",
  "stale",
  "failed",
  "cancelled",
]);

const WorkspaceSnapshotStateFields = {
  branch: NonBlankTextSchema.max(512).nullable(),
  head: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "Expected a commit digest")
    .nullable(),
  dirtyStateDigest: Sha256DigestSchema,
  createdAt: CreatedAtSchema,
} as const;

export const WorkspaceSnapshotRefSchema = z
  .object({
    rootId: OpaqueIdSchema,
    ...WorkspaceSnapshotStateFields,
  })
  .strict();

/** Public snapshot metadata uses only an opaque root reference. */
export const WorkspaceSnapshotSchema = WorkspaceSnapshotRefSchema;

/**
 * Trusted services use the canonical project root for reads and snapshot
 * composition. Syntactic validation here cannot prove realpath or symlink
 * containment; the workspace service must do that before constructing it.
 */
export const InternalWorkspaceSnapshotSchema = z
  .object({
    projectRoot: z
      .string()
      .refine(isSyntacticallyAbsolutePath, "Expected a syntactically absolute canonical path"),
    ...WorkspaceSnapshotStateFields,
  })
  .strict();

export const SourceAnchorSchema = z
  .object({
    documentPath: RelativePathSchema,
    documentHash: Sha256DigestSchema,
    headingPath: z
      .array(NonBlankTextSchema.max(512))
      .max(64),
    selectedText: z.string().max(MAX_TEXT_LENGTH),
    prefix: z.string().max(MAX_TEXT_LENGTH),
    suffix: z.string().max(MAX_TEXT_LENGTH),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((anchor, context) => {
    if (anchor.selectedText.length === 0 || anchor.selectedText.trim().length === 0) {
      context.addIssue({
        code: "custom",
        path: ["selectedText"],
        message: "An anchor needs selected text for relocation",
      });
    }
    if (anchor.endOffset <= anchor.startOffset) {
      context.addIssue({
        code: "custom",
        path: ["endOffset"],
        message: "endOffset must be greater than startOffset",
      });
    }
  });

const ProjectEvidenceProvenanceSchema = z
  .object({
    issuer: z.literal("workspace_service"),
    packetId: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema,
  })
  .strict();

const TaskEvidenceProvenanceSchema = z
  .object({
    issuer: z.literal("context_bridge"),
    packetId: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema,
  })
  .strict();

const InferenceEvidenceProvenanceSchema = z
  .object({
    issuer: z.literal("answer_service"),
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema,
  })
  .strict();

const ProjectEvidenceFields = {
  id: OpaqueIdSchema,
  path: RelativePathSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  excerpt: NonBlankTextSchema,
  excerptHash: Sha256DigestSchema,
  fileHash: Sha256DigestSchema,
  snapshotDigest: Sha256DigestSchema,
  provenance: ProjectEvidenceProvenanceSchema,
} as const;

const CodeExcerptEvidenceSchema = z
  .object({
    ...ProjectEvidenceFields,
    kind: z.literal("code_excerpt"),
  })
  .strict();

const TestExcerptEvidenceSchema = z
  .object({
    ...ProjectEvidenceFields,
    kind: z.literal("test_excerpt"),
  })
  .strict();

const ProjectDocumentEvidenceSchema = z
  .object({
    ...ProjectEvidenceFields,
    kind: z.literal("project_document"),
    heading: NonBlankTextSchema.max(1_024).optional(),
  })
  .strict();

const TaskDecisionEvidenceSchema = z
  .object({
    id: OpaqueIdSchema,
    kind: z.literal("task_decision"),
    sourceRef: OpaqueIdSchema,
    excerpt: NonBlankTextSchema,
    excerptHash: Sha256DigestSchema,
    snapshotDigest: Sha256DigestSchema,
    provenance: TaskEvidenceProvenanceSchema,
  })
  .strict();

const InferenceEvidenceSchema = z
  .object({
    id: OpaqueIdSchema,
    kind: z.literal("inference"),
    rationale: StatementSchema,
    basisEvidenceIds: UniqueIdsSchema.min(1),
    snapshotDigest: Sha256DigestSchema,
    provenance: InferenceEvidenceProvenanceSchema,
  })
  .strict();

/**
 * This union proves only DTO shape. Runtime packet membership, canonical-path
 * containment, and excerpt/hash authenticity remain trusted-service checks.
 */
export const EvidenceReferenceSchema = z
  .discriminatedUnion("kind", [
    CodeExcerptEvidenceSchema,
    TestExcerptEvidenceSchema,
    ProjectDocumentEvidenceSchema,
    TaskDecisionEvidenceSchema,
    InferenceEvidenceSchema,
  ])
  .superRefine((evidence, context) => {
    if (
      evidence.kind !== "task_decision" &&
      evidence.kind !== "inference" &&
      evidence.endLine < evidence.startLine
    ) {
      context.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "endLine must be greater than or equal to startLine",
      });
    }
    if (
      evidence.kind === "inference" &&
      evidence.basisEvidenceIds.includes(evidence.id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["basisEvidenceIds"],
        message: "Inference evidence cannot cite itself",
      });
    }
  });

export const AnswerClaimSchema = z
  .object({
    id: OpaqueIdSchema,
    statement: StatementSchema,
    category: ClaimCategorySchema,
    evidenceIds: UniqueIdsSchema,
  })
  .strict();

export const AnswerUnknownCodeSchema = z.enum([
  "not_inspected",
  "missing_evidence",
  "unsupported_claim",
  "stale_snapshot",
  "evidence_conflict",
  "unresolved",
]);

export const AnswerUnknownSchema = z
  .object({
    id: OpaqueIdSchema,
    code: AnswerUnknownCodeSchema,
    statement: StatementSchema,
    claimIds: UniqueIdsSchema.min(1),
    evidenceIds: UniqueIdsSchema,
  })
  .strict()
  .superRefine((unknown, context) => {
    if (unknown.code === "evidence_conflict" && unknown.evidenceIds.length < 2) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: "An evidence conflict must identify both sides",
      });
    }
    if (unknown.code === "stale_snapshot" && unknown.evidenceIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: "A stale snapshot issue must identify affected evidence",
      });
    }
  });

export const EvidenceSupportVerdictSchema = z.enum([
  "directly_supported",
  "partially_supported",
  "unsupported",
]);

export const EvidenceSupportRecordSchema = z
  .object({
    id: OpaqueIdSchema,
    claimId: OpaqueIdSchema,
    evidenceIds: UniqueIdsSchema.min(1),
    verdict: EvidenceSupportVerdictSchema,
    rationale: StatementSchema,
  })
  .strict();

/**
 * The literal reviewer marker records the trusted orchestration result. This
 * schema cannot establish that a model turn was actually clean or independent.
 */
export const EvidenceSupportReviewSchema = z
  .object({
    id: OpaqueIdSchema,
    reviewer: z.literal("independent_model"),
    modelAssisted: z.literal(true),
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema,
    candidateDigest: Sha256DigestSchema,
    snapshotDigest: Sha256DigestSchema,
    records: z.array(EvidenceSupportRecordSchema).min(1).max(MAX_COLLECTION_LENGTH),
  })
  .strict()
  .superRefine((review, context) => {
    const recordIds = review.records.map((record) => record.id);
    const claimIds = review.records.map((record) => record.claimId);
    if (hasDuplicates(recordIds)) {
      context.addIssue({ code: "custom", path: ["records"], message: "Audit record ids must be unique" });
    }
    if (hasDuplicates(claimIds)) {
      context.addIssue({ code: "custom", path: ["records"], message: "Each claim may be audited only once" });
    }
    for (const [index, record] of review.records.entries()) {
      if (record.id === review.id || record.id === record.claimId || record.evidenceIds.includes(record.id)) {
        context.addIssue({
          code: "custom",
          path: ["records", index, "id"],
          message: "Audit records cannot refer to themselves",
        });
      }
    }
  });

/**
 * Attestations are inserted and verified by the workspace service after model
 * output. Shape validation alone does not authenticate their authority field.
 */
export const CanonicalManifestAttestationSchema = z
  .object({
    id: OpaqueIdSchema,
    authority: z.literal("workspace_service"),
    claimId: OpaqueIdSchema,
    evidenceId: OpaqueIdSchema,
    packetId: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema,
    candidateDigest: Sha256DigestSchema,
    snapshotDigest: Sha256DigestSchema,
    path: RelativePathSchema,
    fileHash: Sha256DigestSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict()
  .superRefine((attestation, context) => {
    if (attestation.endLine < attestation.startLine) {
      context.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "endLine must be greater than or equal to startLine",
      });
    }
  });

const PROJECT_EVIDENCE_KINDS = new Set([
  "code_excerpt",
  "test_excerpt",
  "project_document",
] as const);

const PROJECT_FACT_CATEGORIES = new Set([
  "code_fact",
  "architecture",
  "cross_module_flow",
  "configuration",
] as const);

const UNSUPPORTED_CODES = new Set([
  "not_inspected",
  "missing_evidence",
  "unsupported_claim",
  "unresolved",
] as const);

function refineClaimCollection(
  value: {
    conclusionClaimId: string;
    claims: z.infer<typeof AnswerClaimSchema>[];
    unknowns: z.infer<typeof AnswerUnknownSchema>[];
  },
  context: z.RefinementCtx,
): void {
  const claimIds = value.claims.map((item) => item.id);
  if (hasDuplicates(claimIds)) {
    context.addIssue({ code: "custom", path: ["claims"], message: "Claim ids must be unique" });
  }
  if (!claimIds.includes(value.conclusionClaimId)) {
    context.addIssue({
      code: "custom",
      path: ["conclusionClaimId"],
      message: "The conclusion must identify a claim in this answer",
    });
  }

  const unknownIds = value.unknowns.map((item) => item.id);
  if (hasDuplicates(unknownIds)) {
    context.addIssue({ code: "custom", path: ["unknowns"], message: "Unknown record ids must be unique" });
  }
  for (const [index, unknown] of value.unknowns.entries()) {
    for (const claimId of unknown.claimIds) {
      if (!claimIds.includes(claimId)) {
        context.addIssue({
          code: "custom",
          path: ["unknowns", index, "claimIds"],
          message: `Unknown record references absent claim ${claimId}`,
        });
      }
    }
  }
}

/**
 * The answering model can select only opaque evidence ids already present in
 * its packet. It cannot emit evidence locators or assign a review status.
 */
export const ModelAnswerCandidateSchema = z
  .object({
    conclusionClaimId: OpaqueIdSchema,
    claims: z.array(AnswerClaimSchema).min(1).max(MAX_COLLECTION_LENGTH),
    unknowns: z.array(AnswerUnknownSchema).max(MAX_COLLECTION_LENGTH),
  })
  .strict()
  .superRefine(refineClaimCollection);

const RequestedEvidenceKindSchema = z.enum([
  "code_excerpt",
  "test_excerpt",
  "project_document",
]);

export const EvidenceExpansionRequestSchema = z
  .object({
    query: StatementSchema,
    reason: StatementSchema,
    requestedKinds: z
      .array(RequestedEvidenceKindSchema)
      .min(1)
      .max(3)
      .superRefine((values, context) => {
        if (hasDuplicates(values)) {
          context.addIssue({ code: "custom", message: "Requested evidence kinds must be unique" });
        }
      }),
  })
  .strict();

export const ModelQuestionOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer"), answer: ModelAnswerCandidateSchema }).strict(),
  z
    .object({
      kind: z.literal("evidence_request"),
      request: EvidenceExpansionRequestSchema,
    })
    .strict(),
]);

const EvidenceAnswerObjectSchema = z
  .object({
    conclusionClaimId: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema,
    candidateDigest: Sha256DigestSchema,
    claims: z.array(AnswerClaimSchema).min(1).max(MAX_COLLECTION_LENGTH),
    reviewStatus: AnswerReviewStatusSchema,
    contextMode: ContextModeSchema,
    documentPath: RelativePathSchema.optional(),
    evidence: z.array(EvidenceReferenceSchema).max(MAX_COLLECTION_LENGTH),
    unknowns: z.array(AnswerUnknownSchema).max(MAX_COLLECTION_LENGTH),
    snapshotDigest: Sha256DigestSchema,
    supportReview: EvidenceSupportReviewSchema.optional(),
    canonicalManifestAttestations: z
      .array(CanonicalManifestAttestationSchema)
      .max(MAX_COLLECTION_LENGTH)
      .optional(),
  })
  .strict();

/**
 * This is the server-enriched durable envelope, not direct model output.
 * `citation_validated` records successful runtime locator/packet checks; Zod
 * alone cannot prove issuance, freshness against the live workspace, or
 * semantic entailment. Digest equality is correlation only: a trusted runtime
 * must compute and authenticate the server-owned candidate digest.
 * `evidence_reviewed` additionally records a model-assisted structured audit
 * and is never a mathematical-proof claim.
 */
export const EvidenceAnswerSchema = EvidenceAnswerObjectSchema.superRefine(
  (answer, context) => {
    // This is a post-parse defense-in-depth bound. HTTP/SSE transports must
    // still enforce a pre-parse byte limit so oversized JSON is never buffered.
    if (jsonUtf8ByteLength(answer) > MAX_EVIDENCE_ANSWER_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Evidence answer exceeds the UTF-8 JSON byte budget",
      });
    }
    refineClaimCollection(answer, context);

    const claimById = new Map(answer.claims.map((item) => [item.id, item]));
    const evidenceById = new Map(answer.evidence.map((item) => [item.id, item]));
    const evidenceIds = answer.evidence.map((item) => item.id);
    if (hasDuplicates(evidenceIds)) {
      context.addIssue({ code: "custom", path: ["evidence"], message: "Evidence ids must be unique" });
    }

    for (const [index, evidence] of answer.evidence.entries()) {
      if (evidence.snapshotDigest !== answer.snapshotDigest) {
        context.addIssue({
          code: "custom",
          path: ["evidence", index, "snapshotDigest"],
          message: "Evidence must belong to the answer snapshot",
        });
      }
      if (
        evidence.provenance.runId !== answer.runId ||
        evidence.provenance.generation !== answer.generation
      ) {
        context.addIssue({
          code: "custom",
          path: ["evidence", index, "provenance"],
          message: "Evidence must belong to the answer run and generation",
        });
      }
      if (evidence.kind === "inference") {
        for (const basisId of evidence.basisEvidenceIds) {
          const basis = evidenceById.get(basisId);
          if (!basis) {
            context.addIssue({
              code: "custom",
              path: ["evidence", index, "basisEvidenceIds"],
              message: `Inference basis ${basisId} is absent from this answer`,
            });
          }
        }
      }
    }

    for (const [claimIndex, answerClaim] of answer.claims.entries()) {
      const cited = answerClaim.evidenceIds
        .map((id) => evidenceById.get(id))
        .filter((item): item is z.infer<typeof EvidenceReferenceSchema> => item !== undefined);
      for (const evidenceId of answerClaim.evidenceIds) {
        if (!evidenceById.has(evidenceId)) {
          context.addIssue({
            code: "custom",
            path: ["claims", claimIndex, "evidenceIds"],
            message: `Evidence ${evidenceId} was not issued in this answer envelope`,
          });
        }
      }

      const projectEvidence = cited.filter((item) => PROJECT_EVIDENCE_KINDS.has(item.kind as never));
      const hasUnsupportedCoverage =
        answer.reviewStatus === "unsupported" &&
        answer.unknowns.some(
          (unknown) =>
            unknown.claimIds.includes(answerClaim.id) &&
            UNSUPPORTED_CODES.has(unknown.code as never),
        );
      if (
        PROJECT_FACT_CATEGORIES.has(answerClaim.category as never) &&
        projectEvidence.length === 0 &&
        !hasUnsupportedCoverage
      ) {
        context.addIssue({
          code: "custom",
          path: ["claims", claimIndex, "evidenceIds"],
          message: "Current project facts require project evidence",
        });
      }

      if (
        answerClaim.category === "document_literal" &&
        !cited.some((item) => item.kind === "project_document") &&
        !hasUnsupportedCoverage
      ) {
        context.addIssue({
          code: "custom",
          path: ["claims", claimIndex, "evidenceIds"],
          message: "Document-literal claims require project-document evidence",
        });
      }

      if (
        answerClaim.category === "task_decision" &&
        !cited.some((item) => item.kind === "task_decision") &&
        !hasUnsupportedCoverage
      ) {
        context.addIssue({
          code: "custom",
          path: ["claims", claimIndex, "evidenceIds"],
          message: "Task-decision claims require task-decision evidence",
        });
      }

      if (answerClaim.category !== "inference" && cited.some((item) => item.kind === "inference")) {
        context.addIssue({
          code: "custom",
          path: ["claims", claimIndex, "category"],
          message: "Inference evidence may only support a claim labelled as inference",
        });
      }

      if (
        answerClaim.category === "inference" &&
        answerClaim.evidenceIds.length === 0 &&
        !hasUnsupportedCoverage
      ) {
        context.addIssue({
          code: "custom",
          path: ["claims", claimIndex, "evidenceIds"],
          message: "An inference needs cited premises or an explicit unknown record",
        });
      }

      if (
        (answerClaim.category === "architecture" || answerClaim.category === "cross_module_flow") &&
        !hasUnsupportedCoverage
      ) {
        const distinctPaths = new Set(projectEvidence.map((item) => "path" in item ? item.path : undefined));
        distinctPaths.delete(undefined);
        if (distinctPaths.size < 2) {
          const hasCanonicalAttestation = (answer.canonicalManifestAttestations ?? []).some(
            (attestation) => {
              if (attestation.claimId !== answerClaim.id || !answerClaim.evidenceIds.includes(attestation.evidenceId)) {
                return false;
              }
              const evidence = evidenceById.get(attestation.evidenceId);
              return (
                evidence?.kind === "project_document" &&
                evidence.path === attestation.path &&
                evidence.fileHash === attestation.fileHash &&
                evidence.startLine === attestation.startLine &&
                evidence.endLine === attestation.endLine &&
                evidence.snapshotDigest === attestation.snapshotDigest &&
                evidence.provenance.packetId === attestation.packetId &&
                evidence.provenance.runId === attestation.runId
              );
            },
          );
          if (!hasCanonicalAttestation) {
            context.addIssue({
              code: "custom",
              path: ["claims", claimIndex, "evidenceIds"],
              message: "Architecture and cross-module claims require two distinct project paths",
            });
          }
        }
      }
    }

    for (const [unknownIndex, unknown] of answer.unknowns.entries()) {
      const claimEvidenceIds = new Set(
        unknown.claimIds.flatMap((claimId) => claimById.get(claimId)?.evidenceIds ?? []),
      );
      for (const evidenceId of unknown.evidenceIds) {
        if (!evidenceById.has(evidenceId)) {
          context.addIssue({
            code: "custom",
            path: ["unknowns", unknownIndex, "evidenceIds"],
            message: `Unknown record references absent evidence ${evidenceId}`,
          });
        } else if (!claimEvidenceIds.has(evidenceId)) {
          context.addIssue({
            code: "custom",
            path: ["unknowns", unknownIndex, "evidenceIds"],
            message: `Unknown evidence ${evidenceId} is not cited by the named claims`,
          });
        }
      }
    }

    const reachableEvidenceIds = new Set<string>();
    const visitReachableEvidence = (evidenceId: string): void => {
      if (reachableEvidenceIds.has(evidenceId)) return;
      reachableEvidenceIds.add(evidenceId);
      const evidence = evidenceById.get(evidenceId);
      if (evidence?.kind === "inference") {
        for (const basisId of evidence.basisEvidenceIds) visitReachableEvidence(basisId);
      }
    };
    for (const answerClaim of answer.claims) {
      for (const evidenceId of answerClaim.evidenceIds) visitReachableEvidence(evidenceId);
    }
    for (const unknown of answer.unknowns) {
      for (const evidenceId of unknown.evidenceIds) visitReachableEvidence(evidenceId);
    }
    for (const [evidenceIndex, evidence] of answer.evidence.entries()) {
      if (!reachableEvidenceIds.has(evidence.id)) {
        context.addIssue({
          code: "custom",
          path: ["evidence", evidenceIndex],
          message: "Evidence must be reachable from a claim or structured unknown",
        });
      }
    }

    const inferenceGrounding = new Map<string, boolean>();
    const isGrounded = (evidenceId: string, visiting: Set<string>): boolean => {
      const cached = inferenceGrounding.get(evidenceId);
      if (cached !== undefined) return cached;
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) return false;
      if (evidence.kind !== "inference") return true;
      if (visiting.has(evidenceId)) return false;
      const next = new Set(visiting);
      next.add(evidenceId);
      const grounded =
        evidence.basisEvidenceIds.length > 0 &&
        evidence.basisEvidenceIds.every((basisId) => isGrounded(basisId, next));
      inferenceGrounding.set(evidenceId, grounded);
      return grounded;
    };
    for (const [evidenceIndex, evidence] of answer.evidence.entries()) {
      if (evidence.kind === "inference" && !isGrounded(evidence.id, new Set())) {
        context.addIssue({
          code: "custom",
          path: ["evidence", evidenceIndex, "basisEvidenceIds"],
          message: "Inference evidence must recursively terminate in issued non-inference evidence",
        });
      }
    }

    if (answer.contextMode === "project_only") {
      if (answer.claims.some((item) => item.category === "task_decision")) {
        context.addIssue({
          code: "custom",
          path: ["claims"],
          message: "Project-only answers cannot contain task-decision claims",
        });
      }
      if (answer.evidence.some((item) => item.kind === "task_decision")) {
        context.addIssue({
          code: "custom",
          path: ["evidence"],
          message: "Project-only answers cannot contain task-decision evidence",
        });
      }
    }

    if (answer.contextMode === "document_only") {
      if (!answer.documentPath) {
        context.addIssue({
          code: "custom",
          path: ["documentPath"],
          message: "Document-only answers must identify the selected document",
        });
      }
      for (const [claimIndex, answerClaim] of answer.claims.entries()) {
        if (answerClaim.category !== "document_literal") {
          context.addIssue({
            code: "custom",
            path: ["claims", claimIndex, "category"],
            message: "Document-only answers may contain only document-literal claims",
          });
        }
      }
      for (const [evidenceIndex, evidence] of answer.evidence.entries()) {
        if (evidence.kind !== "project_document" || evidence.path !== answer.documentPath) {
          context.addIssue({
            code: "custom",
            path: ["evidence", evidenceIndex],
            message: "Document-only evidence must cite the selected document",
          });
        }
      }
    }

    const attestations = answer.canonicalManifestAttestations ?? [];
    const attestationIds = attestations.map((item) => item.id);
    if (hasDuplicates(attestationIds)) {
      context.addIssue({
        code: "custom",
        path: ["canonicalManifestAttestations"],
        message: "Canonical-manifest attestation ids must be unique",
      });
    }
    for (const [index, attestation] of attestations.entries()) {
      if (attestation.snapshotDigest !== answer.snapshotDigest) {
        context.addIssue({
          code: "custom",
          path: ["canonicalManifestAttestations", index, "snapshotDigest"],
          message: "Canonical-manifest attestation must match the answer snapshot",
        });
      }
      if (
        attestation.runId !== answer.runId ||
        attestation.generation !== answer.generation ||
        attestation.candidateDigest !== answer.candidateDigest
      ) {
        context.addIssue({
          code: "custom",
          path: ["canonicalManifestAttestations", index],
          message: "Canonical-manifest attestation must bind the answer candidate",
        });
      }
      const attestedClaim = claimById.get(attestation.claimId);
      const attestedEvidence = evidenceById.get(attestation.evidenceId);
      if (
        !attestedClaim ||
        (attestedClaim.category !== "architecture" && attestedClaim.category !== "cross_module_flow") ||
        !attestedClaim.evidenceIds.includes(attestation.evidenceId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["canonicalManifestAttestations", index],
          message: "Canonical-manifest attestation must bind a cited architecture claim",
        });
      }
      if (
        attestedEvidence?.kind !== "project_document" ||
        attestedEvidence.path !== attestation.path ||
        attestedEvidence.fileHash !== attestation.fileHash ||
        attestedEvidence.startLine !== attestation.startLine ||
        attestedEvidence.endLine !== attestation.endLine ||
        attestedEvidence.snapshotDigest !== attestation.snapshotDigest ||
        attestedEvidence.provenance.packetId !== attestation.packetId ||
        attestedEvidence.provenance.runId !== attestation.runId ||
        attestedEvidence.provenance.generation !== attestation.generation
      ) {
        context.addIssue({
          code: "custom",
          path: ["canonicalManifestAttestations", index],
          message: "Canonical-manifest attestation must exactly bind its evidence record",
        });
      }
    }

    if (answer.supportReview) {
      if (answer.supportReview.snapshotDigest !== answer.snapshotDigest) {
        context.addIssue({
          code: "custom",
          path: ["supportReview", "snapshotDigest"],
          message: "Evidence audit must match the answer snapshot",
        });
      }
      if (
        answer.supportReview.runId !== answer.runId ||
        answer.supportReview.generation !== answer.generation ||
        answer.supportReview.candidateDigest !== answer.candidateDigest
      ) {
        context.addIssue({
          code: "custom",
          path: ["supportReview"],
          message: "Evidence audit must bind the answer candidate run and generation",
        });
      }
      const recordByClaim = new Map(answer.supportReview.records.map((record) => [record.claimId, record]));
      if (recordByClaim.size !== answer.claims.length) {
        context.addIssue({
          code: "custom",
          path: ["supportReview", "records"],
          message: "Evidence audit must review every claim exactly once",
        });
      }
      for (const [recordIndex, record] of answer.supportReview.records.entries()) {
        const reviewedClaim = claimById.get(record.claimId);
        if (!reviewedClaim) {
          context.addIssue({
            code: "custom",
            path: ["supportReview", "records", recordIndex, "claimId"],
            message: "Evidence audit cannot add claims",
          });
        } else if (!sameStringSet(record.evidenceIds, reviewedClaim.evidenceIds)) {
          context.addIssue({
            code: "custom",
            path: ["supportReview", "records", recordIndex, "evidenceIds"],
            message: "Evidence audit must use exactly the claim's cited evidence",
          });
        }
        if (
          record.id === answer.supportReview.id ||
          claimById.has(record.id) ||
          evidenceById.has(record.id)
        ) {
          context.addIssue({
            code: "custom",
            path: ["supportReview", "records", recordIndex, "id"],
            message: "Audit record ids cannot self-reference answer records",
          });
        }
      }
    }

    if (answer.reviewStatus === "evidence_reviewed") {
      if (!answer.supportReview) {
        context.addIssue({
          code: "custom",
          path: ["supportReview"],
          message: "Evidence-reviewed answers require an independent structured audit",
        });
      } else if (answer.supportReview.records.some((record) => record.verdict !== "directly_supported")) {
        context.addIssue({
          code: "custom",
          path: ["supportReview", "records"],
          message: "Every presented claim must be directly supported",
        });
      }
    }

    if (
      (answer.reviewStatus === "citation_validated" ||
        answer.reviewStatus === "evidence_reviewed") &&
      answer.unknowns.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["unknowns"],
        message: "Positive review states cannot contain negative unknown records",
      });
    }

    if (answer.reviewStatus === "citation_validated" && answer.supportReview) {
      context.addIssue({
        code: "custom",
        path: ["supportReview"],
        message: "Citation-validated answers do not carry a semantic support audit",
      });
    }

    if (answer.reviewStatus === "unsupported" && answer.supportReview) {
      const negativeRecords = answer.supportReview.records.filter(
        (record) => record.verdict !== "directly_supported",
      );
      if (negativeRecords.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["supportReview", "records"],
          message: "An unsupported audit must contain a negative verdict",
        });
      }
      for (const record of negativeRecords) {
        if (
          !answer.unknowns.some(
            (unknown) =>
              UNSUPPORTED_CODES.has(unknown.code as never) &&
              unknown.claimIds.includes(record.claimId),
          )
        ) {
          context.addIssue({
            code: "custom",
            path: ["supportReview", "records"],
            message: "Each negative audit verdict needs a corresponding unsupported unknown",
          });
        }
      }
    }

    if (answer.reviewStatus === "conflict" && answer.supportReview) {
      const negativeRecords = answer.supportReview.records.filter(
        (record) => record.verdict !== "directly_supported",
      );
      for (const record of negativeRecords) {
        if (
          !answer.unknowns.some(
            (unknown) =>
              unknown.code === "evidence_conflict" &&
              unknown.claimIds.includes(record.claimId),
          )
        ) {
          context.addIssue({
            code: "custom",
            path: ["supportReview", "records"],
            message: "Each conflicting audit verdict needs a corresponding conflict record",
          });
        }
      }
    }

    if (
      answer.reviewStatus === "stale" &&
      answer.supportReview?.records.some((record) => record.verdict !== "directly_supported")
    ) {
      context.addIssue({
        code: "custom",
        path: ["supportReview", "records"],
        message: "A retained stale audit must have been all-direct before freshness changed",
      });
    }

    const compatibleUnknownCodes =
      answer.reviewStatus === "unsupported"
        ? UNSUPPORTED_CODES
        : answer.reviewStatus === "stale"
          ? new Set(["stale_snapshot"] as const)
          : answer.reviewStatus === "conflict"
            ? new Set(["evidence_conflict"] as const)
            : undefined;
    if (
      compatibleUnknownCodes &&
      answer.unknowns.some((unknown) => !compatibleUnknownCodes.has(unknown.code as never))
    ) {
      context.addIssue({
        code: "custom",
        path: ["unknowns"],
        message: `Unknown records are incompatible with ${answer.reviewStatus} status`,
      });
    }

    if (
      answer.reviewStatus === "citation_validated" &&
      answer.supportReview?.records.some((record) => record.verdict !== "directly_supported")
    ) {
      context.addIssue({
        code: "custom",
        path: ["reviewStatus"],
        message: "A negative semantic audit must be surfaced as unsupported or conflict",
      });
    }

    if (
      answer.reviewStatus === "unsupported" &&
      !answer.unknowns.some((unknown) => UNSUPPORTED_CODES.has(unknown.code as never))
    ) {
      context.addIssue({
        code: "custom",
        path: ["unknowns"],
        message: "Unsupported answers require a structured support issue",
      });
    }
    if (
      answer.reviewStatus === "stale" &&
      !answer.unknowns.some((unknown) => unknown.code === "stale_snapshot")
    ) {
      context.addIssue({
        code: "custom",
        path: ["unknowns"],
        message: "Stale answers require a structured stale-snapshot issue",
      });
    }
    if (
      answer.reviewStatus === "conflict" &&
      !answer.unknowns.some((unknown) => unknown.code === "evidence_conflict")
    ) {
      context.addIssue({
        code: "custom",
        path: ["unknowns"],
        message: "Conflict answers require a structured evidence-conflict issue",
      });
    }
  },
);

export const ReaderSessionSchema = z
  .object({
    id: OpaqueIdSchema,
    bindingStatus: BindingStatusSchema,
    contextMode: ContextModeSchema,
    rootId: OpaqueIdSchema,
    workspaceLabel: NonBlankTextSchema.max(512).refine(
      (label) => !isSyntacticallyAbsolutePath(label),
      "Workspace labels cannot expose an absolute root",
    ),
    documentPath: RelativePathSchema,
    cutoffLabel: NonBlankTextSchema.max(512).optional(),
    degradationReason: NonBlankTextSchema.max(2_048).optional(),
  })
  .strict()
  .superRefine((session, context) => {
    if (session.bindingStatus !== "verified" && session.contextMode === "task_and_project") {
      context.addIssue({
        code: "custom",
        path: ["contextMode"],
        message: "Unverified bindings cannot claim task context",
      });
    }
  });

export const QuestionRunEventTypeSchema = z.enum([
  "status",
  "progress",
  "completed",
  "stale",
  "failed",
  "cancelled",
]);

const ActiveQuestionRunStatusSchema = z.enum([
  "draft",
  "queued",
  "inspecting",
  "streaming_unverified",
  "validating",
]);

const EventBaseFields = {
  runId: OpaqueIdSchema,
  generation: OpaqueIdSchema,
  sequence: z.number().int().positive(),
  createdAt: CreatedAtSchema,
} as const;

const StatusEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("status"),
    payload: z.object({ status: ActiveQuestionRunStatusSchema }).strict(),
  })
  .strict();

const ProgressEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("progress"),
    payload: z
      .object({
        status: ActiveQuestionRunStatusSchema,
        message: NonBlankTextSchema.max(2_048),
      })
      .strict(),
  })
  .strict();

const CompletedEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("completed"),
    payload: z
      .object({
        status: z.literal("completed"),
        answer: EvidenceAnswerSchema,
      })
      .strict(),
  })
  .strict();

const StaleEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("stale"),
    payload: z
      .object({
        status: z.literal("stale"),
        reason: StatementSchema,
        retryable: z.boolean(),
        answer: EvidenceAnswerSchema.optional(),
      })
      .strict(),
  })
  .strict();

const FailedEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("failed"),
    payload: z
      .object({
        status: z.literal("failed"),
        code: OpaqueIdSchema,
        message: StatementSchema,
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();

const CancelledEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("cancelled"),
    payload: z
      .object({
        status: z.literal("cancelled"),
        reason: StatementSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const QuestionRunEventSchema = z
  .discriminatedUnion("type", [
    StatusEventSchema,
    ProgressEventSchema,
    CompletedEventSchema,
    StaleEventSchema,
    FailedEventSchema,
    CancelledEventSchema,
  ])
  .superRefine((event, context) => {
    if (
      event.type === "completed" &&
      (event.payload.answer.runId !== event.runId ||
        event.payload.answer.generation !== event.generation)
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload", "answer"],
        message: "A completed event must bind its answer run and generation",
      });
    }
    if (event.type === "completed" && event.payload.answer.reviewStatus === "stale") {
      context.addIssue({
        code: "custom",
        path: ["payload", "answer", "reviewStatus"],
        message: "A stale answer must use a stale terminal event",
      });
    }
    if (event.type === "stale" && event.payload.answer) {
      if (event.payload.answer.reviewStatus !== "stale") {
        context.addIssue({
          code: "custom",
          path: ["payload", "answer", "reviewStatus"],
          message: "A stale terminal may carry only a stale answer",
        });
      }
      if (
        event.payload.answer.runId !== event.runId ||
        event.payload.answer.generation !== event.generation
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload", "answer"],
          message: "A stale terminal answer must bind its run and generation",
        });
      }
    }
  });

export const QuestionRunCursorSchema = z
  .object({
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema,
    sequence: z.number().int().positive(),
  })
  .strict();

const QuestionRunEventsPageObjectSchema = z
  .object({
    outcome: z.literal("events"),
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema,
    cursor: QuestionRunCursorSchema.nullable(),
    nextCursor: QuestionRunCursorSchema.nullable(),
    events: z.array(QuestionRunEventSchema).max(MAX_EVENT_WINDOW_LENGTH),
  })
  .strict();

const GenerationChangedPageObjectSchema = z
  .object({
    outcome: z.literal("GENERATION_CHANGED"),
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema,
    cursor: QuestionRunCursorSchema.nullable(),
    currentCursor: QuestionRunCursorSchema.nullable(),
  })
  .strict();

const CursorExpiredPageObjectSchema = z
  .object({
    outcome: z.literal("CURSOR_EXPIRED"),
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema,
    cursor: QuestionRunCursorSchema,
    oldestAvailableCursor: QuestionRunCursorSchema,
    currentCursor: QuestionRunCursorSchema,
  })
  .strict();

const CursorGapPageObjectSchema = z
  .object({
    outcome: z.literal("CURSOR_GAP"),
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema,
    cursor: QuestionRunCursorSchema,
    expectedSequence: z.number().int().positive(),
    actualSequence: z.number().int().positive(),
  })
  .strict();

const QuestionRunPageObjectSchema = z.discriminatedUnion("outcome", [
  QuestionRunEventsPageObjectSchema,
  GenerationChangedPageObjectSchema,
  CursorExpiredPageObjectSchema,
  CursorGapPageObjectSchema,
]);

const TERMINAL_EVENT_TYPES = new Set(["completed", "stale", "failed", "cancelled"] as const);

function stableEventKey(event: z.infer<typeof QuestionRunEventSchema>): string {
  return JSON.stringify(event);
}

function refineQuestionRunEventSequence(
  events: readonly z.infer<typeof QuestionRunEventSchema>[],
  context: z.RefinementCtx,
): void {
  if (events.length === 0) return;
  const first = events[0];
  if (!first) return;
  const bySequence = new Map<number, z.infer<typeof QuestionRunEventSchema>>();
  let expectedSequence = 1;

  for (const [index, event] of events.entries()) {
    if (event.runId !== first.runId || event.generation !== first.generation) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: "A sequence must contain one run and one generation",
      });
      continue;
    }

    const replayed = bySequence.get(event.sequence);
    if (replayed) {
      if (stableEventKey(replayed) !== stableEventKey(event)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "A replayed event key must have identical content",
        });
      }
      continue;
    }

    if (event.sequence !== expectedSequence) {
      context.addIssue({
        code: "custom",
        path: [index, "sequence"],
        message: `Expected sequence ${expectedSequence}`,
      });
    } else {
      expectedSequence += 1;
    }
    bySequence.set(event.sequence, event);
  }

  const normalized = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  const terminalIndexes = normalized
    .map((event, index) => TERMINAL_EVENT_TYPES.has(event.type as never) ? index : -1)
    .filter((index) => index >= 0);
  if (terminalIndexes.length > 1) {
    context.addIssue({ code: "custom", message: "A generation may contain at most one terminal event" });
  }
  const terminalIndex = terminalIndexes[0];
  if (terminalIndex !== undefined && terminalIndex !== normalized.length - 1) {
    context.addIssue({ code: "custom", message: "No event may follow a terminal event" });
  }
}

export const QuestionRunEventSequenceSchema = z
  .array(QuestionRunEventSchema)
  .min(1)
  .max(MAX_EVENT_WINDOW_LENGTH)
  // Budget the raw replay window before exact duplicates are folded below.
  // The transport must additionally reject oversized bodies before JSON parse.
  .superRefine((events, context) => {
    if (jsonUtf8ByteLength(events) > MAX_EVENT_WINDOW_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Event window exceeds the UTF-8 JSON byte budget",
      });
    }
  })
  .superRefine(refineQuestionRunEventSequence)
  .transform((events) => {
    const seen = new Set<number>();
    return events.filter((event) => {
      if (seen.has(event.sequence)) return false;
      seen.add(event.sequence);
      return true;
    });
  });

export const CompletedQuestionRunEventSequenceSchema = QuestionRunEventSequenceSchema.superRefine(
  (events, context) => {
    const terminalCount = events.filter((event) => TERMINAL_EVENT_TYPES.has(event.type as never)).length;
    if (terminalCount !== 1) {
      context.addIssue({ code: "custom", message: "A completed generation requires exactly one terminal event" });
    }
  },
);

type QuestionRunCursorValue = z.infer<typeof QuestionRunCursorSchema>;

function cursorMatchesRun(
  cursor: QuestionRunCursorValue,
  runId: string,
  generation: string,
): boolean {
  return cursor.runId === runId && cursor.generation === generation;
}

function sameCursor(
  left: QuestionRunCursorValue | null,
  right: QuestionRunCursorValue | null,
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.runId === right.runId &&
      left.generation === right.generation &&
      left.sequence === right.sequence)
  );
}

/**
 * Poll results are structured protocol outcomes, never sentinel strings or
 * synthetic events. The events variant echoes the requested cursor and returns
 * a cursor for the last normalized event. This schema validates one page only;
 * every cross-page consumer must pass it through
 * `advanceQuestionRunPageTransition` to retain terminal history.
 */
export const QuestionRunPageSchema = QuestionRunPageObjectSchema
  .superRefine((page, context) => {
    // Apply this to the raw parsed page before exact replay is folded. Network
    // transports must also enforce the cap before buffering/parsing JSON.
    if (jsonUtf8ByteLength(page) > MAX_EVENT_WINDOW_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Question run page exceeds the UTF-8 JSON byte budget",
      });
    }

    if (page.outcome === "events") {
      if (page.cursor && !cursorMatchesRun(page.cursor, page.runId, page.generation)) {
        context.addIssue({
          code: "custom",
          path: ["cursor"],
          message: "The requested cursor must bind the page run and generation",
        });
      }
      if (page.nextCursor && !cursorMatchesRun(page.nextCursor, page.runId, page.generation)) {
        context.addIssue({
          code: "custom",
          path: ["nextCursor"],
          message: "The returned cursor must bind the page run and generation",
        });
      }

      const bySequence = new Map<number, z.infer<typeof QuestionRunEventSchema>>();
      let expectedSequence = (page.cursor?.sequence ?? 0) + 1;
      for (const [eventIndex, event] of page.events.entries()) {
        if (event.runId !== page.runId || event.generation !== page.generation) {
          context.addIssue({
            code: "custom",
            path: ["events", eventIndex],
            message: "Every event must bind the page run and generation",
          });
        }
        const replayed = bySequence.get(event.sequence);
        if (replayed) {
          if (stableEventKey(replayed) !== stableEventKey(event)) {
            context.addIssue({
              code: "custom",
              path: ["events", eventIndex],
              message: "A replayed event key must have identical content",
            });
          }
          continue;
        }
        if (event.sequence !== expectedSequence) {
          context.addIssue({
            code: "custom",
            path: ["events", eventIndex, "sequence"],
            message: `Expected sequence ${expectedSequence} after the supplied cursor`,
          });
        } else {
          expectedSequence += 1;
        }
        bySequence.set(event.sequence, event);
      }

      const normalized = [...bySequence.values()].sort(
        (left, right) => left.sequence - right.sequence,
      );
      const terminalIndexes = normalized
        .map((event, index) => TERMINAL_EVENT_TYPES.has(event.type as never) ? index : -1)
        .filter((index) => index >= 0);
      if (terminalIndexes.length > 1) {
        context.addIssue({
          code: "custom",
          path: ["events"],
          message: "A page cannot contain multiple terminal events",
        });
      }
      if (
        terminalIndexes[0] !== undefined &&
        terminalIndexes[0] !== normalized.length - 1
      ) {
        context.addIssue({
          code: "custom",
          path: ["events"],
          message: "No event may follow a terminal event",
        });
      }

      const lastEvent = normalized.at(-1);
      const expectedCursor = lastEvent
        ? {
            runId: page.runId,
            generation: page.generation,
            sequence: lastEvent.sequence,
          }
        : page.cursor;
      if (!sameCursor(page.nextCursor, expectedCursor)) {
        context.addIssue({
          code: "custom",
          path: ["nextCursor"],
          message: "The returned cursor must identify the last normalized event",
        });
      }
      return;
    }

    if (page.outcome === "GENERATION_CHANGED") {
      if (
        page.cursor &&
        (page.cursor.runId !== page.runId || page.cursor.generation === page.generation)
      ) {
        context.addIssue({
          code: "custom",
          path: ["cursor"],
          message: "A generation-change cursor must bind this run and an older generation",
        });
      }
      if (
        page.currentCursor &&
        !cursorMatchesRun(page.currentCursor, page.runId, page.generation)
      ) {
        context.addIssue({
          code: "custom",
          path: ["currentCursor"],
          message: "The current cursor must bind the replacement generation",
        });
      }
      return;
    }

    if (!cursorMatchesRun(page.cursor, page.runId, page.generation)) {
      context.addIssue({
        code: "custom",
        path: ["cursor"],
        message: "The cursor must bind the outcome run and generation",
      });
    }

    if (page.outcome === "CURSOR_EXPIRED") {
      if (
        !cursorMatchesRun(page.oldestAvailableCursor, page.runId, page.generation) ||
        !cursorMatchesRun(page.currentCursor, page.runId, page.generation)
      ) {
        context.addIssue({
          code: "custom",
          path: ["oldestAvailableCursor"],
          message: "Expired-cursor snapshots must bind the current run and generation",
        });
      }
      if (
        page.cursor.sequence >= page.oldestAvailableCursor.sequence ||
        page.oldestAvailableCursor.sequence > page.currentCursor.sequence
      ) {
        context.addIssue({
          code: "custom",
          path: ["oldestAvailableCursor", "sequence"],
          message: "An expired cursor must precede the retained event window",
        });
      }
      return;
    }

    if (
      page.expectedSequence !== page.cursor.sequence + 1 ||
      page.actualSequence <= page.expectedSequence
    ) {
      context.addIssue({
        code: "custom",
        path: ["actualSequence"],
        message: "A cursor gap must report the next expected and a later actual sequence",
      });
    }
  })
  .transform((page) => {
    if (page.outcome !== "events") return page;
    const seen = new Set<number>();
    return {
      ...page,
      events: page.events.filter((event) => {
        if (seen.has(event.sequence)) return false;
        seen.add(event.sequence);
        return true;
      }),
    };
  });

const QuestionRunPollPhaseSchema = z.enum([
  "active",
  "terminal",
  "generation_changed",
  "cursor_expired",
  "cursor_gap",
]);

export const QuestionRunPollStateSchema = z
  .object({
    phase: QuestionRunPollPhaseSchema,
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema,
    cursor: QuestionRunCursorSchema.nullable(),
    terminalSequence: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.cursor && !cursorMatchesRun(state.cursor, state.runId, state.generation)) {
      context.addIssue({
        code: "custom",
        path: ["cursor"],
        message: "Poll-state cursor must bind its run and generation",
      });
    }
    if (state.phase === "terminal") {
      if (
        state.terminalSequence === null ||
        state.cursor === null ||
        state.cursor.sequence !== state.terminalSequence
      ) {
        context.addIssue({
          code: "custom",
          path: ["terminalSequence"],
          message: "Terminal poll state must retain its terminal cursor sequence",
        });
      }
    } else if (state.terminalSequence !== null) {
      context.addIssue({
        code: "custom",
        path: ["terminalSequence"],
        message: "Only terminal poll state may retain a terminal sequence",
      });
    }
  });

type QuestionRunPollStateValue = z.infer<typeof QuestionRunPollStateSchema>;

/**
 * Advances the mandatory stateful polling boundary. Error outcomes halt this
 * state: the caller must explicitly construct a fresh `active` state from the
 * outcome's advertised generation/cursor before consuming any later events.
 */
export function advanceQuestionRunPageTransition(
  previousState: unknown,
  rawPage: unknown,
): QuestionRunPollStateValue {
  const state = QuestionRunPollStateSchema.parse(previousState);
  const page = QuestionRunPageSchema.parse(rawPage);

  if (state.phase !== "active" && state.phase !== "terminal") {
    throw new Error(`Polling is halted by ${state.phase}; explicitly reset state before continuing`);
  }
  if (page.runId !== state.runId || !sameCursor(page.cursor, state.cursor)) {
    throw new Error("Question run page must continue from the previous poll-state cursor");
  }

  if (state.phase === "terminal") {
    if (
      page.outcome !== "events" ||
      page.generation !== state.generation ||
      page.events.length !== 0
    ) {
      throw new Error("No new page event or terminal may follow a retained terminal event");
    }
    return state;
  }

  if (page.outcome === "events") {
    if (page.generation !== state.generation) {
      throw new Error("An events page cannot silently change polling generation");
    }
    const terminalEvent = page.events.find((event) =>
      TERMINAL_EVENT_TYPES.has(event.type as never),
    );
    return QuestionRunPollStateSchema.parse({
      phase: terminalEvent ? "terminal" : "active",
      runId: state.runId,
      generation: state.generation,
      cursor: page.nextCursor,
      terminalSequence: terminalEvent?.sequence ?? null,
    });
  }

  if (page.outcome === "GENERATION_CHANGED") {
    if (page.generation === state.generation) {
      throw new Error("A generation-change outcome must identify a different generation");
    }
    return QuestionRunPollStateSchema.parse({
      phase: "generation_changed",
      runId: state.runId,
      generation: page.generation,
      cursor: page.currentCursor,
      terminalSequence: null,
    });
  }

  if (page.generation !== state.generation) {
    throw new Error("A cursor error must bind the active polling generation");
  }
  return QuestionRunPollStateSchema.parse({
    ...state,
    phase: page.outcome === "CURSOR_EXPIRED" ? "cursor_expired" : "cursor_gap",
    terminalSequence: null,
  });
}

export const validateQuestionRunPageTransition = advanceQuestionRunPageTransition;

export type QuestionRunEvent = z.infer<typeof QuestionRunEventSchema>;

export function normalizeQuestionRunEventReplay(
  events: readonly unknown[],
): QuestionRunEvent[] {
  return QuestionRunEventSequenceSchema.parse(events);
}

export function validateQuestionRunEventSequence(
  events: readonly unknown[],
): QuestionRunEvent[] {
  return QuestionRunEventSequenceSchema.parse(events);
}

export const QuestionRecordSchema = z
  .object({
    id: OpaqueIdSchema,
    question: StatementSchema,
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema.optional(),
    status: QuestionRunStatusSchema,
    createdAt: CreatedAtSchema,
    answer: EvidenceAnswerSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.status !== "draft" && !record.generation) {
      context.addIssue({
        code: "custom",
        path: ["generation"],
        message: "A started question run must identify its generation",
      });
    }
    if (record.status === "completed" && !record.answer) {
      context.addIssue({
        code: "custom",
        path: ["answer"],
        message: "Completed questions require a durable answer",
      });
    }
    if (record.status === "completed" && record.answer?.reviewStatus === "stale") {
      context.addIssue({
        code: "custom",
        path: ["answer", "reviewStatus"],
        message: "A stale answer cannot be stored as a completed question",
      });
    }
    if (record.status !== "completed" && record.status !== "stale" && record.answer) {
      context.addIssue({
        code: "custom",
        path: ["answer"],
        message: "Partial or failed runs cannot persist an answer",
      });
    }
    if (record.status === "stale" && record.answer && record.answer.reviewStatus !== "stale") {
      context.addIssue({
        code: "custom",
        path: ["answer", "reviewStatus"],
        message: "A stale question may persist only a stale-labelled answer",
      });
    }
    if (
      record.answer &&
      (record.answer.runId !== record.runId || record.answer.generation !== record.generation)
    ) {
      context.addIssue({
        code: "custom",
        path: ["answer"],
        message: "A durable answer must bind the question run and generation",
      });
    }
  });

export const AnnotationThreadSchema = z
  .object({
    id: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    anchor: SourceAnchorSchema,
    questions: z.array(QuestionRecordSchema).min(1).max(MAX_ANNOTATION_QUESTIONS),
    disposition: DispositionSchema,
    stale: z.boolean(),
  })
  .strict()
  .superRefine((thread, context) => {
    // Post-parse defense only; the persistence/transport boundary must enforce
    // the same byte cap before allocating or parsing an untrusted payload.
    if (jsonUtf8ByteLength(thread) > MAX_ANNOTATION_THREAD_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Annotation thread exceeds the UTF-8 JSON byte budget",
      });
    }
    if (hasDuplicates(thread.questions.map((question) => question.id))) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Question ids must be unique within an annotation thread",
      });
    }
    // A retry updates the durable record's generation; it is not appended as a
    // second record with the same run id.
    if (hasDuplicates(thread.questions.map((question) => question.runId))) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Question run ids must be unique within an annotation thread",
      });
    }
  });

export const EditIntentSchema = z
  .object({
    annotationId: OpaqueIdSchema,
    operation: EditOperationSchema,
    targetAnchor: SourceAnchorSchema,
    markdown: NonBlankTextSchema,
    rationale: StatementSchema,
    evidenceIds: UniqueIdsSchema.min(1),
  })
  .strict();

export const EditConflictSchema = z
  .object({
    annotationId: OpaqueIdSchema,
    reason: StatementSchema,
  })
  .strict();

export const EditIntentBatchSchema = z
  .object({
    intents: z.array(EditIntentSchema).max(MAX_COLLECTION_LENGTH),
    conflicts: z.array(EditConflictSchema).max(MAX_COLLECTION_LENGTH),
  })
  .strict()
  .superRefine((batch, context) => {
    if (batch.intents.length + batch.conflicts.length === 0) {
      context.addIssue({ code: "custom", message: "An edit batch needs at least one outcome" });
    }
    const annotationIds = [
      ...batch.intents.map((intent) => intent.annotationId),
      ...batch.conflicts.map((conflict) => conflict.annotationId),
    ];
    if (hasDuplicates(annotationIds)) {
      context.addIssue({
        code: "custom",
        message: "Each annotation must have exactly one synthesis outcome",
      });
    }
  });

export type BindingStatus = z.infer<typeof BindingStatusSchema>;
export type ContextMode = z.infer<typeof ContextModeSchema>;
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type ClaimCategory = z.infer<typeof ClaimCategorySchema>;
export type AnswerReviewStatus = z.infer<typeof AnswerReviewStatusSchema>;
export type Disposition = z.infer<typeof DispositionSchema>;
export type EditOperation = z.infer<typeof EditOperationSchema>;
export type QuestionRunStatus = z.infer<typeof QuestionRunStatusSchema>;
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;
export type WorkspaceSnapshotRef = z.infer<typeof WorkspaceSnapshotRefSchema>;
export type InternalWorkspaceSnapshot = z.infer<typeof InternalWorkspaceSnapshotSchema>;
export type SourceAnchor = z.infer<typeof SourceAnchorSchema>;
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type AnswerClaim = z.infer<typeof AnswerClaimSchema>;
export type AnswerUnknown = z.infer<typeof AnswerUnknownSchema>;
export type EvidenceSupportRecord = z.infer<typeof EvidenceSupportRecordSchema>;
export type EvidenceSupportReview = z.infer<typeof EvidenceSupportReviewSchema>;
export type CanonicalManifestAttestation = z.infer<typeof CanonicalManifestAttestationSchema>;
export type ModelAnswerCandidate = z.infer<typeof ModelAnswerCandidateSchema>;
export type EvidenceExpansionRequest = z.infer<typeof EvidenceExpansionRequestSchema>;
export type ModelQuestionOutput = z.infer<typeof ModelQuestionOutputSchema>;
export type EvidenceAnswer = z.infer<typeof EvidenceAnswerSchema>;
export type ReaderSession = z.infer<typeof ReaderSessionSchema>;
export type QuestionRunCursor = z.infer<typeof QuestionRunCursorSchema>;
export type QuestionRunPage = z.infer<typeof QuestionRunPageSchema>;
export type QuestionRunPollState = z.infer<typeof QuestionRunPollStateSchema>;
export type QuestionRecord = z.infer<typeof QuestionRecordSchema>;
export type AnnotationThread = z.infer<typeof AnnotationThreadSchema>;
export type EditIntent = z.infer<typeof EditIntentSchema>;
export type EditConflict = z.infer<typeof EditConflictSchema>;
export type EditIntentBatch = z.infer<typeof EditIntentBatchSchema>;
export * from "./release.js";
