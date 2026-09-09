import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import {
  AnnotationThreadSchema,
  OpaqueIdSchema,
  QuestionRecordSchema,
  ReaderSessionSchema,
  Sha256DigestSchema,
  type AnnotationThread,
  type ReaderSession,
} from "@aimd/contracts";
import { z } from "zod";

import { isCanonicalPathContained, sameCanonicalPath } from "./canonical-path.js";
import {
  resolveReaderStorageAuthority,
  type ReaderStorageAuthority,
} from "./config.js";

export const ANNOTATION_STORE_SCHEMA_VERSION = 1 as const;
export const MAX_ANNOTATION_STORE_BYTES = 16 * 1_024 * 1_024;
export const MAX_STORE_RECORDS_PER_COLLECTION = 4_096;

const MILLISECONDS_PER_DAY = 86_400_000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_DRAFT_RETENTION_DAYS = 90;
const DEFAULT_STORE_LOCK_TIMEOUT_MS = 5_000;
const STORE_LOCK_RETRY_MS = 10;
const TERMINAL_QUESTION_STATUSES = new Set([
  "completed",
  "stale",
  "failed",
  "cancelled",
]);
const CreatedAtSchema = z.iso.datetime({ offset: true, precision: 3 }).max(35);

function sameHandleState(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function authorityPathValue(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function sameAuthorityPath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  return sameCanonicalPath(
    authorityPathValue(left, platform),
    authorityPathValue(right, platform),
    platform,
  );
}

function isAuthorityPathContained(
  root: string,
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  return isCanonicalPathContained(
    authorityPathValue(root, platform),
    authorityPathValue(candidate, platform),
    platform,
  );
}

function refineTimestampOrder(
  record: { createdAt: string; updatedAt: string },
  context: z.RefinementCtx,
): void {
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    context.addIssue({
      code: "custom",
      path: ["updatedAt"],
      message: "Record update timestamp cannot predate creation",
    });
  }
}

const StoredSessionSchema = z
  .object({
    value: ReaderSessionSchema,
    createdAt: CreatedAtSchema,
    updatedAt: CreatedAtSchema,
  })
  .strict()
  .superRefine(refineTimestampOrder);

const StoredAnnotationSchema = z
  .object({
    value: AnnotationThreadSchema,
    questionUpdatedAt: z
      .array(z.object({
        runId: OpaqueIdSchema,
        updatedAt: CreatedAtSchema,
      }).strict())
      .max(64),
    createdAt: CreatedAtSchema,
    updatedAt: CreatedAtSchema,
  })
  .strict()
  .superRefine((record, context) => {
    refineTimestampOrder(record, context);
    for (const [index, question] of record.questionUpdatedAt.entries()) {
      if (
        Date.parse(question.updatedAt) < Date.parse(record.createdAt) ||
        Date.parse(question.updatedAt) > Date.parse(record.updatedAt)
      ) {
        context.addIssue({
          code: "custom",
          path: ["questionUpdatedAt", index, "updatedAt"],
          message: "Question update timestamp must fall within the annotation record lifetime",
        });
      }
    }
    const questionRunIds = record.value.questions.map((question) => question.runId);
    const timestampRunIds = record.questionUpdatedAt.map((question) => question.runId);
    if (
      new Set(timestampRunIds).size !== timestampRunIds.length ||
      questionRunIds.length !== timestampRunIds.length ||
      questionRunIds.some((runId) => !timestampRunIds.includes(runId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["questionUpdatedAt"],
        message: "Question update timestamps must match annotation run ids exactly",
      });
    }
  });

export const QuestionDraftInputSchema = z
  .object({
    id: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    annotationId: OpaqueIdSchema.optional(),
    question: z.string().min(1).max(8_192).refine((value) => value.trim().length > 0),
    status: z.enum([
      "draft",
      "queued",
      "inspecting",
      "streaming_unverified",
      "validating",
      "stale",
      "failed",
      "cancelled",
    ]),
    generation: OpaqueIdSchema.optional(),
  })
  .strict()
  .superRefine((draft, context) => {
    if (draft.status !== "draft" && draft.generation === undefined) {
      context.addIssue({
        code: "custom",
        path: ["generation"],
        message: "A started draft must identify its generation",
      });
    }
  });

const StoredQuestionDraftSchema = z
  .object({
    value: QuestionDraftInputSchema,
    createdAt: CreatedAtSchema,
    updatedAt: CreatedAtSchema,
  })
  .strict()
  .superRefine(refineTimestampOrder);

function addDuplicateIssue(
  values: readonly string[],
  path: string,
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path: [path], message: `${path} ids must be unique` });
  }
}

function hasDocumentBindingMismatch(
  session: ReaderSession,
  annotation: AnnotationThread,
): boolean {
  if (annotation.anchor.documentPath !== session.documentPath) return true;
  return annotation.questions.some((question) => {
    const answer = question.answer;
    if (answer === undefined) return false;
    if (
      answer.documentPath !== undefined &&
      answer.documentPath !== annotation.anchor.documentPath
    ) return true;
    return answer.contextMode === "document_only" && answer.evidence.some(
      (evidence) =>
        evidence.kind === "project_document" &&
        evidence.path !== annotation.anchor.documentPath,
    );
  });
}

