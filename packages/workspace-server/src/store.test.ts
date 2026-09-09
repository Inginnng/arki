import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AnnotationThreadSchema,
  EvidenceAnswerSchema,
  QuestionRecordSchema,
  ReaderSessionSchema,
} from "@aimd/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { getReaderStorageAuthority, loadReaderConfig } from "./config.js";

import {
  AnnotationStoreV1Schema,
  JsonAnnotationRepository,
  MAX_ANNOTATION_STORE_BYTES,
  MemoryAnnotationRepository,
  QuestionDraftInputSchema,
  createEmptyAnnotationStore,
  openAnnotationRepository,
} from "./store.js";

const temporaryDirectories: string[] = [];
const SNAPSHOT_A = "a".repeat(64);
const SNAPSHOT_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `aimd-store-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function session(id = "session-1") {
  return ReaderSessionSchema.parse({
    id,
    bindingStatus: "verified",
    contextMode: "project_only",
    rootId: "root-1",
    workspaceLabel: "Sample Project",
    documentPath: "README.md",
  });
}

function draftQuestion(runId = "run-1") {
  return QuestionRecordSchema.parse({
    id: `question-${runId}`,
    question: "How does this work?",
    runId,
    status: "draft",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
}

function annotation(id = "annotation-1", sessionId = "session-1") {
  return AnnotationThreadSchema.parse({
    id,
    sessionId,
    anchor: {
      documentPath: "README.md",
      documentHash: HASH_C,
      headingPath: ["Architecture"],
      selectedText: "gateway",
      prefix: "The ",
      suffix: " accepts work.",
      startOffset: 4,
      endOffset: 11,
    },
    questions: [draftQuestion()],
    disposition: "reading_only",
    stale: false,
  });
}

function unsupportedAnswer(snapshotDigest = SNAPSHOT_A) {
  return EvidenceAnswerSchema.parse({
    conclusionClaimId: "claim-1",
    runId: "run-1",
    generation: "generation-1",
    candidateDigest: HASH_D,
    claims: [{
      id: "claim-1",
      statement: "The available material does not establish the answer.",
      category: "document_literal",
      evidenceIds: [],
    }],
    reviewStatus: "unsupported",
    contextMode: "document_only",
    documentPath: "README.md",
    evidence: [],
    unknowns: [{
      id: "unknown-1",
      code: "missing_evidence",
      statement: "Supporting evidence is missing.",
      claimIds: ["claim-1"],
      evidenceIds: [],
    }],
    snapshotDigest,
  });
}

function completedQuestion(snapshotDigest = SNAPSHOT_A) {
  return QuestionRecordSchema.parse({
    id: "question-run-1",
    question: "How does this work?",
    runId: "run-1",
    generation: "generation-1",
    status: "completed",
    createdAt: "2026-09-01T00:00:00.000Z",
    answer: unsupportedAnswer(snapshotDigest),
  });
}

function reviewedAnswer() {
  return EvidenceAnswerSchema.parse({
    conclusionClaimId: "claim-reviewed",
    runId: "run-1",
    generation: "generation-1",
    candidateDigest: HASH_D,
    claims: [{
      id: "claim-reviewed",
      statement: "The selected document names the gateway.",
      category: "document_literal",
      evidenceIds: ["evidence-reviewed"],
    }],
    reviewStatus: "evidence_reviewed",
    supportReview: {
      id: "review-1",
      reviewer: "independent_model",
      modelAssisted: true,
      runId: "run-1",
      generation: "generation-1",
      candidateDigest: HASH_D,
      snapshotDigest: SNAPSHOT_A,
      records: [{
        id: "review-record-1",
        claimId: "claim-reviewed",
        evidenceIds: ["evidence-reviewed"],
        verdict: "directly_supported",
        rationale: "The cited document excerpt directly names the gateway.",
      }],
    },
    contextMode: "document_only",
    documentPath: "README.md",
    evidence: [{
      id: "evidence-reviewed",
      kind: "project_document",
      path: "README.md",
      startLine: 1,
      endLine: 1,
      excerpt: "The gateway accepts work.",
      excerptHash: HASH_D,
      fileHash: HASH_C,
      snapshotDigest: SNAPSHOT_A,
      provenance: {
        issuer: "workspace_service",
        packetId: "packet-1",
        runId: "run-1",
        generation: "generation-1",
      },
    }],
    unknowns: [],
    snapshotDigest: SNAPSHOT_A,
  });
}

function reviewedQuestion() {
  return QuestionRecordSchema.parse({
    id: "question-run-1",
    question: "How does this work?",
    runId: "run-1",
    generation: "generation-1",
    status: "completed",
    createdAt: "2026-09-01T00:00:00.000Z",
    answer: reviewedAnswer(),
  });
}

function cancelledDraft(id = "run-1", sessionId = "session-1") {
  return QuestionDraftInputSchema.parse({
    id,
    sessionId,
    annotationId: "annotation-1",
    question: "How does this work?",
    status: "cancelled",
    generation: "generation-1",
  });
}

function detachedValidatingDraft() {
  const { annotationId: _annotationId, ...draft } = cancelledDraft();
  return { ...draft, status: "validating" as const };
}

describe.each(["memory", "json"] as const)("%s repository reviewed-question commit", (kind) => {
  it("publishes the final completed annotation and removes its draft in one mutation", async () => {
    const directory = await temporaryDirectory(`reviewed-${kind}`);
    const observedReplacements: unknown[] = [];
    let observe = false;
    const repository = kind === "memory"
      ? new MemoryAnnotationRepository()
      : new JsonAnnotationRepository(join(directory, "annotations.json"), {
          beforeRename: async (temporaryPath) => {
            if (observe) {
              observedReplacements.push(JSON.parse(await readFile(temporaryPath, "utf8")));
            }
          },
        });
    await repository.upsertSession(session());
    await repository.saveDraft(detachedValidatingDraft());
    observe = true;
    const finalAnnotation = AnnotationThreadSchema.parse({
      ...annotation(),
      questions: [reviewedQuestion()],
    });

    await expect(repository.commitReviewedQuestion(finalAnnotation))
      .resolves.toEqual(finalAnnotation);

    await expect(repository.getAnnotation("annotation-1")).resolves.toEqual(finalAnnotation);
    await expect(repository.getDraft("run-1")).resolves.toBeUndefined();
    if (kind === "json") {
      expect(observedReplacements).toHaveLength(1);
      expect(observedReplacements[0]).toMatchObject({
        annotations: [{ value: finalAnnotation }],
        drafts: [],
      });
    }
  });

  it("preserves all state when the completed run does not match its draft", async () => {
    const directory = await temporaryDirectory(`reviewed-run-mismatch-${kind}`);
    const repository = kind === "memory"
      ? new MemoryAnnotationRepository()
      : new JsonAnnotationRepository(join(directory, "annotations.json"));
    await repository.upsertSession(session());
    await repository.saveDraft(detachedValidatingDraft());
    const baseline = await repository.load();
    const mismatched = AnnotationThreadSchema.parse({
      ...annotation(),
      questions: [QuestionRecordSchema.parse({
        ...reviewedQuestion(),
        question: "A different question",
      })],
    });

    await expect(repository.commitReviewedQuestion(mismatched))
      .rejects.toMatchObject({ code: "DRAFT_IDENTITY_MISMATCH" });
    await expect(repository.load()).resolves.toEqual(baseline);
  });

  it("rejects a completed answer that was not independently evidence-reviewed", async () => {
    const directory = await temporaryDirectory(`reviewed-status-${kind}`);
    const repository = kind === "memory"
      ? new MemoryAnnotationRepository()
      : new JsonAnnotationRepository(join(directory, "annotations.json"));
    await repository.upsertSession(session());
    await repository.saveDraft(detachedValidatingDraft());
    const baseline = await repository.load();

    await expect(repository.commitReviewedQuestion(AnnotationThreadSchema.parse({
      ...annotation(),
      questions: [completedQuestion()],
    }))).rejects.toMatchObject({ code: "REVIEWED_QUESTION_REQUIRED" });
    await expect(repository.load()).resolves.toEqual(baseline);
  });

  it("updates one existing non-terminal run without rewriting its annotation history", async () => {
    const directory = await temporaryDirectory(`reviewed-update-${kind}`);
    const repository = kind === "memory"
      ? new MemoryAnnotationRepository()
      : new JsonAnnotationRepository(join(directory, "annotations.json"));
    await repository.upsertSession(session());
    await repository.upsertAnnotation(annotation());
    await repository.saveDraft({ ...cancelledDraft(), status: "validating" });
    const finalAnnotation = AnnotationThreadSchema.parse({
      ...annotation(),
      questions: [reviewedQuestion()],
      disposition: "inline",
    });

    await expect(repository.commitReviewedQuestion(finalAnnotation))
      .resolves.toEqual(finalAnnotation);
    await expect(repository.getAnnotation("annotation-1")).resolves.toEqual(finalAnnotation);
    await expect(repository.getDraft("run-1")).resolves.toBeUndefined();
  });

  it("preserves annotation identity and rolls back the draft deletion on failure", async () => {
    const directory = await temporaryDirectory(`reviewed-anchor-mismatch-${kind}`);
    const repository = kind === "memory"
      ? new MemoryAnnotationRepository()
      : new JsonAnnotationRepository(join(directory, "annotations.json"));
    await repository.upsertSession(session());
    await repository.upsertAnnotation(annotation());
    await repository.saveDraft({ ...cancelledDraft(), status: "validating" });
    const baseline = await repository.load();
    const rebound = AnnotationThreadSchema.parse({
      ...annotation(),
      anchor: { ...annotation().anchor, selectedText: "worker" },
      questions: [reviewedQuestion()],
    });

    await expect(repository.commitReviewedQuestion(rebound))
      .rejects.toMatchObject({ code: "ANNOTATION_IDENTITY_MISMATCH" });
    await expect(repository.load()).resolves.toEqual(baseline);
  });
});

describe("JsonAnnotationRepository reviewed-question persistence", () => {
  it("leaves the old file intact when final atomic replacement fails", async () => {
    const directory = await temporaryDirectory("reviewed-write-failure");
    const path = join(directory, "annotations.json");
    const setup = new JsonAnnotationRepository(path);
    await setup.upsertSession(session());
    await setup.saveDraft(detachedValidatingDraft());
    const baseline = await setup.load();
    const repository = new JsonAnnotationRepository(path, {
      beforeRename: () => {
        throw new Error("stop reviewed commit");
      },
    });

    await expect(repository.commitReviewedQuestion(AnnotationThreadSchema.parse({
      ...annotation(),
      questions: [reviewedQuestion()],
    }))).rejects.toThrow("stop reviewed commit");

    await expect(setup.load()).resolves.toEqual(baseline);
  });
});

describe("JsonAnnotationRepository", () => {
  it("loads an empty schema-v1 store before the file exists", async () => {
    const directory = await temporaryDirectory("empty");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));

    expect(repository.persistenceStatus).toBe("persistent");
    await expect(repository.load()).resolves.toEqual(createEmptyAnnotationStore());
    expect(AnnotationStoreV1Schema.parse(await repository.load()).schemaVersion).toBe(1);
  });

  it("bounds reads even when the opened store grows after its initial size check", async () => {
    const directory = await temporaryDirectory("bounded-read");
    const path = join(directory, "annotations.json");
    await writeFile(path, JSON.stringify(createEmptyAnnotationStore()), "utf8");
    const repository = new JsonAnnotationRepository(path, {
      afterReadOpen: async () => {
        await writeFile(path, Buffer.alloc(MAX_ANNOTATION_STORE_BYTES + 1, 0x20));
      },
    });

    await expect(repository.load()).rejects.toMatchObject({ code: "STORE_TOO_LARGE" });
  });

  it("rejects a same-size store mutation observed through the opened handle", async () => {
    const directory = await temporaryDirectory("stable-read");
    const path = join(directory, "annotations.json");
    const initial = JSON.stringify(createEmptyAnnotationStore());
    const reordered = JSON.stringify({
      schemaVersion: 1,
      drafts: [],
      annotations: [],
      sessions: [],
    });
    expect(Buffer.byteLength(reordered)).toBe(Buffer.byteLength(initial));
    await writeFile(path, initial, "utf8");
    const repository = new JsonAnnotationRepository(path, {
      afterReadOpen: async () => {
        await writeFile(path, reordered, "utf8");
        // Make the metadata change observable even on coarse filesystem clocks.
        await utimes(path,new Date("2000-01-01T00:00:00Z"),new Date("2000-01-01T00:00:00Z"));
      },
    });

    await expect(repository.load()).rejects.toMatchObject({
      code: "STORE_CHANGED_DURING_READ",
    });
  });

  it("preserves the previous store when atomic replacement fails", async () => {
    const directory = await temporaryDirectory("atomic");
    const path = join(directory, "annotations.json");
    const repository = new JsonAnnotationRepository(path);
    await repository.upsertSession(session());
    const firstState = await repository.load();
    const failingRepository = new JsonAnnotationRepository(path, {
      beforeRename: () => {
        throw new Error("stop before rename");
      },
    });

    await expect(failingRepository.save({ ...firstState, sessions: [] }))
      .rejects.toThrow("stop before rename");
    await expect(repository.load()).resolves.toEqual(firstState);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("validates full-state identity transitions before public save", async () => {
    const directory = await temporaryDirectory("save-transition");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));
    await repository.upsertSession(session("session-1"));
    await repository.upsertSession(session("session-2"));
    await repository.upsertAnnotation(annotation());
    await repository.saveDraft(cancelledDraft());
    const baseline = await repository.load();
    const firstSession = baseline.sessions.find((record) => record.value.id === "session-1")!;
    const firstAnnotation = baseline.annotations[0]!;
    const firstDraft = baseline.drafts[0]!;

    await expect(repository.save({
      ...baseline,
      sessions: baseline.sessions.map((record) =>
        record.value.id === "session-1"
          ? { ...record, value: { ...record.value, rootId: "rebound-root" } }
          : record
      ),
    })).rejects.toMatchObject({ code: "SESSION_IDENTITY_MISMATCH" });
    await expect(repository.save({
      ...baseline,
      annotations: [{
        ...firstAnnotation,
        value: { ...firstAnnotation.value, sessionId: "session-2" },
      }],
      drafts: [],
    })).rejects.toMatchObject({ code: "ANNOTATION_IDENTITY_MISMATCH" });
    await expect(repository.save({
      ...baseline,
      drafts: [{
        ...firstDraft,
        value: {
          ...firstDraft.value,
          sessionId: "session-2",
          annotationId: undefined,
        },
      }],
    })).rejects.toMatchObject({ code: "DRAFT_IDENTITY_MISMATCH" });
    await expect(repository.save({
      ...baseline,
      annotations: [{
        ...firstAnnotation,
        value: {
          ...firstAnnotation.value,
          questions: [{ ...firstAnnotation.value.questions[0]!, runId: "run-rebound" }],
        },
        questionUpdatedAt: [{
          ...firstAnnotation.questionUpdatedAt[0]!,
          runId: "run-rebound",
        }],
      }],
    })).rejects.toMatchObject({ code: "QUESTION_RUN_IDENTITY_MISMATCH" });
    await expect(repository.save({
      ...baseline,
      annotations: [{
        ...firstAnnotation,
        value: {
          ...firstAnnotation.value,
          anchor: { ...firstAnnotation.value.anchor, documentPath: "OTHER.md" },
        },
      }],
    })).rejects.toMatchObject({ code: "INVALID_STORE_DATA" });

    await expect(repository.load()).resolves.toEqual(baseline);
    expect(firstSession.value.rootId).toBe("root-1");
  });

  it("never accepts or persists raw task identifiers and unknown metadata", async () => {
    const directory = await temporaryDirectory("redaction");
    const path = join(directory, "annotations.json");
    const repository = new JsonAnnotationRepository(path);

    await expect(repository.upsertSession({
      ...session(),
      parentThreadId: "thr_secret",
      sideThreadId: "turn_secret",
    })).rejects.toThrow();
    await expect(repository.save({
      ...createEmptyAnnotationStore(),
      callToolMetadata: { threadId: "thr_secret" },
    })).rejects.toThrow();
    await repository.upsertSession(session());
    expect(await readFile(path, "utf8")).not.toMatch(/thr_secret|turn_secret|callToolMetadata/u);
  });

  it("rejects unverified partial answers and unbounded tool traces in drafts", async () => {
    const directory = await temporaryDirectory("draft-boundary");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));
    const base = cancelledDraft();

    await expect(repository.saveDraft({
      ...base,
      partialAnswer: "This text was never validated.",
    })).rejects.toThrow();
    await expect(repository.saveDraft({
      ...base,
      toolTrace: Array.from({ length: 10_000 }, () => ({ output: "secret" })),
    })).rejects.toThrow();
    await expect(repository.getDraft(base.id)).resolves.toBeUndefined();
  });

  it("upserts sessions, annotations, drafts, and validated question runs", async () => {
    const directory = await temporaryDirectory("crud");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));
    await repository.upsertSession(session());
    await repository.upsertAnnotation(annotation());
    await repository.saveDraft(cancelledDraft());

    const failed = QuestionRecordSchema.parse({
      ...draftQuestion(),
      generation: "generation-1",
      status: "failed",
    });
    await repository.updateQuestionRun("annotation-1", failed);

    await expect(repository.getSession("session-1")).resolves.toEqual(session());
    await expect(repository.getDraft("run-1")).resolves.toMatchObject({
      id: "run-1",
      status: "cancelled",
    });
    expect((await repository.getAnnotation("annotation-1"))?.questions[0]).toEqual(failed);
  });

  it("rejects orphan annotations, orphan drafts, and cross-session draft references", async () => {
    const directory = await temporaryDirectory("references");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));

    await expect(repository.upsertAnnotation(annotation())).rejects.toThrow(/session/iu);
    await expect(repository.saveDraft(cancelledDraft())).rejects.toThrow(/session/iu);

    await repository.upsertSession(session("session-1"));
    await repository.upsertSession(session("session-2"));
    await repository.upsertAnnotation(annotation());
    await expect(repository.saveDraft({
      ...cancelledDraft(),
      sessionId: "session-2",
    })).rejects.toThrow(/annotation|session/iu);
  });

  it("does not let same-id upserts rebind session or annotation identity", async () => {
    const directory = await temporaryDirectory("identity");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));
    const originalSession = session();
    const originalAnnotation = annotation();
    await repository.upsertSession(originalSession);
    await repository.upsertSession(session("session-2"));
    await repository.upsertAnnotation(originalAnnotation);

    await expect(repository.upsertSession({
      ...originalSession,
      rootId: "different-root",
    })).rejects.toThrow(/identity|binding/iu);
    await expect(repository.upsertAnnotation({
      ...originalAnnotation,
      sessionId: "session-2",
    })).rejects.toThrow(/identity|session/iu);
    await expect(repository.upsertAnnotation({
      ...originalAnnotation,
      anchor: { ...originalAnnotation.anchor, selectedText: "worker" },
    })).rejects.toThrow(/identity|anchor/iu);

    await expect(repository.getSession("session-1")).resolves.toEqual(originalSession);
    await expect(repository.getAnnotation("annotation-1")).resolves.toEqual(originalAnnotation);
  });

  it("requires an annotation anchor to use its owning session document", async () => {
    const directory = await temporaryDirectory("anchor-document-binding");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));
    await repository.upsertSession(session());

    await expect(repository.upsertAnnotation({
      ...annotation(),
      anchor: { ...annotation().anchor, documentPath: "OTHER.md" },
    })).rejects.toMatchObject({ code: "DOCUMENT_BINDING_MISMATCH" });
  });

  it("requires a durable answer selected-document path to match its annotation", async () => {
    const directory = await temporaryDirectory("answer-document-binding");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));
    await repository.upsertSession(session());
    const wrongDocumentAnswer = EvidenceAnswerSchema.parse({
      ...unsupportedAnswer(),
      documentPath: "OTHER.md",
    });
    const question = QuestionRecordSchema.parse({
      ...completedQuestion(),
      answer: wrongDocumentAnswer,
    });

    await expect(repository.upsertAnnotation({
      ...annotation(),
      questions: [question],
    })).rejects.toMatchObject({ code: "DOCUMENT_BINDING_MISMATCH" });
    await repository.upsertAnnotation(annotation());
    await expect(repository.updateQuestionRun("annotation-1", question))
      .rejects.toMatchObject({ code: "DOCUMENT_BINDING_MISMATCH" });
  });

  it("does not let annotation upsert delete, rebind, or rewrite existing question runs", async () => {
    const directory = await temporaryDirectory("annotation-question-history");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));
    await repository.upsertSession(session());
    const second = draftQuestion("run-2");
    const original = AnnotationThreadSchema.parse({
      ...annotation(),
      questions: [draftQuestion(), second],
    });
    await repository.upsertAnnotation(original);

    await expect(repository.upsertAnnotation({
      ...original,
      questions: [draftQuestion()],
    })).rejects.toMatchObject({ code: "QUESTION_RUN_IDENTITY_MISMATCH" });
    await expect(repository.upsertAnnotation({
      ...original,
      questions: [
        { ...draftQuestion(), runId: "run-rebound" },
        second,
      ],
    })).rejects.toMatchObject({ code: "QUESTION_RUN_IDENTITY_MISMATCH" });
    await expect(repository.upsertAnnotation({
      ...original,
      questions: [
        {
          ...draftQuestion(),
          generation: "generation-1",
          status: "failed",
        },
        second,
      ],
    })).rejects.toMatchObject({ code: "QUESTION_RUN_IDENTITY_MISMATCH" });

    await expect(repository.upsertAnnotation({
      ...original,
      stale: true,
    })).resolves.toMatchObject({ stale: true, questions: original.questions });
  });

  it("allows draft content updates but never rebinds a draft id to another owner", async () => {
    const directory = await temporaryDirectory("draft-identity");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));
    await repository.upsertSession(session("session-1"));
    await repository.upsertSession(session("session-2"));
    await repository.upsertAnnotation(annotation());
    const standalone = QuestionDraftInputSchema.parse({
      id: "run-standalone",
      sessionId: "session-1",
      question: "Initial question",
      status: "cancelled",
      generation: "generation-1",
    });
    await repository.saveDraft(standalone);
    await expect(repository.saveDraft({
      ...standalone,
      sessionId: "session-2",
    })).rejects.toMatchObject({ code: "DRAFT_IDENTITY_MISMATCH" });

    const anchored = cancelledDraft("run-anchored");
    await repository.saveDraft(anchored);
    const { annotationId: _removed, ...detached } = anchored;
    await expect(repository.saveDraft(detached)).rejects.toMatchObject({
      code: "DRAFT_IDENTITY_MISMATCH",
    });

    await expect(repository.saveDraft({
      ...standalone,
      question: "Updated question",
      status: "failed",
    })).resolves.toMatchObject({
      value: {
        id: "run-standalone",
        sessionId: "session-1",
        question: "Updated question",
        status: "failed",
      },
    });
  });

  it("requires both question id and run id to match when updating an existing run", async () => {
    const directory = await temporaryDirectory("run-identity");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));
    await repository.upsertSession(session());
    await repository.upsertAnnotation(annotation());
    const failed = QuestionRecordSchema.parse({
      ...draftQuestion(),
      generation: "generation-1",
      status: "failed",
    });

    await expect(repository.updateQuestionRun("annotation-1", {
      ...failed,
      runId: "run-rebound",
    })).rejects.toThrow(/identity|run/iu);
    await expect(repository.updateQuestionRun("annotation-1", {
      ...failed,
      id: "question-rebound",
    })).rejects.toThrow(/identity|run/iu);
    expect((await repository.getAnnotation("annotation-1"))?.questions)
      .toEqual([draftQuestion()]);
  });

  it("serializes concurrent mutations without losing records", async () => {
    const directory = await temporaryDirectory("concurrent");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));

    await Promise.all([
      repository.upsertSession(session("session-a")),
      repository.upsertSession(session("session-b")),
    ]);

    expect((await repository.load()).sessions.map((record) => record.value.id).sort())
      .toEqual(["session-a", "session-b"]);
  });

  it("serializes read-modify-write across repository instances sharing one file", async () => {
    const directory = await temporaryDirectory("multi-instance");
    const path = join(directory, "annotations.json");
    let releaseFirst!: () => void;
    let firstReachedRename!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstAtRename = new Promise<void>((resolve) => {
      firstReachedRename = resolve;
    });
    const first = new JsonAnnotationRepository(path, {
      beforeRename: async () => {
        firstReachedRename();
        await firstPaused;
      },
    });
    const second = new JsonAnnotationRepository(path);

    const firstWrite = first.upsertSession(session("session-a"));
    await firstAtRename;
    const secondWrite = second.upsertSession(session("session-b"));
    await Promise.race([
      secondWrite.then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ]);
    releaseFirst();
    await Promise.all([firstWrite, secondWrite]);

    expect((await second.load()).sessions.map((record) => record.value.id).sort())
      .toEqual(["session-a", "session-b"]);
  });

  it("marks only annotations whose durable answer uses the stale snapshot", async () => {
    const directory = await temporaryDirectory("stale");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));
    await repository.upsertSession(session());
    const first = annotation("annotation-a");
    const second = annotation("annotation-b");
    await repository.upsertAnnotation({
      ...first,
      questions: [completedQuestion(SNAPSHOT_A)],
    });
    await repository.upsertAnnotation({
      ...second,
      questions: [completedQuestion(SNAPSHOT_B)],
    });

    await expect(repository.markStaleBySnapshot(SNAPSHOT_A)).resolves.toBe(1);
    await expect(repository.getAnnotation("annotation-a")).resolves.toMatchObject({ stale: true });
    await expect(repository.getAnnotation("annotation-b")).resolves.toMatchObject({ stale: false });
  });

  it("deletes a session and its annotations and drafts", async () => {
    const directory = await temporaryDirectory("delete");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));
    await repository.upsertSession(session());
    await repository.upsertAnnotation(annotation());
    await repository.saveDraft(cancelledDraft());

    await repository.deleteSession("session-1");

    await expect(repository.getSession("session-1")).resolves.toBeUndefined();
    await expect(repository.getAnnotation("annotation-1")).resolves.toBeUndefined();
    await expect(repository.getDraft("run-1")).resolves.toBeUndefined();
  });

  it("prunes completed/session records independently from longer-lived drafts", async () => {
    const directory = await temporaryDirectory("prune");
    let now = new Date("2026-01-01T00:00:00.000Z");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"), {
      now: () => now,
      retentionDays: 30,
      draftRetentionDays: 90,
    });
    await repository.upsertSession(session());
    await repository.upsertAnnotation({
      ...annotation(),
      questions: [QuestionRecordSchema.parse({
        ...completedQuestion(),
        createdAt: "2026-01-01T00:00:00.000Z",
      })],
    });
    await repository.saveDraft(cancelledDraft("run-old"));
    now = new Date("2026-08-15T00:00:00.000Z");
    await repository.saveDraft(QuestionDraftInputSchema.parse({
      id: "run-recent",
      sessionId: "session-1",
      question: "How does this work?",
      status: "cancelled",
      generation: "generation-1",
    }));

    await repository.pruneBefore(
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z"),
    );

    await expect(repository.getSession("session-1")).resolves.toBeDefined();
    await expect(repository.getAnnotation("annotation-1")).resolves.toBeUndefined();
    await expect(repository.getDraft("run-old")).resolves.toBeUndefined();
    await expect(repository.getDraft("run-recent")).resolves.toBeDefined();
  });

  it("retains the parent annotation and session of a draft within draft retention", async () => {
    const directory = await temporaryDirectory("prune-draft-closure");
    let now = new Date("2026-01-01T00:00:00.000Z");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"), {
      now: () => now,
      retentionDays: 30,
      draftRetentionDays: 90,
    });
    await repository.upsertSession(session());
    await repository.upsertAnnotation(annotation());
    now = new Date("2026-08-15T00:00:00.000Z");
    await repository.saveDraft(cancelledDraft());

    await repository.pruneBefore(
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z"),
    );

    await expect(repository.getDraft("run-1")).resolves.toBeDefined();
    await expect(repository.getAnnotation("annotation-1")).resolves.toBeDefined();
    await expect(repository.getSession("session-1")).resolves.toBeDefined();
  });

  it("rejects a draft cutoff newer than the completed-record cutoff", async () => {
    const directory = await temporaryDirectory("prune-cutoff-order");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));

    await expect(repository.pruneBefore(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-09-01T00:00:00.000Z"),
    )).rejects.toThrow(/draftsBefore.*recordsBefore|cutoff/iu);
  });

  it("prunes an expired terminal run without deleting a newer active question", async () => {
    const directory = await temporaryDirectory("prune-runs");
    let now = new Date("2026-01-01T00:00:00.000Z");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"), {
      now: () => now,
      retentionDays: 30,
      draftRetentionDays: 90,
    });
    await repository.upsertSession(session());
    const oldCompleted = QuestionRecordSchema.parse({
      ...completedQuestion(),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await repository.upsertAnnotation({
      ...annotation(),
      questions: [oldCompleted],
    });
    now = new Date("2026-08-15T00:00:00.000Z");
    const recentDraft = QuestionRecordSchema.parse({
      id: "question-run-2",
      question: "What should I inspect next?",
      runId: "run-2",
      status: "draft",
      createdAt: "2026-08-15T00:00:00.000Z",
    });
    await repository.updateQuestionRun("annotation-1", recentDraft);

    await repository.pruneBefore(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-05-01T00:00:00.000Z"),
    );

    expect((await repository.getAnnotation("annotation-1"))?.questions).toEqual([recentDraft]);
  });

  it("retains a recently completed run even when the question was created earlier", async () => {
    const directory = await temporaryDirectory("run-update-time");
    let now = new Date("2026-01-01T00:00:00.000Z");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"), {
      now: () => now,
      retentionDays: 30,
      draftRetentionDays: 90,
    });
    await repository.upsertSession(session());
    const oldDraft = QuestionRecordSchema.parse({
      ...draftQuestion(),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await repository.upsertAnnotation({
      ...annotation(),
      questions: [oldDraft],
    });
    now = new Date("2026-08-15T00:00:00.000Z");
    const recentlyCompleted = QuestionRecordSchema.parse({
      ...completedQuestion(),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await repository.updateQuestionRun("annotation-1", recentlyCompleted);

    await repository.pruneBefore(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-05-01T00:00:00.000Z"),
    );

    expect((await repository.getAnnotation("annotation-1"))?.questions)
      .toEqual([recentlyCompleted]);
  });

  it("rejects malformed schema versions instead of accepting unknown durable data", async () => {
    const directory = await temporaryDirectory("invalid-load");
    const path = join(directory, "annotations.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: 2,
      sessions: [],
      annotations: [],
      drafts: [],
    }), "utf8");

    await expect(new JsonAnnotationRepository(path).load()).rejects.toThrow(/schema|version|literal/iu);
  });

  it("rejects durable records whose update timestamp predates creation", async () => {
    const directory = await temporaryDirectory("invalid-timestamps");
    const repository = new JsonAnnotationRepository(join(directory, "annotations.json"));
    const invalid = {
      ...createEmptyAnnotationStore(),
      sessions: [{
        value: session(),
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }],
    };

    await expect(repository.save(invalid)).rejects.toThrow(/timestamp|created|updated/iu);

    await expect(repository.save({
      ...createEmptyAnnotationStore(),
      annotations: [{
        value: annotation(),
        questionUpdatedAt: [{
          runId: "run-1",
          updatedAt: "2025-12-01T00:00:00.000Z",
        }],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      }],
    })).rejects.toThrow(/timestamp|created|updated/iu);
  });
});

describe("openAnnotationRepository", () => {
  it("fails closed before probing when the issued data directory is swapped into the project", async () => {
    const projectRoot = await temporaryDirectory("factory-authority-project");
    const externalBase = await temporaryDirectory("factory-authority-data");
    const projectStorage = join(projectRoot, "private-storage");
    await mkdir(projectStorage);
    const config = loadReaderConfig(
      { AIMD_DATA_DIR: externalBase },
      { projectRoot, userDataBaseDir: externalBase },
    );
    const authority = getReaderStorageAuthority(config);

    await expect(openAnnotationRepository(authority, {
      afterDirectoryReady: async (dataDir) => {
        await rm(dataDir, { recursive: true, force: true });
        await symlink(
          projectStorage,
          dataDir,
          process.platform === "win32" ? "junction" : "dir",
        );
      },
    })).rejects.toMatchObject({ code: "INVALID_STORE_PATH" });
    expect(await readdir(projectStorage)).toEqual([]);
  });

  it("returns an explicit memory_only repository when the requested directory is unavailable", async () => {
    const parent = await temporaryDirectory("memory-only");
    const projectRoot = await temporaryDirectory("memory-only-project");
    const blockingFile = join(parent, "not-a-directory");
    await writeFile(blockingFile, "blocked", "utf8");
    const unavailable = join(blockingFile, "reader-data");
    const config = loadReaderConfig(
      { AIMD_DATA_DIR: unavailable },
      { projectRoot, userDataBaseDir: parent },
    );

    const repository = await openAnnotationRepository(getReaderStorageAuthority(config));

    expect(repository.persistenceStatus).toBe("memory_only");
    await repository.upsertSession(session());
    await expect(repository.getSession("session-1")).resolves.toEqual(session());
    await expect(readdir(unavailable)).rejects.toThrow();
    expect(await readdir(parent)).toEqual(["not-a-directory"]);
  });

  it("creates only the requested user-data directory and persists there", async () => {
    const parent = await temporaryDirectory("open-persistent");
    const projectRoot = await temporaryDirectory("open-persistent-project");
    const requestedBase = join(parent, "reader-data");
    const config = loadReaderConfig(
      { AIMD_DATA_DIR: requestedBase },
      { projectRoot, userDataBaseDir: parent },
    );

    const repository = await openAnnotationRepository(getReaderStorageAuthority(config));
    await repository.upsertSession(session());

    expect(repository.persistenceStatus).toBe("persistent");
    expect(await readdir(config.dataDir)).toContain("annotations.v1.json");
  });
});
