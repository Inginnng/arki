import { Buffer } from "node:buffer";
import { types as nodeUtilTypes } from "node:util";

import {
  AnnotationThreadSchema,
  DispositionSchema,
  EvidenceAnswerSchema,
  OpaqueIdSchema,
  QuestionRunCursorSchema,
  QuestionRunEventSchema,
  QuestionRunPageSchema,
  ReaderSessionSchema,
  RelativePathSchema,
  Sha256DigestSchema,
  type Disposition,
  type EvidenceAnswer,
  type ModelAnswerCandidate,
  type QuestionRunEvent,
  type QuestionRunPage,
  type ReaderSession,
  type SourceAnchor,
} from "@aimd/contracts";
import {
  MarkdownPatchError,
  SynthesisValidationError,
  applyEditIntents,
  createSourceAnchor,
  defaultExplainedPath,
  issueEvidencePacket,
  relocateSourceAnchor,
  sha256Text,
  validateEvidence,
  validateEvidenceSupportAudit,
  validateSynthesisOutput,
  type ApprovalAuthority,
  type CreatedWorkspaceSnapshot,
  type EvidencePacket,
  type EvidenceSource,
  type EvidenceSupportAuditResult,
  type PatchResult,
} from "@aimd/reader-core";
import type {
  AcceptedSynthesisAnnotation,
  AnchoredQuestion as BridgeAnchoredQuestion,
  BridgeOperationResult,
  BridgeQuestionEvent,
  TaskBindingResult,
  UnverifiedBinding,
} from "@aimd/app-server-bridge";
import { z } from "zod";

import type { SafeOutputSourceDescriptor, SafeWriteCapability, SafeWriteResult } from "./safe-writer.js";
import type { AnnotationRepository } from "./store.js";
import type {
  ReadFileRange,
  WorkspaceDocument,
  WorkspaceEvidenceRange,
  WorkspaceExcerpt,
  WorkspaceSearchResult,
  WorkspaceSnapshotRequest,
} from "./workspace.js";

const MAX_ROOTS = 32;
const MAX_DOCUMENTS = 2_000;
const MAX_PATCH_PREVIEWS = 128;
const MAX_RUNS = 256;
const MAX_EVENTS = 64;
const MAX_QUESTION_BYTES = 8_192;
const MAX_INITIAL_SEARCH_QUERIES = 12;

const ARCHITECTURE_QUESTION = /(?:architecture|architectural|entry\s*point|bootstrap|dependency|dependencies|configuration|config|routing|pipeline|workflow|架构|入口|依赖|配置|路由|调用链|流程)/iu;
const SEARCH_STOP_WORDS = new Set([
  "about", "architecture", "architectural", "does", "entry", "explain", "from", "here",
  "how", "into", "point", "requests", "route", "routing", "system", "the", "this", "through",
  "what", "where", "which", "with", "work", "works", "its",
]);
const ARCHITECTURE_HEURISTIC_QUERIES = [
  '"dependencies"',
  '"scripts"',
  "[dependencies]",
  "[project]",
  "module",
  "main",
  "config",
  "createServer(",
] as const;

const RootSummarySchema = z.object({
  rootId: OpaqueIdSchema,
  workspaceLabel: z.string().min(1).max(512).refine((value) => !/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/u.test(value)),
}).strict();
export type RootSummary = z.infer<typeof RootSummarySchema>;

const DocumentSummarySchema = z.object({ path: RelativePathSchema, title: z.string().min(1).max(1_024), hash: Sha256DigestSchema }).strict();
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

const ReaderDocumentSchema = z.object({
  path: RelativePathSchema,
  hash: Sha256DigestSchema,
  markdown: z.string().max(2 * 1_024 * 1_024),
  headings: z.array(z.object({ depth: z.number().int().min(1).max(6), text: z.string(), line: z.number().int().positive() }).strict()).max(10_000),
  anchorStatus: z.discriminatedUnion("status", [
    z.object({ status: z.literal("available") }).strict(),
    z.object({ status: z.literal("view_only"), code: z.literal("SOURCE_ANCHOR_COMPLEXITY_BUDGET") }).strict(),
  ]),
}).strict();
export type ReaderDocument = z.infer<typeof ReaderDocumentSchema>;

const ReaderSourceExcerptSchema = z.object({
  path: RelativePathSchema,
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(),
  lines: z.array(z.object({ line: z.number().int().positive(), text: z.string() }).strict()).max(200),
  excerpt: z.string().max(256 * 1_024),
  fileHash: Sha256DigestSchema,
  truncated: z.boolean(),
}).strict();
export type ReaderSourceExcerpt = z.infer<typeof ReaderSourceExcerptSchema>;

export const AnchoredQuestionInputSchema = z.object({
  question: z.string().min(1).max(MAX_QUESTION_BYTES).refine((value) => value.trim().length > 0),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.endOffset <= value.startOffset) context.addIssue({ code: "custom", path: ["endOffset"], message: "Selection end must follow start" });
});
export type AnchoredQuestionInput = z.infer<typeof AnchoredQuestionInputSchema>;

const StartQuestionResultSchema = z.object({ runId: OpaqueIdSchema }).strict();
const PatchPreviewSchema = z.object({
  id: OpaqueIdSchema,
  sessionId: OpaqueIdSchema,
  status: z.enum(["ready", "conflict"]),
  sourcePath: RelativePathSchema,
  targetPath: RelativePathSchema,
  sourceHash: Sha256DigestSchema,
  resultHash: Sha256DigestSchema,
  diffHash: Sha256DigestSchema,
  markdown: z.string().max(2 * 1_024 * 1_024),
  unifiedDiff: z.string().max(2 * 1_024 * 1_024),
  annotationIds: z.array(OpaqueIdSchema).min(1).max(256),
  conflicts: z.array(z.object({ annotationId: OpaqueIdSchema, reason: z.string().min(1).max(8_192) }).strict()).max(256),
}).strict().superRefine((preview, context) => {
  if (preview.status === "ready" && preview.conflicts.length > 0) context.addIssue({ code: "custom", path: ["conflicts"], message: "Ready previews cannot contain conflicts" });
  if (preview.status === "conflict" && preview.conflicts.length === 0) context.addIssue({ code: "custom", path: ["conflicts"], message: "Conflict previews require typed conflicts" });
});
export type PatchPreview = z.infer<typeof PatchPreviewSchema>;