export const AnnotationStoreV1Schema = z
  .object({
    schemaVersion: z.literal(ANNOTATION_STORE_SCHEMA_VERSION),
    sessions: z.array(StoredSessionSchema).max(MAX_STORE_RECORDS_PER_COLLECTION),
    annotations: z.array(StoredAnnotationSchema).max(MAX_STORE_RECORDS_PER_COLLECTION),
    drafts: z.array(StoredQuestionDraftSchema).max(MAX_STORE_RECORDS_PER_COLLECTION),
  })
  .strict()
  .superRefine((store, context) => {
    addDuplicateIssue(store.sessions.map((record) => record.value.id), "sessions", context);
    addDuplicateIssue(store.annotations.map((record) => record.value.id), "annotations", context);
    addDuplicateIssue(store.drafts.map((record) => record.value.id), "drafts", context);
    const sessionById = new Map(
      store.sessions.map((record) => [record.value.id, record.value]),
    );
    const annotationById = new Map(
      store.annotations.map((record) => [record.value.id, record.value]),
    );
    for (const [index, record] of store.annotations.entries()) {
      const session = sessionById.get(record.value.sessionId);
      if (session === undefined) {
        context.addIssue({
          code: "custom",
          path: ["annotations", index, "value", "sessionId"],
          message: "Annotation session must exist in the same store",
        });
      } else if (hasDocumentBindingMismatch(session, record.value)) {
        context.addIssue({
          code: "custom",
          path: ["annotations", index, "value", "anchor", "documentPath"],
          message: "Annotation and durable answers must use the owning session document",
        });
      }
    }
    for (const [index, record] of store.drafts.entries()) {
      if (!sessionById.has(record.value.sessionId)) {
        context.addIssue({
          code: "custom",
          path: ["drafts", index, "value", "sessionId"],
          message: "Draft session must exist in the same store",
        });
      }
      if (record.value.annotationId !== undefined) {
        const annotation = annotationById.get(record.value.annotationId);
        if (annotation === undefined || annotation.sessionId !== record.value.sessionId) {
          context.addIssue({
            code: "custom",
            path: ["drafts", index, "value", "annotationId"],
            message: "Draft annotation must exist in the same session",
          });
        }
      }
    }
  });

export type AnnotationStoreV1 = z.infer<typeof AnnotationStoreV1Schema>;
export type QuestionDraftInput = z.infer<typeof QuestionDraftInputSchema>;
export type StoredQuestionDraft = z.infer<typeof StoredQuestionDraftSchema>;
export type PersistenceStatus = "persistent" | "memory_only";

export function createEmptyAnnotationStore(): AnnotationStoreV1 {
  return {
    schemaVersion: ANNOTATION_STORE_SCHEMA_VERSION,
    sessions: [],
    annotations: [],
    drafts: [],
  };
}

export class AnnotationStoreError extends Error {
  constructor(
    readonly code:
      | "INVALID_STORE_PATH"
      | "INVALID_STORE_DATA"
      | "STORE_TOO_LARGE"
      | "STORE_CHANGED_DURING_READ"
      | "ANNOTATION_NOT_FOUND"
      | "SESSION_NOT_FOUND"
      | "SESSION_IDENTITY_MISMATCH"
      | "ANNOTATION_IDENTITY_MISMATCH"
      | "DRAFT_IDENTITY_MISMATCH"
      | "DOCUMENT_BINDING_MISMATCH"
      | "QUESTION_RUN_IDENTITY_MISMATCH"
      | "REVIEWED_QUESTION_REQUIRED"
      | "STORE_LOCK_TIMEOUT",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AnnotationStoreError";
  }
}

function assertQuestionHistoryPreserved(
  previous: AnnotationThread["questions"],
  next: AnnotationThread["questions"],
): void {
  const nextById = new Map(next.map((question) => [question.id, question]));
  const nextByRunId = new Map(next.map((question) => [question.runId, question]));
  for (const question of previous) {
    const sameId = nextById.get(question.id);
    const sameRun = nextByRunId.get(question.runId);
    if (
      sameId === undefined ||
      sameRun === undefined ||
      sameId !== sameRun ||
      JSON.stringify(sameId) !== JSON.stringify(question)
    ) {
      throw new AnnotationStoreError(
        "QUESTION_RUN_IDENTITY_MISMATCH",
        "Existing question runs cannot be deleted, rebound, or rewritten by annotation upsert",
      );
    }
  }
}

function assertDocumentBinding(
  session: ReaderSession,
  annotation: AnnotationThread,
): void {
  if (hasDocumentBindingMismatch(session, annotation)) {
    throw new AnnotationStoreError(
      "DOCUMENT_BINDING_MISMATCH",
      "Annotation and durable answers must use the owning session document",
    );
  }
}

function assertStoreTransition(
  previous: AnnotationStoreV1,
  next: AnnotationStoreV1,
): void {
  const nextSessionById = new Map(next.sessions.map((record) => [record.value.id, record.value]));
  for (const record of previous.sessions) {
    const replacement = nextSessionById.get(record.value.id);
    if (
      replacement !== undefined &&
      JSON.stringify(replacement) !== JSON.stringify(record.value)
    ) {
      throw new AnnotationStoreError(
        "SESSION_IDENTITY_MISMATCH",
        "Session identity and binding cannot be changed by full-state save",
      );
    }
  }

  const nextAnnotationById = new Map(
    next.annotations.map((record) => [record.value.id, record.value]),
  );
  for (const record of previous.annotations) {
    const replacement = nextAnnotationById.get(record.value.id);
    if (replacement === undefined) continue;
    if (
      replacement.sessionId !== record.value.sessionId ||
      JSON.stringify(replacement.anchor) !== JSON.stringify(record.value.anchor)
    ) {
      throw new AnnotationStoreError(
        "ANNOTATION_IDENTITY_MISMATCH",
        "Annotation session and anchor identity cannot be changed by full-state save",
      );
    }
    assertQuestionHistoryPreserved(record.value.questions, replacement.questions);
  }

  const nextDraftById = new Map(next.drafts.map((record) => [record.value.id, record.value]));
  for (const record of previous.drafts) {
    const replacement = nextDraftById.get(record.value.id);
    if (
      replacement !== undefined &&
      (
        replacement.sessionId !== record.value.sessionId ||
        replacement.annotationId !== record.value.annotationId
      )
    ) {
      throw new AnnotationStoreError(
        "DRAFT_IDENTITY_MISMATCH",
        "Draft session and annotation ownership cannot be changed by full-state save",
      );
    }
  }

  const nextQuestionById = new Map<string, { annotationId: string; runId: string }>();
  const nextQuestionByRunId = new Map<string, { annotationId: string; id: string }>();
  for (const record of next.annotations) {
    for (const question of record.value.questions) {
      nextQuestionById.set(question.id, {
        annotationId: record.value.id,
        runId: question.runId,
      });
      nextQuestionByRunId.set(question.runId, {
        annotationId: record.value.id,
        id: question.id,
      });
    }
  }
  for (const record of previous.annotations) {
    for (const question of record.value.questions) {
      const byId = nextQuestionById.get(question.id);
      const byRunId = nextQuestionByRunId.get(question.runId);
      if (
        (byId !== undefined || byRunId !== undefined) &&
        (
          byId?.annotationId !== record.value.id ||
          byId.runId !== question.runId ||
          byRunId?.annotationId !== record.value.id ||
          byRunId.id !== question.id
        )
      ) {
        throw new AnnotationStoreError(
          "QUESTION_RUN_IDENTITY_MISMATCH",
          "Question and run ownership cannot be rebound by full-state save",
        );
      }
    }
  }
}

export interface AnnotationRepository {
  readonly persistenceStatus: PersistenceStatus;
  load(): Promise<AnnotationStoreV1>;
  save(value: unknown): Promise<void>;
  upsertSession(value: unknown): Promise<ReaderSession>;
  getSession(id: string): Promise<ReaderSession | undefined>;
  upsertAnnotation(value: unknown): Promise<AnnotationThread>;
  getAnnotation(id: string): Promise<AnnotationThread | undefined>;
  saveDraft(value: unknown): Promise<StoredQuestionDraft>;
  getDraft(id: string): Promise<StoredQuestionDraft["value"] | undefined>;
  commitReviewedQuestion(value: unknown): Promise<AnnotationThread>;
  updateQuestionRun(annotationId: string, value: unknown): Promise<AnnotationThread>;
  markStaleBySnapshot(snapshotDigest: string): Promise<number>;
  deleteSession(sessionId: string): Promise<boolean>;
  pruneBefore(recordsBefore: Date, draftsBefore?: Date): Promise<void>;
}

export interface AnnotationRepositoryOptions {
  /** Internal bounded-read race seam; production callers must omit it. */
  afterReadOpen?: () => void | Promise<void>;
  /** Internal adversarial-race test seam; production callers must omit it. */
  afterDirectoryReady?: (dataDir: string) => void | Promise<void>;
  beforeRename?: (temporaryPath: string, destinationPath: string) => void | Promise<void>;
  now?: () => Date;
  retentionDays?: number;
  draftRetentionDays?: number;
  lockTimeoutMs?: number;
}

function parseStore(value: unknown): AnnotationStoreV1 {
  const parsed = AnnotationStoreV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new AnnotationStoreError(
      "INVALID_STORE_DATA",
      `Stored annotation data does not match schema version 1: ${parsed.error.issues[0]?.message ?? "invalid data"}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function storeBytes(value: AnnotationStoreV1): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_ANNOTATION_STORE_BYTES) {
    throw new AnnotationStoreError("STORE_TOO_LARGE", "Annotation store exceeds its byte limit");
  }
  return bytes;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid Date`);
  }
  return value;
}

function validateRetention(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 3_650) {
    throw new TypeError(`${label} must be an integer from 1 to 3650`);
  }
  return resolved;
}