const ApprovalResultSchema = z.object({ approvalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict();
const WriteResultSchema = z.object({ path: RelativePathSchema }).strict();

export type ReaderServiceErrorCode =
  | "ROOT_NOT_FOUND" | "DOCUMENT_NOT_FOUND" | "SESSION_NOT_FOUND" | "RUN_NOT_FOUND"
  | "RUN_CAPACITY_EXCEEDED" | "CURSOR_GAP" | "CURSOR_INVALID" | "EVENT_REPLAY_MISMATCH"
  | "RUN_TERMINAL" | "ANCHOR_STALE" | "QUESTION_FAILED" | "ANNOTATION_NOT_FOUND"
  | "ANNOTATION_NOT_ACCEPTED" | "PATCH_NOT_FOUND" | "PATCH_NOT_APPROVABLE"
  | "APPROVAL_INVALID" | "SOURCE_CHANGED" | "OUTPUT_ALREADY_EXISTS" | "SAFE_WRITE_UNAVAILABLE"
  | "SERVER_RESTARTED" | "SERVICE_CLOSED" | "ROOT_AUTHORIZATION_REVOKED";

export class ReaderServiceError extends Error {
  constructor(readonly code: ReaderServiceErrorCode) {
    super(code);
    this.name = "ReaderServiceError";
  }
}

export interface ReaderServiceWorkspace {
  readDocument(path: string): Promise<WorkspaceDocument>;
  readFile(path: string, range?: ReadFileRange): Promise<WorkspaceExcerpt>;
  readLines(path: string, startLine: number, endLine: number): Promise<WorkspaceExcerpt>;
  readEvidenceRange(path: string, startLine: number, endLine: number): Promise<WorkspaceEvidenceRange>;
  searchProject(query: string): Promise<WorkspaceSearchResult>;
  snapshot(request?: WorkspaceSnapshotRequest): Promise<CreatedWorkspaceSnapshot>;
  prepareSafeOutputSource(path: string): Promise<SafeOutputSourceDescriptor>;
  readDocumentSource?: (path: string) => Promise<{ path: string; source: string; hash: string }>;
  guard?: { readFileBytes(path: string): Promise<{ bytes: Uint8Array; canonicalRelativePath: string }> };
}

export type ReaderRootBinding = Readonly<{
  rootId: string;
  workspaceLabel: string;
  canonicalRoot: string;
  workspace: ReaderServiceWorkspace;
  listDocuments: () => Promise<readonly DocumentSummary[]>;
  requiresMcpRoot?: boolean;
  authorizeMcpRoots?: (roots: readonly { readonly uri: string }[]) => boolean | Promise<boolean>;
}>;

export interface ReaderServiceBridge {
  verifyBinding(binding: UnverifiedBinding, workspaceRoot: string): Promise<TaskBindingResult>;
  createSession(binding: TaskBindingResult, workspaceRoot: string, documentPath: string): Promise<ReaderSession>;
  ask(sessionId: string, question: BridgeAnchoredQuestion, signal?: AbortSignal): AsyncIterable<BridgeQuestionEvent>;
  auditEvidence(input: { sessionId: string; candidate: ModelAnswerCandidate; answer: EvidenceAnswer; workspaceSnapshot: CreatedWorkspaceSnapshot }, signal?: AbortSignal): Promise<BridgeOperationResult<EvidenceSupportAuditResult>>;
  issueAcceptedSynthesisAnnotation(sessionId: string, input: { annotationId: string; disposition: Exclude<Disposition, "reading_only" | "ignore">; answer: EvidenceAnswer; auditResult: EvidenceSupportAuditResult }): AcceptedSynthesisAnnotation;
  synthesize(sessionId: string, input: { documentPath: string; documentHash: string; snapshotDigest: string; workspaceSnapshot: CreatedWorkspaceSnapshot; annotations: readonly AcceptedSynthesisAnnotation[] }, signal?: AbortSignal): Promise<BridgeOperationResult<unknown>>;
}

export interface ReaderServiceWriter {
  capability(): Promise<SafeWriteCapability>;
  createExplainedSibling(source: SafeOutputSourceDescriptor, targetBasename: string, content: Uint8Array): Promise<SafeWriteResult>;
}

export type ReaderServiceDependencies = Readonly<{
  roots: readonly ReaderRootBinding[];
  repository: AnnotationRepository;
  bridge: ReaderServiceBridge;
  approvalAuthority: ApprovalAuthority;
  writer: ReaderServiceWriter;
  captureTaskBinding: (requestMeta: unknown) => UnverifiedBinding;
  issueId?: (scope: string) => string;
  now?: () => Date;
  eventWindow?: number;
  runCapacity?: number;
}>;

export type ReaderAccessReference =
  | Readonly<{ kind: "session"; id: string }>
  | Readonly<{ kind: "run"; id: string }>
  | Readonly<{ kind: "annotation"; id: string }>
  | Readonly<{ kind: "preview"; id: string }>;

type RunRecord = { runId: string; generation: string; events: QuestionRunEvent[]; replay: Map<number, string>; terminal: boolean };

export class InMemoryQuestionRunStore {
  readonly #runs = new Map<string, RunRecord>();
  readonly #maxEvents: number;
  readonly #maxRuns: number;

  constructor(options: { maxEvents?: number; maxRuns?: number } = {}) {
    this.#maxEvents = Math.max(1, Math.min(MAX_EVENTS, options.maxEvents ?? MAX_EVENTS));
    this.#maxRuns = Math.max(1, Math.min(MAX_RUNS, options.maxRuns ?? MAX_RUNS));
  }

  create(runId: string, generation: string): string | undefined {
    const id = OpaqueIdSchema.parse(runId);
    const parsedGeneration = OpaqueIdSchema.parse(generation);
    if (this.#runs.has(id)) throw new ReaderServiceError("RUN_CAPACITY_EXCEEDED");
    let evictedRunId: string | undefined;
    while (this.#runs.size >= this.#maxRuns) {
      const terminal = [...this.#runs].find(([, record]) => record.terminal)?.[0];
      if (terminal === undefined) throw new ReaderServiceError("RUN_CAPACITY_EXCEEDED");
      this.#runs.delete(terminal);
      evictedRunId = terminal;
    }
    this.#runs.set(id, { runId: id, generation: parsedGeneration, events: [], replay: new Map(), terminal: false });
    return evictedRunId;
  }

  generation(runId: string): string { return this.#require(runId).generation; }
  nextSequence(runId: string): number { return (this.#require(runId).events.at(-1)?.sequence ?? 0) + 1; }
  isTerminal(runId: string): boolean { return this.#require(OpaqueIdSchema.parse(runId)).terminal; }

  append(rawEvent: unknown): void {
    const event = QuestionRunEventSchema.parse(rawEvent);
    const record = this.#require(event.runId);
    if (event.generation !== record.generation) throw new ReaderServiceError("CURSOR_INVALID");
    const stable = JSON.stringify(event);
    const replayed = record.replay.get(event.sequence);
    if (replayed !== undefined) {
      if (replayed !== stable) throw new ReaderServiceError("EVENT_REPLAY_MISMATCH");
      return;
    }
    if (record.terminal) throw new ReaderServiceError("RUN_TERMINAL");
    const expected = (record.events.at(-1)?.sequence ?? 0) + 1;
    if (event.sequence !== expected) throw new ReaderServiceError("CURSOR_GAP");
    record.events.push(event);
    record.replay.set(event.sequence, stable);
    if (["completed", "stale", "failed", "cancelled"].includes(event.type)) record.terminal = true;
    while (record.events.length > this.#maxEvents) {
      const removed = record.events.shift();
      if (removed) record.replay.delete(removed.sequence);
    }
  }

  changeGeneration(runId: string, generation: string): void {
    const record = this.#require(runId);
    const parsed = OpaqueIdSchema.parse(generation);
    if (parsed === record.generation) throw new ReaderServiceError("CURSOR_INVALID");
    record.generation = parsed;
    record.events = [];
    record.replay.clear();
    record.terminal = false;
  }

  discard(runId: string): void {
    this.#runs.delete(OpaqueIdSchema.parse(runId));
  }

  poll(runId: string, rawCursor?: unknown): QuestionRunPage {
    const record = this.#require(OpaqueIdSchema.parse(runId));
    const cursor = rawCursor === undefined ? null : QuestionRunCursorSchema.parse(rawCursor);
    if (cursor && cursor.runId !== record.runId) throw new ReaderServiceError("CURSOR_INVALID");
    const last = record.events.at(-1);
    const currentCursor = last ? { runId: record.runId, generation: record.generation, sequence: last.sequence } : null;
    if (cursor && cursor.generation !== record.generation) {
      return QuestionRunPageSchema.parse({ outcome: "GENERATION_CHANGED", runId: record.runId, generation: record.generation, cursor, currentCursor });
    }
    const oldest = record.events[0];
    if (cursor && oldest && cursor.sequence < oldest.sequence - 1) {
      return QuestionRunPageSchema.parse({ outcome: "CURSOR_EXPIRED", runId: record.runId, generation: record.generation, cursor, oldestAvailableCursor: { runId: record.runId, generation: record.generation, sequence: oldest.sequence }, currentCursor: currentCursor! });
    }
    const events = record.events.filter((event) => event.sequence > (cursor?.sequence ?? 0));
    const first = events[0];
    if (cursor && first && first.sequence > cursor.sequence + 1) {
      return QuestionRunPageSchema.parse({ outcome: "CURSOR_GAP", runId: record.runId, generation: record.generation, cursor, expectedSequence: cursor.sequence + 1, actualSequence: first.sequence });
    }
    if (cursor && currentCursor && cursor.sequence > currentCursor.sequence) throw new ReaderServiceError("CURSOR_INVALID");
    return QuestionRunPageSchema.parse({ outcome: "events", runId: record.runId, generation: record.generation, cursor, nextCursor: events.at(-1) ? { runId: record.runId, generation: record.generation, sequence: events.at(-1)!.sequence } : cursor, events });
  }

  #require(runId: string): RunRecord {
    const record = this.#runs.get(runId);
    if (!record) throw new ReaderServiceError("RUN_NOT_FOUND");
    return record;
  }
}

type SessionRecord = { session: ReaderSession; root: ReaderRootBinding };
type EvidenceSpec = { kind: EvidenceSource["kind"]; path: string; startLine: number; endLine: number };
type ActiveRun = {
  session: SessionRecord;
  input: AnchoredQuestionInput;
  anchor: SourceAnchor;
  abort: AbortController;
  background: Promise<void>;
  finish: () => void;
  sources: EvidenceSpec[];
  packets: EvidencePacket[];
  snapshot: CreatedWorkspaceSnapshot;
  contextMode: ReaderSession["contextMode"];
  expansionRequestsUsed: number;
  generation: string;
};
type AcceptedAuthority = {
  answer: EvidenceAnswer;
  audit: EvidenceSupportAuditResult;
  relevantPaths: readonly string[];
};
type PatchPreviewRecord = {
  preview: PatchPreview;
  acceptedAuthorities: readonly AcceptedAuthority[];
};

function evidenceKind(path: string): EvidenceSource["kind"] {
  if (/\.(?:md|markdown)$/iu.test(path)) return "project_document";
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/iu.test(path)) return "test_excerpt";
  return "code_excerpt";
}

function lineAtOffset(source: string, offset: number): number {
  return source.slice(0, offset).split(/\r\n|\n|\r/u).length;
}

function uniqueSpecs(specs: readonly EvidenceSpec[]): EvidenceSpec[] {
  const seen = new Set<string>();
  return specs.filter((spec) => {
    const key = `${spec.kind}\0${spec.path}\0${spec.startLine}\0${spec.endLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function initialSearchQueries(question: string, selectedText: string): string[] {
  const normalize = (value: string, maximum: number) => value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, maximum)
    .trim();
  const architectureQuestion = ARCHITECTURE_QUESTION.test(`${question} ${selectedText}`);
  const identifiers = [...new Set(
    (question + " " + selectedText)
      .match(/[A-Za-z_$][A-Za-z0-9_$.-]{2,127}/gu) ?? [],
  )]
    .filter((identifier) => !SEARCH_STOP_WORDS.has(identifier.toLocaleLowerCase("en-US")))
    .sort((left, right) => {
      const codeLike = (value: string) => /[_$.-]|[a-z][A-Z]|^[A-Z][A-Za-z0-9_$.-]*$/u.test(value) ? 0 : 1;
      return codeLike(left) - codeLike(right);
    })
    .slice(0, architectureQuestion ? 1 : 3);
  const candidates = [
    normalize(selectedText, 512),
    normalize(question, 512),
    ...identifiers.flatMap((identifier) => [normalize(identifier, 128), normalize(`${identifier}(`, 129)]),
    ...(architectureQuestion ? ARCHITECTURE_HEURISTIC_QUERIES : []),
  ];
  return [...new Set(candidates.filter((query) => query.length > 0))]
    .slice(0, MAX_INITIAL_SEARCH_QUERIES);
}

export class ReaderService {
  readonly #roots = new Map<string, ReaderRootBinding>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #runSessions = new Map<string, string>();
  readonly #accepted = new Map<string, AcceptedAuthority>();
  readonly #previews = new Map<string, PatchPreviewRecord>();
  readonly #inFlightMutations = new Set<Promise<void>>();
  readonly #runs: InMemoryQuestionRunStore;
  readonly #runCapacity: number;
  readonly #issueId: (scope: string) => string;
  readonly #now: () => Date;
  #closed = false;

  constructor(readonly dependencies: ReaderServiceDependencies) {
    for (const root of dependencies.roots.slice(0, MAX_ROOTS)) {
      const rootId = OpaqueIdSchema.parse(root.rootId);
      RootSummarySchema.parse({ rootId, workspaceLabel: root.workspaceLabel });
      if (this.#roots.has(rootId)) throw new ReaderServiceError("ROOT_NOT_FOUND");
      this.#roots.set(rootId, root);
    }
    this.#issueId = dependencies.issueId ?? ((scope) => `${scope}-${globalThis.crypto.randomUUID()}`);
    this.#now = dependencies.now ?? (() => new Date());
    this.#runCapacity = Math.max(1, Math.min(MAX_RUNS, dependencies.runCapacity ?? MAX_RUNS));
    this.#runs = new InMemoryQuestionRunStore({
      ...(dependencies.eventWindow === undefined ? {} : { maxEvents: dependencies.eventWindow }),
      maxRuns: this.#runCapacity,
    });
  }

  async listRoots(rawMcpRoots?: readonly { readonly uri: string }[]): Promise<RootSummary[]> {
    const observed = rawMcpRoots === undefined
      ? undefined
      : z.array(z.object({ uri: z.string().min(1).max(4_096) }).strict()).max(MAX_ROOTS).parse(rawMcpRoots);
    const result: RootSummary[] = [];
    for (const root of this.#roots.values()) {
      if (observed === undefined && root.requiresMcpRoot) continue;
      if (observed !== undefined && (!root.authorizeMcpRoots || !await root.authorizeMcpRoots(observed))) continue;
      result.push(RootSummarySchema.parse({ rootId: root.rootId, workspaceLabel: root.workspaceLabel }));
    }
    return result;
  }

  async authorizeAccess(
    reference: ReaderAccessReference,
    rawMcpRoots?: readonly { readonly uri: string }[],
  ): Promise<void> {
    const parsed = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("session"), id: OpaqueIdSchema }).strict(),
      z.object({ kind: z.literal("run"), id: OpaqueIdSchema }).strict(),
      z.object({ kind: z.literal("annotation"), id: OpaqueIdSchema }).strict(),
      z.object({ kind: z.literal("preview"), id: OpaqueIdSchema }).strict(),
    ]).parse(reference);
    let sessionId: string;
    if (parsed.kind === "session") {
      sessionId = parsed.id;
    } else if (parsed.kind === "run") {
      sessionId = this.#runSessions.get(parsed.id) ?? "";
      if (sessionId.length === 0) throw new ReaderServiceError("RUN_NOT_FOUND");
    } else if (parsed.kind === "annotation") {
      const annotation = await this.dependencies.repository.getAnnotation(parsed.id);
      if (!annotation) throw new ReaderServiceError("ANNOTATION_NOT_FOUND");
      sessionId = annotation.sessionId;
    } else {
      const record = this.#previews.get(parsed.id);
      if (!record) throw new ReaderServiceError("PATCH_NOT_FOUND");
      sessionId = record.preview.sessionId;
    }
    const root = this.#session(sessionId).root;
    const observed = rawMcpRoots === undefined
      ? undefined
      : z.array(z.object({ uri: z.string().min(1).max(4_096) }).strict()).max(MAX_ROOTS).parse(rawMcpRoots);
    if (!await this.#isRootAuthorized(root, observed)) {
      throw new ReaderServiceError("ROOT_AUTHORIZATION_REVOKED");
    }
  }

  async listDocuments(rootId: string): Promise<DocumentSummary[]> {
    const root = this.#root(rootId);
    return z.array(DocumentSummarySchema).max(MAX_DOCUMENTS).parse(await root.listDocuments());
  }

  async openDocument(rootId: string, path: string): Promise<ReaderDocument> {
    const root = this.#root(rootId);
    const relativePath = RelativePathSchema.parse(path);
    const [document, source] = await Promise.all([
      root.workspace.readDocument(relativePath),
      this.#readExactSource(root.workspace, relativePath),
    ]);
    if (document.path !== source.path || document.hash !== source.hash) throw new ReaderServiceError("SOURCE_CHANGED");
    return ReaderDocumentSchema.parse({ path: document.path, hash: document.hash, markdown: source.source, headings: document.headings, anchorStatus: document.anchorStatus });
  }

  async readSource(rootId: string, path: string, startLine: number, endLine: number): Promise<ReaderSourceExcerpt> {
    const excerpt = await this.#root(rootId).workspace.readLines(RelativePathSchema.parse(path), startLine, endLine);
    return ReaderSourceExcerptSchema.parse(excerpt);
  }

  async createSession(rootId: string, path: string, requestMeta: unknown): Promise<ReaderSession> {
    this.#assertOpen();
    // Raw metadata is synchronously reduced before the first await and is never retained.
    const unverifiedBinding = this.captureSessionBinding(requestMeta);
    return await this.createSessionFromBinding(rootId, path, unverifiedBinding);
  }

  captureSessionBinding(requestMeta: unknown): UnverifiedBinding {
    this.#assertOpen();
    return this.dependencies.captureTaskBinding(requestMeta);
  }

  async createSessionFromBinding(
    rootId: string,
    path: string,
    unverifiedBinding: UnverifiedBinding,
  ): Promise<ReaderSession> {
    const finishMutation = this.#beginMutation();
    try {
      const root = this.#root(rootId);
      const document = await this.openDocument(root.rootId, path);
      const binding = await this.dependencies.bridge.verifyBinding(unverifiedBinding, root.canonicalRoot);
      const session = ReaderSessionSchema.parse(await this.dependencies.bridge.createSession(binding, root.canonicalRoot, document.path));
      if (session.rootId !== root.rootId || session.documentPath !== document.path) throw new ReaderServiceError("SESSION_NOT_FOUND");
      await this.dependencies.repository.upsertSession(session);
      this.#sessions.set(session.id, { session, root });
      return ReaderSessionSchema.parse(session);
    } finally {
      finishMutation();
    }
  }

  async startQuestion(sessionId: string, rawQuestion: unknown): Promise<{ runId: string }> {
    this.#assertOpen();
    const session = this.#session(sessionId);
    const input = AnchoredQuestionInputSchema.parse(rawQuestion);
    const source = await this.#readExactSource(session.root.workspace, session.session.documentPath);
    const anchor = createSourceAnchor(source.path, source.source, input.startOffset, input.endOffset);
    const runId = OpaqueIdSchema.parse(this.#issueId("run"));
    const generation = OpaqueIdSchema.parse(this.#issueId("generation"));
    if (this.#activeRuns.size >= this.#runCapacity) throw new ReaderServiceError("RUN_CAPACITY_EXCEEDED");
    const initial = await this.#initialEvidence(session, input, anchor, runId, generation, source.source);
    this.#assertOpen();
    const evictedRunId = this.#runs.create(runId, generation);
    if (evictedRunId !== undefined) this.#runSessions.delete(evictedRunId);
    this.#runSessions.set(runId, session.session.id);
    let finishRun!: () => void;
    const background = new Promise<void>((resolve) => { finishRun = resolve; });
    const active: ActiveRun = {
      session, input, anchor, abort: new AbortController(), background, finish: finishRun,
      sources: initial.sources,
      packets: initial.packets, snapshot: initial.snapshot, contextMode: initial.contextMode,
      expansionRequestsUsed: 0, generation,
    };
    this.#activeRuns.set(runId, active);
    try {
      await this.dependencies.repository.saveDraft({ id: runId, sessionId: session.session.id, question: input.question, status: "queued", generation });
    } catch (error) {
      this.#activeRuns.delete(runId);
      this.#runs.discard(runId);
      this.#runSessions.delete(runId);
      active.finish();
      throw error;
    }
    if (this.#closed || active.abort.signal.aborted) {
      await this.#saveDraft(active, runId, "cancelled");
      this.#event(runId, "cancelled", { status: "cancelled", reason: "Reader service closed." });
      this.#activeRuns.delete(runId);
      active.finish();
      throw new ReaderServiceError("SERVICE_CLOSED");
    }
    this.#event(runId, "status", { status: "queued" });
    void this.#runQuestion(active, runId).catch(async () => {
      if (!this.#isTerminal(runId)) {
        await this.#saveDraft(active, runId, "failed").catch(() => undefined);
        if (!this.#isTerminal(runId)) {
          this.#event(runId, "failed", { status: "failed", code: "QUESTION_FAILED", message: "The question run failed safely.", retryable: true });
        }
      }
    }).catch(() => undefined).finally(() => {
      this.#activeRuns.delete(runId);
      active.finish();
    });
    return StartQuestionResultSchema.parse({ runId });
  }

  async pollQuestion(runId: string, cursor?: unknown): Promise<QuestionRunPage> {
    return QuestionRunPageSchema.parse(this.#runs.poll(runId, cursor));
  }

  async cancelQuestion(runId: string): Promise<void> {
    const id = OpaqueIdSchema.parse(runId);
    const run = this.#activeRuns.get(id);
    if (!run) {
      if (this.#runs.isTerminal(id)) return;
      throw new ReaderServiceError("RUN_NOT_FOUND");
    }
    if (this.#isTerminal(runId)) return;
    run.abort.abort();
    await run.background;
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const run of this.#activeRuns.values()) run.abort.abort();
    }
    await Promise.all([...this.#activeRuns.values()].map(async (run) => { await run.background; }));
    while (this.#inFlightMutations.size > 0) {
      await Promise.allSettled([...this.#inFlightMutations]);
    }
  }

  async recoverInterruptedRuns(): Promise<number> {
    const state = await this.dependencies.repository.load();
    for (const record of state.sessions) {
      const root = this.#roots.get(record.value.rootId);
      if (root && !this.#sessions.has(record.value.id)) {
        this.#sessions.set(record.value.id, { session: record.value, root });
      }
    }
    let recovered = 0;
    for (const record of state.drafts) {
      const draft = record.value;
      if (
        draft.generation === undefined ||
        draft.status === "stale" ||
        draft.status === "failed" ||
        draft.status === "cancelled"
      ) continue;
      try {
        const generation = OpaqueIdSchema.parse(this.#issueId("generation"));
        const evictedRunId = this.#runs.create(draft.id, generation);
        if (evictedRunId !== undefined) this.#runSessions.delete(evictedRunId);
        this.#runSessions.set(draft.id, draft.sessionId);
        await this.dependencies.repository.saveDraft({ ...draft, generation, status: "failed" });
      } catch (error) {
        if (error instanceof ReaderServiceError && error.code === "RUN_CAPACITY_EXCEEDED") continue;
        throw error;
      }
      this.#event(draft.id, "failed", {
        status: "failed",
        code: "SERVER_RESTARTED",
        message: "The previous server stopped before this question completed.",
        retryable: true,
      });
      recovered += 1;
    }
    return z.number().int().nonnegative().parse(recovered);
  }

  async setDisposition(annotationId: string, rawDisposition: unknown): Promise<void> {
    const finishMutation = this.#beginMutation();
    try {
      const id = OpaqueIdSchema.parse(annotationId);
      const disposition = DispositionSchema.parse(rawDisposition);
      const annotation = await this.dependencies.repository.getAnnotation(id);
      if (!annotation) throw new ReaderServiceError("ANNOTATION_NOT_FOUND");
      await this.dependencies.repository.upsertAnnotation(AnnotationThreadSchema.parse({ ...annotation, disposition }));
    } finally {
      finishMutation();
    }
  }

  async preparePatch(sessionId: string, rawAnnotationIds: unknown): Promise<PatchPreview> {
    const finishMutation = this.#beginMutation();
    try {
    const session = this.#session(sessionId);
    const annotationIds = z.array(OpaqueIdSchema).min(1).max(256).superRefine((ids, context) => {
      if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Annotation ids must be unique" });
    }).parse(rawAnnotationIds);
    const state = await this.dependencies.repository.load();
    const byId = new Map(state.annotations.map((record) => [record.value.id, record.value]));
    const annotations = annotationIds.map((id) => {
      const annotation = byId.get(id);
      if (!annotation || annotation.sessionId !== session.session.id) throw new ReaderServiceError("ANNOTATION_NOT_FOUND");
      if (annotation.stale || annotation.disposition === "reading_only" || annotation.disposition === "ignore") throw new ReaderServiceError("ANNOTATION_NOT_ACCEPTED");
      if (!this.#accepted.has(id)) throw new ReaderServiceError("ANNOTATION_NOT_ACCEPTED");
      return annotation;
    });
    const source = await this.#readExactSource(session.root.workspace, session.session.documentPath);
    for (const annotation of annotations) {
      const relocated = relocateSourceAnchor(annotation.anchor, source.source);
      if (annotation.anchor.documentHash !== source.hash || relocated.status !== "exact") throw new ReaderServiceError("ANCHOR_STALE");
      await this.#assertAcceptedFresh(session.root.workspace, this.#accepted.get(annotation.id)!);
    }
    const acceptedAuthorities = annotations.map((annotation) => this.#accepted.get(annotation.id)!);
    const evidenceAnswers = acceptedAuthorities.map(({ answer }) => answer);
    const evidencePaths = evidenceAnswers.flatMap((answer) => answer.evidence.flatMap((item) => "path" in item ? [item.path] : []));
    const relevantPaths = [...new Set([source.path, ...evidencePaths])];
    const snapshot = await session.root.workspace.snapshot({ relevantPaths });
    const trusted = annotations.map((annotation) => {
      const authority = this.#accepted.get(annotation.id)!;
      return this.dependencies.bridge.issueAcceptedSynthesisAnnotation(session.session.id, {
        annotationId: annotation.id,
        disposition: annotation.disposition as Exclude<Disposition, "reading_only" | "ignore">,
        answer: authority.answer,
        auditResult: authority.audit,
      });
    });
    const synthesized = await this.dependencies.bridge.synthesize(session.session.id, {
      documentPath: source.path,
      documentHash: source.hash,
      snapshotDigest: snapshot.snapshotDigest,
      workspaceSnapshot: snapshot,
      annotations: trusted,
    });
    if (synthesized.status !== "completed") throw new ReaderServiceError("QUESTION_FAILED");
    const sourceAfterSynthesis = await this.#readExactSource(session.root.workspace, source.path);
    if (sourceAfterSynthesis.hash !== source.hash || sourceAfterSynthesis.source !== source.source) {
      throw new ReaderServiceError("SOURCE_CHANGED");
    }
    for (const authority of acceptedAuthorities) {
      await this.#assertAcceptedFresh(session.root.workspace, authority);
    }
    const snapshotAfterSynthesis = await session.root.workspace.snapshot({ relevantPaths });
    if (snapshotAfterSynthesis.snapshotDigest !== snapshot.snapshotDigest) {
      throw new ReaderServiceError("ANNOTATION_NOT_ACCEPTED");
    }
    let patch: PatchResult;
    let status: PatchPreview["status"] = "ready";
    let conflicts: Array<{ annotationId: string; reason: string }> = [];
    try {
      const batch = validateSynthesisOutput(synthesized.output, {
        acceptedAnnotations: trusted.map((item) => ({
          annotationId: item.annotationId,
          selected: true,
          disposition: item.disposition,
          anchor: item.anchor,
          evidenceIds: item.evidence.map(({ id }) => id),
        })),
        currentDocumentPath: source.path,
        currentDocumentHash: source.hash,
      });
      conflicts = batch.conflicts;
      if (conflicts.length > 0) {
        status = "conflict";
        patch = { markdown: source.source, unifiedDiff: "", sourceHash: source.hash, resultHash: source.hash, appliedAnnotationIds: [], conflicts };
      } else {
        patch = applyEditIntents(source.source, batch.intents);
      }
    } catch (error) {
      if (!(error instanceof MarkdownPatchError) && !(error instanceof SynthesisValidationError)) throw error;
      status = "conflict";
      conflicts = error instanceof MarkdownPatchError && error.conflicts.length > 0
        ? error.conflicts
        : annotationIds.map((annotationId) => ({ annotationId, reason: error.code }));
      patch = { markdown: source.source, unifiedDiff: "", sourceHash: source.hash, resultHash: source.hash, appliedAnnotationIds: [], conflicts };
    }
    const preview = PatchPreviewSchema.parse({
      id: this.#issueId("preview"), sessionId: session.session.id, status,
      sourcePath: source.path, targetPath: defaultExplainedPath(source.path),
      sourceHash: patch.sourceHash, resultHash: patch.resultHash, diffHash: sha256Text(patch.unifiedDiff),
      markdown: patch.markdown, unifiedDiff: patch.unifiedDiff, annotationIds, conflicts,
    });
    while (this.#previews.size >= MAX_PATCH_PREVIEWS) this.#previews.delete(this.#previews.keys().next().value as string);
    this.#previews.set(preview.id, { preview, acceptedAuthorities });
    return PatchPreviewSchema.parse(preview);
    } finally {
      finishMutation();
    }
  }

  async approvePatch(sessionId: string, sourceHash: string, diffHash: string): Promise<{ approvalToken: string }> {
    const finishMutation = this.#beginMutation();
    try {
    const id = OpaqueIdSchema.parse(sessionId);
    const source = Sha256DigestSchema.parse(sourceHash);
    const diff = Sha256DigestSchema.parse(diffHash);
    const preview = [...this.#previews.values()]
      .map((record) => record.preview)
      .filter((item) => item.sessionId === id && item.sourceHash === source && item.diffHash === diff)
      .at(-1);
    if (!preview || preview.status !== "ready") throw new ReaderServiceError("PATCH_NOT_APPROVABLE");
    return ApprovalResultSchema.parse({
      approvalToken: this.dependencies.approvalAuthority.issue({ sessionId: id, sourceHash: source, diffHash: diff, targetPath: preview.targetPath }),
    });
    } finally {
      finishMutation();
    }
  }

  async writeExplained(sessionId: string, previewId: string, approvalToken: string): Promise<{ path: string }> {
    const finishMutation = this.#beginMutation();
    try {
    const session = this.#session(sessionId);
    const previewRecord = this.#previews.get(OpaqueIdSchema.parse(previewId));
    const preview = previewRecord?.preview;
    if (!preview || !previewRecord || preview.sessionId !== session.session.id) throw new ReaderServiceError("PATCH_NOT_FOUND");
    if (preview.status !== "ready") throw new ReaderServiceError("PATCH_NOT_APPROVABLE");
    const binding = { sessionId: session.session.id, sourceHash: preview.sourceHash, diffHash: preview.diffHash, targetPath: preview.targetPath };
    const reservation = this.dependencies.approvalAuthority.reserve(approvalToken, binding);
    if (!reservation) throw new ReaderServiceError("APPROVAL_INVALID");
    let approvalCommitted = false;
    try {
      const source = await this.#readExactSource(session.root.workspace, preview.sourcePath);
      if (
        source.hash !== preview.sourceHash ||
        sha256Text(preview.unifiedDiff) !== preview.diffHash ||
        sha256Text(preview.markdown) !== preview.resultHash
      ) throw new ReaderServiceError("SOURCE_CHANGED");
      const descriptor = await session.root.workspace.prepareSafeOutputSource(preview.sourcePath);
      if (descriptor.sourceContentSha256 !== preview.sourceHash) throw new ReaderServiceError("SOURCE_CHANGED");
      for (const authority of previewRecord.acceptedAuthorities) {
        await this.#assertAcceptedFresh(session.root.workspace, authority);
      }
      if ((await this.dependencies.writer.capability()).status !== "available") throw new ReaderServiceError("SAFE_WRITE_UNAVAILABLE");
      await this.dependencies.writer.createExplainedSibling(
        descriptor,
        preview.targetPath.split("/").at(-1)!,
        Buffer.from(preview.markdown, "utf8"),
      );
      if (!this.dependencies.approvalAuthority.commit(reservation)) {
        throw new ReaderServiceError("APPROVAL_INVALID");
      }
      approvalCommitted = true;
    } catch (error) {
      if (error instanceof ReaderServiceError) throw error;
      let outputAlreadyExists = false;
      if (typeof error === "object" && error !== null && !nodeUtilTypes.isProxy(error)) {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(error, "code");
          outputAlreadyExists = descriptor !== undefined &&
            "value" in descriptor && descriptor.value === "OUTPUT_ALREADY_EXISTS";
        } catch {
          outputAlreadyExists = false;
        }
      }
      if (outputAlreadyExists) throw new ReaderServiceError("OUTPUT_ALREADY_EXISTS");
      throw new ReaderServiceError("SAFE_WRITE_UNAVAILABLE");
    } finally {
      if (!approvalCommitted) this.dependencies.approvalAuthority.release(reservation);
    }
    return WriteResultSchema.parse({ path: preview.targetPath });
    } finally {
      finishMutation();
    }
  }

  async #runQuestion(run: ActiveRun, runId: string): Promise<void> {
    await this.#saveDraft(run, runId, "inspecting");
    this.#event(runId, "progress", { status: "inspecting", message: "Inspecting bounded project evidence." });
    while (!run.abort.signal.aborted) {
      let output: Exclude<BridgeQuestionEvent, { type: "progress" }> | undefined;
      for await (const event of this.dependencies.bridge.ask(run.session.session.id, {
        question: run.input.question,
        contextMode: run.contextMode,
        sourceAnchor: run.anchor,
        runId,
        generation: run.generation,
        snapshotDigest: run.snapshot.snapshotDigest,
        workspaceSnapshot: run.snapshot,
        evidencePackets: run.packets,
        expansionRequestsUsed: run.expansionRequestsUsed,
      }, run.abort.signal)) {
        if (event.type === "progress") {
          await this.#saveDraft(run, runId, "streaming_unverified");
          this.#event(runId, "progress", { status: "streaming_unverified", message: "Generating a structured answer." });
        } else output = event;
      }
      if (run.abort.signal.aborted || output?.type === "cancelled") {
        await this.#saveDraft(run, runId, "cancelled");
        this.#event(runId, "cancelled", { status: "cancelled", reason: "Question cancelled." });
        return;
      }
      if (!output || output.type === "failed") {
        await this.#saveDraft(run, runId, "failed");
        this.#event(runId, "failed", {
          status: "failed",
          code: "QUESTION_FAILED",
          message: "The side question failed safely.",
          retryable: true,
        });
        return;
      }
      if (output.output.kind === "evidence_request") {
        if (run.expansionRequestsUsed >= 2) {
          await this.#saveDraft(run, runId, "failed");
          this.#event(runId, "failed", { status: "failed", code: "QUESTION_FAILED", message: "The evidence expansion limit was reached.", retryable: true });
          return;
        }
        await this.#expandEvidence(run, runId, output.output.request.query);
        continue;
      }
      await this.#finishCandidate(run, runId, output.output.answer);
      return;
    }
    await this.#saveDraft(run, runId, "cancelled");
    this.#event(runId, "cancelled", { status: "cancelled", reason: "Question cancelled." });
  }

  async #finishCandidate(run: ActiveRun, runId: string, candidate: ModelAnswerCandidate): Promise<void> {
    await this.#saveDraft(run, runId, "validating");
    this.#event(runId, "progress", { status: "validating", message: "Validating citations and independent semantic support." });
    const relevantPaths = [...new Set(run.sources.map(({ path }) => path))];
    const current = await run.session.root.workspace.snapshot({ relevantPaths });
    const answer = await validateEvidence({
      candidate,
      expectedRunId: runId,
      expectedGeneration: run.generation,
      currentSnapshotDigest: current.snapshotDigest,
      contextMode: run.contextMode,
      documentPath: run.session.session.documentPath,
      packets: run.packets,
      readEvidence: async (path, startLine, endLine) => {
        const range = await run.session.root.workspace.readEvidenceRange(path, startLine, endLine);
        return { excerpt: range.excerpt, fileHash: range.fileHash };
      },
      idFactory: (scope) => this.#issueId(scope),
    });
    if (answer.reviewStatus === "stale") {
      await this.#saveDraft(run, runId, "stale");
      this.#event(runId, "stale", { status: "stale", reason: "Workspace evidence changed during the run.", retryable: true, answer });
      return;
    }
    if (answer.reviewStatus !== "citation_validated") {
      await this.#saveDraft(run, runId, "failed");
      this.#event(runId, "completed", { status: "completed", answer });
      return;
    }
    const audited = await this.dependencies.bridge.auditEvidence({
      sessionId: run.session.session.id,
      candidate,
      answer,
      workspaceSnapshot: run.snapshot,
    }, run.abort.signal);
    if (run.abort.signal.aborted || audited.status === "cancelled") {
      await this.#saveDraft(run, runId, "cancelled");
      this.#event(runId, "cancelled", { status: "cancelled", reason: "Question cancelled." });
      return;
    }
    if (audited.status !== "completed") {
      await this.#saveDraft(run, runId, "failed");
      this.#event(runId, "completed", { status: "completed", answer });
      return;
    }
    const postAuditSnapshot = await run.session.root.workspace.snapshot({ relevantPaths });
    if (postAuditSnapshot.snapshotDigest !== answer.snapshotDigest) {
      const staleAnswer = await validateEvidence({
        candidate,
        expectedRunId: runId,
        expectedGeneration: run.generation,
        currentSnapshotDigest: postAuditSnapshot.snapshotDigest,
        contextMode: run.contextMode,
        documentPath: run.session.session.documentPath,
        packets: run.packets,
        readEvidence: async (path, startLine, endLine) => {
          const range = await run.session.root.workspace.readEvidenceRange(path, startLine, endLine);
          return { excerpt: range.excerpt, fileHash: range.fileHash };
        },
        idFactory: (scope) => this.#issueId(scope),
      });
      await this.#saveDraft(run, runId, "stale");
      this.#event(runId, "stale", { status: "stale", reason: "Workspace evidence changed during independent review.", retryable: true, answer: staleAnswer });
      return;
    }
    const checkedAudit = validateEvidenceSupportAudit(answer, audited.output.supportReview);
    if (
      checkedAudit.reviewStatus !== audited.output.reviewStatus ||
      checkedAudit.unsupportedClaimIds.join("\0") !== audited.output.unsupportedClaimIds.join("\0")
    ) throw new ReaderServiceError("QUESTION_FAILED");
    const unsupportedUnknowns = checkedAudit.unsupportedClaimIds.map((claimId) => {
      const claim = answer.claims.find(({ id }) => id === claimId)!;
      return {
        id: this.#issueId("unknown"),
        code: "unsupported_claim" as const,
        statement: "Independent review found that the cited excerpts do not directly support this claim.",
        claimIds: [claimId],
        evidenceIds: claim.evidenceIds,
      };
    });
    const finalAnswer = EvidenceAnswerSchema.parse({
      ...answer,
      reviewStatus: checkedAudit.reviewStatus,
      supportReview: checkedAudit.supportReview,
      unknowns: checkedAudit.reviewStatus === "unsupported"
        ? [...answer.unknowns, ...unsupportedUnknowns]
        : answer.unknowns,
    });
    if (checkedAudit.reviewStatus === "evidence_reviewed") {
      const question = {
        id: runId,
        question: run.input.question,
        runId,
        generation: run.generation,
        status: "validating" as const,
        createdAt: this.#timestamp(),
      };
      await this.dependencies.repository.commitReviewedQuestion({
        id: runId,
        sessionId: run.session.session.id,
        anchor: run.anchor,
        questions: [{ ...question, status: "completed", answer: finalAnswer }],
        disposition: "reading_only",
        stale: false,
      });
      this.#accepted.set(runId, {
        answer,
        audit: audited.output,
        relevantPaths: [...new Set(run.sources.map(({ path }) => path))],
      });
    } else {
      await this.#saveDraft(run, runId, "failed");
    }
    this.#event(runId, "completed", { status: "completed", answer: finalAnswer });
  }

  async #initialEvidence(
    session: SessionRecord,
    input: AnchoredQuestionInput,
    anchor: SourceAnchor,
    runId: string,
    generation: string,
    documentSource: string,
  ) {
    const startLine = lineAtOffset(documentSource, anchor.startOffset);
    const endLine = lineAtOffset(documentSource, Math.max(anchor.startOffset, anchor.endOffset - 1));
    const documentSpec: EvidenceSpec = {
      kind: "project_document",
      path: session.session.documentPath,
      startLine,
      endLine,
    };
    let specs: EvidenceSpec[] = [documentSpec];
    let contextMode = session.session.contextMode;
    try {
      const resultBatches: WorkspaceSearchResult["matches"][] = [];
      for (const query of initialSearchQueries(input.question, anchor.selectedText)) {
        const search = await session.root.workspace.searchProject(query);
        resultBatches.push(search.matches.slice(0, 12));
      }
      for (let index = 0; index < 12 && uniqueSpecs(specs).length < 13; index += 1) {
        for (const matches of resultBatches) {
          const match = matches[index];
          if (match) {
            specs.push({ kind: evidenceKind(match.path), path: match.path, startLine: match.startLine, endLine: match.endLine });
          }
          if (uniqueSpecs(specs).length >= 13) break;
        }
      }
    } catch {
      contextMode = "document_only";
      specs = [documentSpec];
    }
    const sources = uniqueSpecs(specs).slice(0, 13);
    const snapshot = await session.root.workspace.snapshot({ relevantPaths: [...new Set(sources.map(({ path }) => path))] });
    const packet = await this.#issuePacket(session.root.workspace, sources, runId, generation, snapshot);
    return { sources, packets: [packet], snapshot, contextMode };
  }

  async #expandEvidence(run: ActiveRun, runId: string, query: string): Promise<void> {
    run.expansionRequestsUsed += 1;
    const search = await run.session.root.workspace.searchProject(query);
    const additions = uniqueSpecs(search.matches.slice(0, 12).map((match) => ({
      kind: evidenceKind(match.path),
      path: match.path,
      startLine: match.startLine,
      endLine: match.endLine,
    })));
    const previousPaths = new Set(run.sources.map(({ path }) => path));
    const previousKeys = new Set(run.sources.map((spec) => `${spec.kind}\0${spec.path}\0${spec.startLine}\0${spec.endLine}`));
    const fresh = additions.filter((spec) => !previousKeys.has(`${spec.kind}\0${spec.path}\0${spec.startLine}\0${spec.endLine}`));
    run.sources = uniqueSpecs([...run.sources, ...fresh]);
    const addsFile = fresh.some(({ path }) => !previousPaths.has(path));
    if (addsFile) {
      run.generation = OpaqueIdSchema.parse(this.#issueId("generation"));
      this.#runs.changeGeneration(runId, run.generation);
      run.snapshot = await run.session.root.workspace.snapshot({ relevantPaths: [...new Set(run.sources.map(({ path }) => path))] });
      run.packets = [await this.#issuePacket(run.session.root.workspace, run.sources, runId, run.generation, run.snapshot)];
      this.#event(runId, "status", { status: "inspecting" });
      await this.#saveDraft(run, runId, "inspecting");
      return;
    }
    if (fresh.length > 0) {
      run.packets.push(await this.#issuePacket(run.session.root.workspace, fresh, runId, run.generation, run.snapshot));
    }
    this.#event(runId, "progress", { status: "inspecting", message: "Expanded the bounded evidence packet." });
  }

  async #issuePacket(
    workspace: ReaderServiceWorkspace,
    specs: readonly EvidenceSpec[],
    runId: string,
    generation: string,
    snapshot: CreatedWorkspaceSnapshot,
  ): Promise<EvidencePacket> {
    const sources: EvidenceSource[] = await Promise.all(specs.map(async (spec) => {
      const range = await workspace.readEvidenceRange(spec.path, spec.startLine, spec.endLine);
      return {
        kind: spec.kind,
        path: range.path,
        excerpt: range.excerpt,
        fileHash: range.fileHash,
        sourceLocationKey: range.sourceLocationKey,
        startLine: range.startLine,
        endLine: range.endLine,
      };
    }));
    return issueEvidencePacket(
      { runId, generation, snapshotDigest: snapshot.snapshotDigest, sources },
      { idFactory: (scope) => this.#issueId(scope) },
    );
  }

  async #assertEvidenceFresh(workspace: ReaderServiceWorkspace, answer: EvidenceAnswer): Promise<void> {
    for (const item of answer.evidence) {
      if (!("path" in item)) continue;
      const current = await workspace.readEvidenceRange(item.path, item.startLine, item.endLine);
      if (current.fileHash !== item.fileHash || current.excerpt !== item.excerpt) {
        throw new ReaderServiceError("ANNOTATION_NOT_ACCEPTED");
      }
    }
  }

  async #assertAcceptedFresh(
    workspace: ReaderServiceWorkspace,
    authority: AcceptedAuthority,
  ): Promise<void> {
    await this.#assertEvidenceFresh(workspace, authority.answer);
    const snapshot = await workspace.snapshot({ relevantPaths: [...authority.relevantPaths] });
    if (snapshot.snapshotDigest !== authority.answer.snapshotDigest) {
      throw new ReaderServiceError("ANNOTATION_NOT_ACCEPTED");
    }
  }

  async #readExactSource(
    workspace: ReaderServiceWorkspace,
    path: string,
  ): Promise<{ path: string; source: string; hash: string }> {
    if (workspace.readDocumentSource) {
      const result = await workspace.readDocumentSource(path);
      const parsedPath = RelativePathSchema.parse(result.path);
      const hash = Sha256DigestSchema.parse(result.hash);
      if (sha256Text(result.source) !== hash) throw new ReaderServiceError("SOURCE_CHANGED");
      return { path: parsedPath, source: result.source, hash };
    }
    if (workspace.guard) {
      const file = await workspace.guard.readFileBytes(path);
      const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
      return { path: RelativePathSchema.parse(file.canonicalRelativePath), source, hash: sha256Text(source) };
    }
    throw new ReaderServiceError("DOCUMENT_NOT_FOUND");
  }

  async #saveDraft(
    run: ActiveRun,
    runId: string,
    status: "queued" | "inspecting" | "streaming_unverified" | "validating" | "stale" | "failed" | "cancelled",
  ): Promise<void> {
    await this.dependencies.repository.saveDraft({
      id: runId,
      sessionId: run.session.session.id,
      question: run.input.question,
      status,
      generation: run.generation,
    });
  }

  #event(runId: string, type: QuestionRunEvent["type"], payload: unknown): void {
    this.#runs.append({
      runId,
      generation: this.#runs.generation(runId),
      sequence: this.#runs.nextSequence(runId),
      createdAt: this.#timestamp(),
      type,
      payload,
    });
  }

  #isTerminal(runId: string): boolean {
    const page = this.#runs.poll(runId);
    return page.outcome === "events" && page.events.some((event) => ["completed", "stale", "failed", "cancelled"].includes(event.type));
  }

  #timestamp(): string {
    const date = this.#now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new ReaderServiceError("QUESTION_FAILED");
    return date.toISOString();
  }

  #root(rawRootId: string): ReaderRootBinding {
    const root = this.#roots.get(OpaqueIdSchema.parse(rawRootId));
    if (!root) throw new ReaderServiceError("ROOT_NOT_FOUND");
    return root;
  }

  #session(rawSessionId: string): SessionRecord {
    const session = this.#sessions.get(OpaqueIdSchema.parse(rawSessionId));
    if (!session) throw new ReaderServiceError("SESSION_NOT_FOUND");
    return session;
  }

  async #isRootAuthorized(
    root: ReaderRootBinding,
    observed: readonly { readonly uri: string }[] | undefined,
  ): Promise<boolean> {
    if (observed === undefined) return root.requiresMcpRoot !== true;
    if (!root.authorizeMcpRoots) return false;
    try {
      return await root.authorizeMcpRoots(observed);
    } catch {
      return false;
    }
  }

  #beginMutation(): () => void {
    this.#assertOpen();
    let settle!: () => void;
    const marker = new Promise<void>((resolve) => { settle = resolve; });
    this.#inFlightMutations.add(marker);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#inFlightMutations.delete(marker);
      settle();
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new ReaderServiceError("SERVICE_CLOSED");
  }
}