abstract class AnnotationRepositoryBase implements AnnotationRepository {
  abstract readonly persistenceStatus: PersistenceStatus;
  private mutationQueue: Promise<void> = Promise.resolve();
  protected readonly now: () => Date;
  protected readonly retentionDays: number;
  protected readonly draftRetentionDays: number;

  constructor(options: AnnotationRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.retentionDays = validateRetention(options.retentionDays, DEFAULT_RETENTION_DAYS, "retentionDays");
    this.draftRetentionDays = validateRetention(
      options.draftRetentionDays,
      DEFAULT_DRAFT_RETENTION_DAYS,
      "draftRetentionDays",
    );
    if (this.draftRetentionDays < this.retentionDays) {
      throw new TypeError("draftRetentionDays must not be shorter than retentionDays");
    }
  }

  protected abstract readState(): Promise<AnnotationStoreV1>;
  protected abstract writeState(value: AnnotationStoreV1): Promise<void>;
  protected withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private timestamp(): string {
    const value = this.now();
    validDate(value, "now()");
    return value.toISOString();
  }

  private mutate<T>(
    operation: (store: AnnotationStoreV1, timestamp: string) => T,
  ): Promise<T> {
    return this.serialized(() => this.withMutationLock(async () => {
      const store = await this.readState();
      const result = operation(store, this.timestamp());
      const parsed = parseStore(store);
      storeBytes(parsed);
      await this.writeState(parsed);
      return result;
    }));
  }

  load(): Promise<AnnotationStoreV1> {
    return this.serialized(async () => parseStore(await this.readState()));
  }

  async save(value: unknown): Promise<void> {
    const parsed = parseStore(value);
    storeBytes(parsed);
    await this.serialized(() => this.withMutationLock(async () => {
      const previous = await this.readState();
      assertStoreTransition(previous, parsed);
      await this.writeState(parsed);
    }));
  }

  async upsertSession(value: unknown): Promise<ReaderSession> {
    const session = ReaderSessionSchema.parse(value);
    return this.mutate((store, timestamp) => {
      const index = store.sessions.findIndex((record) => record.value.id === session.id);
      if (
        index >= 0 &&
        JSON.stringify(store.sessions[index]!.value) !== JSON.stringify(session)
      ) {
        throw new AnnotationStoreError(
          "SESSION_IDENTITY_MISMATCH",
          "Session identity and binding cannot be changed by same-id upsert",
        );
      }
      const record = {
        value: session,
        createdAt: index < 0 ? timestamp : store.sessions[index]!.createdAt,
        updatedAt: timestamp,
      };
      if (index < 0) store.sessions.push(record);
      else store.sessions[index] = record;
      return session;
    });
  }

  async getSession(id: string): Promise<ReaderSession | undefined> {
    const parsedId = OpaqueIdSchema.parse(id);
    const store = await this.load();
    return store.sessions.find((record) => record.value.id === parsedId)?.value;
  }

  async upsertAnnotation(value: unknown): Promise<AnnotationThread> {
    const annotation = AnnotationThreadSchema.parse(value);
    return this.mutate((store, timestamp) => {
      const owningSession = store.sessions.find(
        (record) => record.value.id === annotation.sessionId,
      )?.value;
      if (owningSession === undefined) {
        throw new AnnotationStoreError("SESSION_NOT_FOUND", "Annotation session was not found");
      }
      assertDocumentBinding(owningSession, annotation);
      const index = store.annotations.findIndex((record) => record.value.id === annotation.id);
      const previous = index < 0 ? undefined : store.annotations[index]!;
      if (
        previous !== undefined &&
        (
          previous.value.sessionId !== annotation.sessionId ||
          JSON.stringify(previous.value.anchor) !== JSON.stringify(annotation.anchor)
        )
      ) {
        throw new AnnotationStoreError(
          "ANNOTATION_IDENTITY_MISMATCH",
          "Annotation session and anchor identity cannot be changed by same-id upsert",
        );
      }
      if (previous !== undefined) {
        assertQuestionHistoryPreserved(previous.value.questions, annotation.questions);
      }
      const previousUpdates = new Map(
        previous?.questionUpdatedAt.map((question) => [question.runId, question.updatedAt]),
      );
      const previousQuestions = new Map(
        previous?.value.questions.map((question) => [question.runId, JSON.stringify(question)]),
      );
      const record = {
        value: annotation,
        questionUpdatedAt: annotation.questions.map((question) => ({
          runId: question.runId,
          updatedAt:
            previousQuestions.get(question.runId) === JSON.stringify(question)
              ? previousUpdates.get(question.runId) ?? timestamp
              : timestamp,
        })),
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (index < 0) store.annotations.push(record);
      else store.annotations[index] = record;
      return annotation;
    });
  }

  async getAnnotation(id: string): Promise<AnnotationThread | undefined> {
    const parsedId = OpaqueIdSchema.parse(id);
    const store = await this.load();
    return store.annotations.find((record) => record.value.id === parsedId)?.value;
  }

  async saveDraft(value: unknown): Promise<StoredQuestionDraft> {
    const draft = QuestionDraftInputSchema.parse(value);
    return this.mutate((store, timestamp) => {
      const index = store.drafts.findIndex((record) => record.value.id === draft.id);
      const previous = index < 0 ? undefined : store.drafts[index]!;
      if (
        previous !== undefined &&
        (
          previous.value.sessionId !== draft.sessionId ||
          previous.value.annotationId !== draft.annotationId
        )
      ) {
        throw new AnnotationStoreError(
          "DRAFT_IDENTITY_MISMATCH",
          "Draft session and annotation ownership cannot be changed by same-id update",
        );
      }
      if (!store.sessions.some((record) => record.value.id === draft.sessionId)) {
        throw new AnnotationStoreError("SESSION_NOT_FOUND", "Draft session was not found");
      }
      if (draft.annotationId !== undefined) {
        const annotation = store.annotations.find(
          (record) => record.value.id === draft.annotationId,
        )?.value;
        if (annotation === undefined || annotation.sessionId !== draft.sessionId) {
          throw new AnnotationStoreError(
            "ANNOTATION_IDENTITY_MISMATCH",
            "Draft annotation must exist in the same session",
          );
        }
      }
      const record = {
        value: draft,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (index < 0) store.drafts.push(record);
      else store.drafts[index] = record;
      return record;
    });
  }

  async getDraft(id: string): Promise<StoredQuestionDraft["value"] | undefined> {
    const parsedId = OpaqueIdSchema.parse(id);
    const store = await this.load();
    return store.drafts.find((record) => record.value.id === parsedId)?.value;
  }

  async commitReviewedQuestion(value: unknown): Promise<AnnotationThread> {
    const annotation = AnnotationThreadSchema.parse(value);
    return this.mutate((store, timestamp) => {
      const owningSession = store.sessions.find(
        (record) => record.value.id === annotation.sessionId,
      )?.value;
      if (owningSession === undefined) {
        throw new AnnotationStoreError("SESSION_NOT_FOUND", "Annotation session was not found");
      }
      assertDocumentBinding(owningSession, annotation);

      const annotationIndex = store.annotations.findIndex(
        (record) => record.value.id === annotation.id,
      );
      const previous = annotationIndex < 0 ? undefined : store.annotations[annotationIndex]!;
      if (
        previous !== undefined &&
        (
          previous.value.sessionId !== annotation.sessionId ||
          JSON.stringify(previous.value.anchor) !== JSON.stringify(annotation.anchor)
        )
      ) {
        throw new AnnotationStoreError(
          "ANNOTATION_IDENTITY_MISMATCH",
          "Annotation session and anchor identity cannot be changed by reviewed-question commit",
        );
      }

      const previousById = new Map(
        previous?.value.questions.map((question) => [question.id, question]),
      );
      const previousByRunId = new Map(
        previous?.value.questions.map((question) => [question.runId, question]),
      );
      const changedQuestions = [];
      for (const question of annotation.questions) {
        const byId = previousById.get(question.id);
        const byRunId = previousByRunId.get(question.runId);
        if (byId !== byRunId) {
          throw new AnnotationStoreError(
            "QUESTION_RUN_IDENTITY_MISMATCH",
            "Question id and run id must preserve their existing identity",
          );
        }
        if (byId === undefined || JSON.stringify(byId) !== JSON.stringify(question)) {
          if (
            byId !== undefined &&
            (
              byId.question !== question.question ||
              (byId.generation !== undefined && byId.generation !== question.generation) ||
              byId.createdAt !== question.createdAt ||
              TERMINAL_QUESTION_STATUSES.has(byId.status)
            )
          ) {
            throw new AnnotationStoreError(
              "QUESTION_RUN_IDENTITY_MISMATCH",
              "A reviewed commit cannot rebind or rewrite an existing question run",
            );
          }
          changedQuestions.push(question);
        }
      }
      for (const question of previous?.value.questions ?? []) {
        const byId = annotation.questions.find((candidate) => candidate.id === question.id);
        const byRunId = annotation.questions.find((candidate) => candidate.runId === question.runId);
        if (byId === undefined || byRunId === undefined || byId !== byRunId) {
          throw new AnnotationStoreError(
            "QUESTION_RUN_IDENTITY_MISMATCH",
            "Existing question runs cannot be deleted or rebound by reviewed-question commit",
          );
        }
      }
      if (changedQuestions.length !== 1) {
        throw new AnnotationStoreError(
          "REVIEWED_QUESTION_REQUIRED",
          "A reviewed commit must contain exactly one new completed question",
        );
      }
      const question = changedQuestions[0]!;
      if (
        question.status !== "completed" ||
        question.answer?.reviewStatus !== "evidence_reviewed"
      ) {
        throw new AnnotationStoreError(
          "REVIEWED_QUESTION_REQUIRED",
          "A reviewed commit requires a completed independently evidence-reviewed answer",
        );
      }

      for (const record of store.annotations) {
        if (record.value.id === annotation.id) continue;
        if (record.value.questions.some(
          (candidate) => candidate.id === question.id || candidate.runId === question.runId,
        )) {
          throw new AnnotationStoreError(
            "QUESTION_RUN_IDENTITY_MISMATCH",
            "Question and run ownership cannot move between annotations",
          );
        }
      }

      const draftIndex = store.drafts.findIndex(
        (record) => record.value.id === question.runId,
      );
      const draft = draftIndex < 0 ? undefined : store.drafts[draftIndex]!.value;
      if (
        draft === undefined ||
        draft.sessionId !== annotation.sessionId ||
        (draft.annotationId !== undefined && draft.annotationId !== annotation.id) ||
        draft.question !== question.question ||
        draft.generation !== question.generation ||
        draft.status !== "validating"
      ) {
        throw new AnnotationStoreError(
          "DRAFT_IDENTITY_MISMATCH",
          "The reviewed question must match its validating draft and ownership",
        );
      }

      const previousUpdates = new Map(
        previous?.questionUpdatedAt.map((entry) => [entry.runId, entry.updatedAt]),
      );
      const previousQuestions = new Map(
        previous?.value.questions.map((entry) => [entry.runId, JSON.stringify(entry)]),
      );
      const stored = {
        value: annotation,
        questionUpdatedAt: annotation.questions.map((entry) => ({
          runId: entry.runId,
          updatedAt:
            previousQuestions.get(entry.runId) === JSON.stringify(entry)
              ? previousUpdates.get(entry.runId) ?? timestamp
              : timestamp,
        })),
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (annotationIndex < 0) store.annotations.push(stored);
      else store.annotations[annotationIndex] = stored;
      store.drafts.splice(draftIndex, 1);
      return annotation;
    });
  }

  async updateQuestionRun(annotationId: string, value: unknown): Promise<AnnotationThread> {
    const parsedAnnotationId = OpaqueIdSchema.parse(annotationId);
    const question = QuestionRecordSchema.parse(value);
    return this.mutate((store, timestamp) => {
      const annotationIndex = store.annotations.findIndex(
        (record) => record.value.id === parsedAnnotationId,
      );
      if (annotationIndex < 0) {
        throw new AnnotationStoreError("ANNOTATION_NOT_FOUND", "Annotation was not found");
      }
      const stored = store.annotations[annotationIndex]!;
      const indexByQuestionId = stored.value.questions.findIndex(
        (candidate) => candidate.id === question.id,
      );
      const indexByRunId = stored.value.questions.findIndex(
        (candidate) => candidate.runId === question.runId,
      );
      if (
        (indexByQuestionId >= 0 || indexByRunId >= 0) &&
        (
          indexByQuestionId !== indexByRunId ||
          indexByQuestionId < 0 ||
          stored.value.questions[indexByQuestionId]!.id !== question.id ||
          stored.value.questions[indexByQuestionId]!.runId !== question.runId
        )
      ) {
        throw new AnnotationStoreError(
          "QUESTION_RUN_IDENTITY_MISMATCH",
          "Question id and run id must preserve their existing identity",
        );
      }
      const questionIndex = indexByQuestionId;
      const questions = [...stored.value.questions];
      if (questionIndex < 0) questions.push(question);
      else questions[questionIndex] = question;
      const updated = AnnotationThreadSchema.parse({ ...stored.value, questions });
      const owningSession = store.sessions.find(
        (record) => record.value.id === updated.sessionId,
      )?.value;
      if (owningSession === undefined) {
        throw new AnnotationStoreError("SESSION_NOT_FOUND", "Annotation session was not found");
      }
      assertDocumentBinding(owningSession, updated);
      const replacedRunId = questionIndex < 0
        ? undefined
        : stored.value.questions[questionIndex]!.runId;
      store.annotations[annotationIndex] = {
        value: updated,
        questionUpdatedAt: [
          ...stored.questionUpdatedAt.filter(
            (candidate) =>
              candidate.runId !== question.runId &&
              candidate.runId !== replacedRunId,
          ),
          { runId: question.runId, updatedAt: timestamp },
        ],
        createdAt: stored.createdAt,
        updatedAt: timestamp,
      };
      if (question.status === "completed") {
        store.drafts = store.drafts.filter((record) => record.value.id !== question.runId);
      }
      return updated;
    });
  }

  async markStaleBySnapshot(snapshotDigest: string): Promise<number> {
    const digest = Sha256DigestSchema.parse(snapshotDigest);
    return this.mutate((store, timestamp) => {
      let changed = 0;
      store.annotations = store.annotations.map((record) => {
        const usesSnapshot = record.value.questions.some(
          (question) => question.answer?.snapshotDigest === digest,
        );
        if (!usesSnapshot || record.value.stale) return record;
        changed += 1;
        return {
          value: AnnotationThreadSchema.parse({ ...record.value, stale: true }),
          questionUpdatedAt: record.questionUpdatedAt,
          createdAt: record.createdAt,
          updatedAt: timestamp,
        };
      });
      return changed;
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const id = OpaqueIdSchema.parse(sessionId);
    return this.mutate((store) => {
      const previousLength = store.sessions.length;
      store.sessions = store.sessions.filter((record) => record.value.id !== id);
      store.annotations = store.annotations.filter((record) => record.value.sessionId !== id);
      store.drafts = store.drafts.filter((record) => record.value.sessionId !== id);
      return previousLength !== store.sessions.length;
    });
  }

  async pruneBefore(recordsBefore: Date, draftsBefore?: Date): Promise<void> {
    const recordCutoff = validDate(recordsBefore, "recordsBefore");
    const draftCutoff = draftsBefore === undefined
      ? new Date(
          recordCutoff.getTime() -
          (this.draftRetentionDays - this.retentionDays) * MILLISECONDS_PER_DAY,
        )
      : validDate(draftsBefore, "draftsBefore");
    if (draftCutoff.getTime() > recordCutoff.getTime()) {
      throw new TypeError("draftsBefore cutoff must not be newer than recordsBefore cutoff");
    }
    await this.mutate((store) => {
      const recordTime = recordCutoff.getTime();
      const draftTime = draftCutoff.getTime();
      store.drafts = store.drafts.filter(
        (record) => Date.parse(record.updatedAt) >= draftTime,
      );
      const retainedDraftAnnotationIds = new Set(
        store.drafts.flatMap((record) =>
          record.value.annotationId === undefined ? [] : [record.value.annotationId]
        ),
      );
      store.annotations = store.annotations.flatMap((record) => {
        if (retainedDraftAnnotationIds.has(record.value.id)) return [record];
        const updatedAtByRunId = new Map(
          record.questionUpdatedAt.map((question) => [question.runId, question.updatedAt]),
        );
        const questions = record.value.questions.filter((question) => {
          const cutoff = TERMINAL_QUESTION_STATUSES.has(question.status)
            ? recordTime
            : draftTime;
          return Date.parse(updatedAtByRunId.get(question.runId) ?? question.createdAt) >= cutoff;
        });
        if (questions.length === 0) return [];
        if (questions.length === record.value.questions.length) return [record];
        return [{
          value: AnnotationThreadSchema.parse({ ...record.value, questions }),
          questionUpdatedAt: record.questionUpdatedAt.filter((question) =>
            questions.some((candidate) => candidate.runId === question.runId)
          ),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }];
      });
      const annotationById = new Map(
        store.annotations.map((record) => [record.value.id, record.value]),
      );
      store.drafts = store.drafts.filter((record) => {
        if (record.value.annotationId === undefined) return true;
        const annotation = annotationById.get(record.value.annotationId);
        return annotation?.sessionId === record.value.sessionId;
      });
      const referencedSessionIds = new Set([
        ...store.annotations.map((record) => record.value.sessionId),
        ...store.drafts.map((record) => record.value.sessionId),
      ]);
      store.sessions = store.sessions.filter(
        (record) =>
          Date.parse(record.updatedAt) >= recordTime ||
          referencedSessionIds.has(record.value.id),
      );
      const retainedSessionIds = new Set(
        store.sessions.map((record) => record.value.id),
      );
      store.annotations = store.annotations.filter(
        (record) => retainedSessionIds.has(record.value.sessionId),
      );
      const retainedAnnotationById = new Map(
        store.annotations.map((record) => [record.value.id, record.value]),
      );
      store.drafts = store.drafts.filter((record) => {
        if (!retainedSessionIds.has(record.value.sessionId)) return false;
        if (record.value.annotationId === undefined) return true;
        return retainedAnnotationById.get(record.value.annotationId)?.sessionId ===
          record.value.sessionId;
      });
    });
  }
}

export class JsonAnnotationRepository extends AnnotationRepositoryBase {
  readonly persistenceStatus = "persistent" as const;
  private readonly afterReadOpen?: AnnotationRepositoryOptions["afterReadOpen"];
  private readonly beforeRename?: AnnotationRepositoryOptions["beforeRename"];
  private readonly lockTimeoutMs: number;

  constructor(
    readonly filePath: string,
    options: AnnotationRepositoryOptions = {},
  ) {
    super(options);
    if (!isAbsolute(filePath) || filePath.includes("\0")) {
      throw new AnnotationStoreError("INVALID_STORE_PATH", "Annotation store path must be absolute");
    }
    this.afterReadOpen = options.afterReadOpen;
    this.beforeRename = options.beforeRename;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_STORE_LOCK_TIMEOUT_MS;
    if (!Number.isInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 1 || this.lockTimeoutMs > 60_000) {
      throw new TypeError("lockTimeoutMs must be an integer from 1 to 60000");
    }
  }

  protected async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    // A crash-left lock is deliberately not auto-reclaimed: portable owner-death
    // proof is unavailable, so the bounded timeout fails closed instead.
    const deadline = Date.now() + this.lockTimeoutMs;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    while (lock === undefined) {
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          Date.now() >= deadline
        ) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new AnnotationStoreError(
              "STORE_LOCK_TIMEOUT",
              "Timed out waiting for the annotation store lock",
            );
          }
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, STORE_LOCK_RETRY_MS));
      }
    }
    try {
      await lock.writeFile(String(process.pid), "utf8");
      return await operation();
    } finally {
      await lock.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  protected async readState(): Promise<AnnotationStoreV1> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return createEmptyAnnotationStore();
      throw error;
    }
    let bytes: Buffer;
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) {
        throw new AnnotationStoreError("INVALID_STORE_DATA", "Annotation store is not a regular file");
      }
      if (before.size > BigInt(MAX_ANNOTATION_STORE_BYTES)) {
        throw new AnnotationStoreError("STORE_TOO_LARGE", "Annotation store exceeds its byte limit");
      }
      await this.afterReadOpen?.();
      const capacity = Number(before.size) + 1;
      const bounded = Buffer.allocUnsafe(capacity);
      let offset = 0;
      while (offset < capacity) {
        const result = await handle.read(bounded, offset, capacity - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (
        after.size > BigInt(MAX_ANNOTATION_STORE_BYTES) ||
        offset > MAX_ANNOTATION_STORE_BYTES
      ) {
        throw new AnnotationStoreError("STORE_TOO_LARGE", "Annotation store exceeds its byte limit");
      }
      if (!sameHandleState(before, after) || BigInt(offset) !== after.size) {
        throw new AnnotationStoreError(
          "STORE_CHANGED_DURING_READ",
          "Annotation store changed while it was being read",
        );
      }
      bytes = bounded.subarray(0, offset);
    } finally {
      await handle.close().catch(() => undefined);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new AnnotationStoreError("INVALID_STORE_DATA", "Stored annotation JSON is invalid", { cause: error });
    }
    return parseStore(raw);
  }

  protected async writeState(value: AnnotationStoreV1): Promise<void> {
    const parsed = parseStore(value);
    const bytes = storeBytes(parsed);
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.beforeRename?.(temporaryPath, this.filePath);
      await rename(temporaryPath, this.filePath);
      renamed = true;
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export class MemoryAnnotationRepository extends AnnotationRepositoryBase {
  readonly persistenceStatus = "memory_only" as const;
  private state = createEmptyAnnotationStore();

  protected async readState(): Promise<AnnotationStoreV1> {
    return parseStore(this.state);
  }

  protected async writeState(value: AnnotationStoreV1): Promise<void> {
    this.state = parseStore(value);
  }
}

/**
 * Opens only the directory authorized by an exact, process-local ReaderConfig
 * capability. The canonical project root and data directory are revalidated
 * after directory creation and before the write probe; policy failures fail
 * closed. Ordinary user-data I/O failure yields an explicit in-memory
 * repository, never a project-local fallback. A present but malformed store
 * also fails closed instead of being hidden by memory-only mode.
 */
export async function openAnnotationRepository(
  authority: ReaderStorageAuthority,
  options: AnnotationRepositoryOptions = {},
): Promise<AnnotationRepository> {
  let metadata;
  try {
    metadata = resolveReaderStorageAuthority(authority);
  } catch {
    throw new AnnotationStoreError(
      "INVALID_STORE_PATH",
      "Annotation storage authority is invalid",
    );
  }
  const { dataDir, projectRoot, platform } = metadata;
  let probe: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(dataDir, { recursive: true });
  } catch {
    return new MemoryAnnotationRepository(options);
  }
  await options.afterDirectoryReady?.(dataDir);
  let canonicalDataDir: string;
  let canonicalProjectRoot: string;
  try {
    [canonicalDataDir, canonicalProjectRoot] = await Promise.all([
      realpath(dataDir),
      realpath(projectRoot),
    ]);
  } catch {
    throw new AnnotationStoreError(
      "INVALID_STORE_PATH",
      "Annotation storage authority could not be revalidated",
    );
  }
  if (
    !sameAuthorityPath(projectRoot, canonicalProjectRoot, platform) ||
    !sameAuthorityPath(dataDir, canonicalDataDir, platform) ||
    isAuthorityPathContained(canonicalProjectRoot, canonicalDataDir, platform)
  ) {
    throw new AnnotationStoreError(
      "INVALID_STORE_PATH",
      "Annotation storage authority changed or entered the project root",
    );
  }
  const canonicalProbePath = join(
    canonicalDataDir,
    `.aimd-write-probe.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    probe = await open(canonicalProbePath, "wx", 0o600);
    await probe.writeFile("probe", "utf8");
    await probe.sync();
    await probe.close();
    probe = undefined;
    await rm(canonicalProbePath, { force: true });
  } catch {
    await probe?.close().catch(() => undefined);
    await rm(canonicalProbePath, { force: true }).catch(() => undefined);
    return new MemoryAnnotationRepository(options);
  }

  const repository = new JsonAnnotationRepository(
    join(canonicalDataDir, "annotations.v1.json"),
    options,
  );
  await repository.load();
  const now = options.now?.() ?? new Date();
  validDate(now, "now()");
  const retentionDays = validateRetention(
    options.retentionDays,
    DEFAULT_RETENTION_DAYS,
    "retentionDays",
  );
  const draftRetentionDays = validateRetention(
    options.draftRetentionDays,
    DEFAULT_DRAFT_RETENTION_DAYS,
    "draftRetentionDays",
  );
  await repository.pruneBefore(
    new Date(now.getTime() - retentionDays * MILLISECONDS_PER_DAY),
    new Date(now.getTime() - draftRetentionDays * MILLISECONDS_PER_DAY),
  );
  return repository;
}
