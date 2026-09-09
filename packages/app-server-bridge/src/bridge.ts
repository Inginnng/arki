import { posix, win32 } from "node:path";

import {
  EditIntentBatchSchema,
  EvidenceAnswerSchema,
  EvidenceSupportReviewSchema,
  ModelQuestionOutputSchema,
  OpaqueIdSchema,
  ReaderSessionSchema,
  Sha256DigestSchema,
  SourceAnchorSchema,
  type AnswerClaim,
  type Disposition,
  type EditIntentBatch,
  type EvidenceAnswer,
  type EvidenceReference,
  type EvidenceSupportReview,
  type ModelAnswerCandidate,
  type ModelQuestionOutput,
  type ReaderSession,
  type SourceAnchor,
} from "@aimd/contracts";
import {
  authenticateWorkspaceSnapshotForRecapture,
  authenticateValidatedEvidenceAnswerForAudit,
  digestCanonicalJson,
  serializeIssuedEvidenceForModel,
  validateEvidenceQuestionOutput,
  validateEvidenceSupportAudit,
  type CreatedWorkspaceSnapshot,
  type EvidencePacket,
  type EvidenceSupportAuditResult,
  type WorkspaceSnapshotRecapturePlan,
} from "@aimd/reader-core";
import { z } from "zod";

import type {
  AppServerEvent,
  AppServerThread,
} from "./client.js";
import { collectProtocolInternalIds } from "./client.js";
import {
  inspectModelEvent,
  normalizeModelIsolationResult,
  type ModelIsolationResult,
} from "./isolation.js";
import {
  createPublicBindingHandle,
  type HostContextCandidate,
  type UnverifiedBinding,
} from "./metadata.js";
import {
  SERVER_OWNED_MODEL_POLICY,
  buildEvidenceAuditTurn,
  buildQuestionTurn,
  buildSynthesisTurn,
  type ServerOwnedModelTurn,
} from "./policy.js";

export interface BridgeAppServerClient {
  initialize(): Promise<{ userAgent: string; platformFamily: string; platformOs: string }>;
  readThread(threadId: string, includeTurns?: boolean): Promise<AppServerThread>;
  modelIsolationResult(): ModelIsolationResult;
  assertModelSandbox?(): Promise<void>;
  captureWorkspaceDigest?(plan: WorkspaceSnapshotRecapturePlan): Promise<string>;
  forkEphemeral(input: {
    threadId: string;
    lastTurnId?: string;
    emptyCwd: string;
    developerInstructions: string;
  }): Promise<AppServerThread>;
  startProjectEphemeralThread(input: {
    emptyCwd: string;
    developerInstructions: string;
  }): Promise<AppServerThread>;
  startTurn(
    input: {
      threadId: string;
      emptyCwd: string;
      text: string;
      outputSchema?: unknown;
    },
    signal?: AbortSignal,
  ): AsyncIterable<AppServerEvent>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
}

export type TaskBindingResult =
  | {
      status: "verified";
      bindingId: string;
      cutoffLabel: "Through the latest completed parent turn";
    }
  | {
      status: "unavailable";
      code: "TASK_CONTEXT_UNAVAILABLE" | "NO_COMPLETED_PARENT_TURN";
    }
  | {
      status: "mismatch";
      code: "TASK_CONTEXT_MISMATCH" | "TASK_TURN_MISMATCH" | "TASK_WORKSPACE_MISMATCH";
    };

/** Internal host-authoritative cwd lookup used before a project root is narrowed. */
export type TaskWorkspaceResolution =
  | { status: "resolved"; workspaceRoot: string }
  | { status: "unavailable" };

export type AnchoredQuestion = {
  question: string;
  contextMode: "task_and_project" | "project_only" | "document_only";
  sourceAnchor: SourceAnchor;
  runId: string;
  generation: string;
  snapshotDigest: string;
  workspaceSnapshot: CreatedWorkspaceSnapshot;
  evidencePackets: readonly EvidencePacket[];
  expansionRequestsUsed: number;
};

export type EvidenceAuditInput = {
  sessionId: string;
  candidate: ModelAnswerCandidate;
  answer: EvidenceAnswer;
  workspaceSnapshot: CreatedWorkspaceSnapshot;
};

export type AcceptedSynthesisAnnotation = {
  annotationId: string;
  disposition: Exclude<Disposition, "reading_only" | "ignore">;
  anchor: SourceAnchor;
  claims: readonly AnswerClaim[];
  evidence: readonly EvidenceReference[];
};

export type AcceptedSynthesisAnnotationRequest = {
  annotationId: string;
  disposition: Exclude<Disposition, "reading_only" | "ignore">;
  answer: EvidenceAnswer;
  auditResult: EvidenceSupportAuditResult;
};

export type SynthesisInput = {
  documentPath: string;
  documentHash: string;
  snapshotDigest: string;
  workspaceSnapshot: CreatedWorkspaceSnapshot;
  annotations: readonly AcceptedSynthesisAnnotation[];
};

export type BridgeOperationFailureCode =
  | "SESSION_NOT_FOUND"
  | "MODEL_ISOLATION_UNPROVEN"
  | "MODEL_ISOLATION_BROKEN"
  | "TOOL_ISOLATION_BROKEN"
  | "READ_ONLY_INVARIANT_UNPROVEN"
  | "READ_ONLY_INVARIANT_BROKEN"
  | "WORKSPACE_SNAPSHOT_STALE"
  | "QUESTION_PACKET_INVALID"
  | "MODEL_OUTPUT_INVALID"
  | "APP_SERVER_RESTARTED"
  | "APP_SERVER_TURN_FAILED"
  | "APP_SERVER_TURN_TERMINATED";

export type BridgeOperationResult<T> =
  | { status: "completed"; output: T }
  | { status: "failed"; code: BridgeOperationFailureCode }
  | { status: "cancelled" };

export type BridgeQuestionEvent =
  | { type: "progress"; phase: "started" }
  | { type: "completed"; output: ModelQuestionOutput }
  | {
      type: "failed";
      code:
        BridgeOperationFailureCode;
    }
  | { type: "cancelled" };

export class ContextBridgeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ContextBridgeError";
    this.code = code;
  }
}

type VerifiedBindingRecord = {
  sourceThreadId: string;
  lastCompletedTurnId: string;
  expectedForkTurns: Array<{
    id: string;
    status: AppServerThread["turns"][number]["status"];
  }>;
  workspaceRoot: string;
  knownIds: Set<string>;
};

type SessionRecord = {
  sideThreadId: string;
  contextMode: "task_and_project" | "project_only";
  workspaceRoot: string;
  workspaceRootId: string;
  documentPath: string;
  knownIds: Set<string>;
};

export type ContextBridgeOptions = {
  issueOpaqueId: () => string;
  emptyCwd: string;
  workspaceSnapshot: CreatedWorkspaceSnapshot;
  assertModelSandbox?: () => Promise<void>;
  captureWorkspaceDigest?: (plan: WorkspaceSnapshotRecapturePlan) => Promise<string>;
  /** Internal resource policy/test seam; never sourced from model or MCP input. */
  limits?: {
    maxSessions?: number;
    maxVerifiedBindings?: number;
    maxObservedExecutionIds?: number;
    maxAuditKnownIds?: number;
    maxStoredKnownIdReferences?: number;
  };
};

const BRIDGE_HARD_LIMITS = {
  maxSessions: 4_096,
  maxVerifiedBindings: 1_024,
  maxObservedExecutionIds: 65_536,
  maxAuditKnownIds: 16_384,
  maxStoredKnownIdReferences: 65_536,
} as const;

type NormalizedContextBridgeLimits = {
  readonly maxSessions: number;
  readonly maxVerifiedBindings: number;
  readonly maxObservedExecutionIds: number;
  readonly maxAuditKnownIds: number;
  readonly maxStoredKnownIdReferences: number;
};

function bridgeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new ContextBridgeError("BRIDGE_LIMIT_INVALID");
  return Math.min(value, fallback);
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "");
}

function sameWorkspace(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

type PathFlavor = "windows" | "posix";

function absolutePathFlavor(value: string): PathFlavor | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\0")) {
    return undefined;
  }
  if (win32.isAbsolute(value)) return "windows";
  if (posix.isAbsolute(value)) return "posix";
  return undefined;
}

function pathsOverlap(left: string, right: string, flavor: PathFlavor): boolean {
  const pathApi = flavor === "windows" ? win32 : posix;
  const relative = pathApi.relative(left, right);
  return relative.length === 0 || (
    relative !== ".." &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
}

function isSeparatedAbsoluteSandbox(workspaceRoot: string, sandboxPath: string): boolean {
  const rootFlavor = absolutePathFlavor(workspaceRoot);
  const sandboxFlavor = absolutePathFlavor(sandboxPath);
  if (!rootFlavor || rootFlavor !== sandboxFlavor) return false;
  return !pathsOverlap(workspaceRoot, sandboxPath, rootFlavor) &&
    !pathsOverlap(sandboxPath, workspaceRoot, rootFlavor);
}

function workspaceLabel(root: string): string {
  return root.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) || "workspace";
}

function latestCompletedTurn(thread: AppServerThread): AppServerThread["turns"][number] | undefined {
  // `thread/read(includeTurns: true)` returns rollout history in host order.
  // Timestamps are nullable metadata and must never be compared with indexes.
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = thread.turns[index];
    if (turn?.status === "completed") return turn;
  }
  return undefined;
}

function redactKnownIds(value: string, knownIds: ReadonlySet<string>): string {
  let redacted = value;
  for (const id of [...knownIds].sort((left, right) => right.length - left.length)) {
    if (id.length > 0) redacted = redacted.split(id).join("[redacted-id]");
  }
  return redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeStructuredData<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) freezeStructuredData(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function exactOwnDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Input must be an own-data record");
  }
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError("Input must be an own-data record");
  }
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new TypeError("Input must contain only the expected own properties");
  }
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new TypeError("Input must be an own-data record");
    }
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("Input must use own data properties");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function exactOwnDataArray(value: unknown, maximumLength: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Input must be an own-data array");
  let keys: readonly PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw new TypeError("Input must be an own-data array");
  }
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value as unknown
    : undefined;
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximumLength) {
    throw new TypeError("Input array length is invalid");
  }
  const expectedKeys = [
    ...Array.from({ length: length as number }, (_, index) => String(index)),
    "length",
  ];
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new TypeError("Input array must contain only dense own data properties");
  }
  const result: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      throw new TypeError("Input must be an own-data array");
    }
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("Input array must use own data properties");
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function parseOwnSourceAnchor(value: unknown): SourceAnchor {
  const anchor = exactOwnDataRecord(value, [
    "documentPath",
    "documentHash",
    "headingPath",
    "selectedText",
    "prefix",
    "suffix",
    "startOffset",
    "endOffset",
  ]);
  const headingPath = exactOwnDataArray(anchor.headingPath, 64);
  return freezeStructuredData(SourceAnchorSchema.parse({
    documentPath: anchor.documentPath,
    documentHash: anchor.documentHash,
    headingPath,
    selectedText: anchor.selectedText,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
    startOffset: anchor.startOffset,
    endOffset: anchor.endOffset,
  }));
}

function parseOwnHostContextCandidate(value: unknown): HostContextCandidate | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  let statusDescriptor: PropertyDescriptor | undefined;
  let turnDescriptor: PropertyDescriptor | undefined;
  try {
    statusDescriptor = Object.getOwnPropertyDescriptor(value, "status");
    turnDescriptor = Object.getOwnPropertyDescriptor(value, "parentTurnId");
  } catch {
    return undefined;
  }
  if (!statusDescriptor || !("value" in statusDescriptor) || statusDescriptor.value !== "candidate") {
    return undefined;
  }
  try {
    const fields = exactOwnDataRecord(value, turnDescriptor === undefined
      ? ["status", "parentThreadId", "source"]
      : ["status", "parentThreadId", "parentTurnId", "source"]);
    if (fields.status !== "candidate" || fields.source !== "codex-hidden-meta") return undefined;
    const parentThreadId = OpaqueIdSchema.parse(fields.parentThreadId);
    if (turnDescriptor === undefined) {
      return Object.freeze({
        status: "candidate",
        parentThreadId,
        source: "codex-hidden-meta",
      });
    }
    const parentTurnId = OpaqueIdSchema.parse(fields.parentTurnId);
    return Object.freeze({
      status: "candidate",
      parentThreadId,
      parentTurnId,
      source: "codex-hidden-meta",
    });
  } catch {
    return undefined;
  }
}

function parseOwnTaskBindingResult(value: unknown): TaskBindingResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  let statusDescriptor: PropertyDescriptor | undefined;
  try {
    statusDescriptor = Object.getOwnPropertyDescriptor(value, "status");
  } catch {
    return undefined;
  }
  if (!statusDescriptor || !("value" in statusDescriptor)) return undefined;
  try {
    if (statusDescriptor.value === "verified") {
      const fields = exactOwnDataRecord(value, ["status", "bindingId", "cutoffLabel"]);
      if (fields.cutoffLabel !== "Through the latest completed parent turn") return undefined;
      return Object.freeze({
        status: "verified",
        bindingId: OpaqueIdSchema.parse(fields.bindingId),
        cutoffLabel: "Through the latest completed parent turn",
      });
    }
    if (statusDescriptor.value === "unavailable") {
      const fields = exactOwnDataRecord(value, ["status", "code"]);
      if (
        fields.code !== "TASK_CONTEXT_UNAVAILABLE" &&
        fields.code !== "NO_COMPLETED_PARENT_TURN"
      ) return undefined;
      return Object.freeze({ status: "unavailable", code: fields.code });
    }
    if (statusDescriptor.value === "mismatch") {
      const fields = exactOwnDataRecord(value, ["status", "code"]);
      if (
        fields.code !== "TASK_CONTEXT_MISMATCH" &&
        fields.code !== "TASK_TURN_MISMATCH" &&
        fields.code !== "TASK_WORKSPACE_MISMATCH"
      ) return undefined;
      return Object.freeze({ status: "mismatch", code: fields.code });
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function sameSourceAnchor(left: SourceAnchor, right: SourceAnchor): boolean {
  return left.documentPath === right.documentPath &&
    left.documentHash === right.documentHash &&
    left.selectedText === right.selectedText &&
    left.prefix === right.prefix &&
    left.suffix === right.suffix &&
    left.startOffset === right.startOffset &&
    left.endOffset === right.endOffset &&
    left.headingPath.length === right.headingPath.length &&
    left.headingPath.every((heading, index) => heading === right.headingPath[index]);
}

function validateSynthesisAuthorityOutput(
  annotations: readonly AcceptedSynthesisAnnotation[],
  batch: EditIntentBatch,
): EditIntentBatch {
  const expected = new Map(annotations.map((annotation) => [annotation.annotationId, annotation]));
  const outcomes = [
    ...batch.intents.map((intent) => intent.annotationId),
    ...batch.conflicts.map((conflict) => conflict.annotationId),
  ];
  if (
    outcomes.length !== expected.size ||
    outcomes.some((annotationId) => !expected.has(annotationId)) ||
    [...expected.keys()].some((annotationId) => !outcomes.includes(annotationId))
  ) {
    throw new TypeError("Synthesis output must cover the exact accepted annotation set");
  }
  for (const intent of batch.intents) {
    const annotation = expected.get(intent.annotationId);
    if (!annotation || !sameSourceAnchor(intent.targetAnchor, annotation.anchor)) {
      throw new TypeError("Synthesis output changed an accepted source anchor");
    }
    const evidenceIds = new Set(annotation.evidence.map((evidence) => evidence.id));
    if (intent.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))) {
      throw new TypeError("Synthesis output cited evidence outside its accepted annotation");
    }
  }
  return batch;
}

function collectTurnAndItemIds(
  turns: AppServerThread["turns"],
  target: Set<string>,
): void {
  for (const turn of turns) {
    for (const id of collectProtocolInternalIds(turn)) target.add(id);
  }
}

function redactDecodedStrings(value: unknown, knownIds: ReadonlySet<string>): unknown {
  if (typeof value === "string") return redactKnownIds(value, knownIds);
  if (Array.isArray(value)) {
    return value.map((item) => redactDecodedStrings(item, knownIds));
  }
  if (!isRecord(value)) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[redactKnownIds(key, knownIds)] = redactDecodedStrings(item, knownIds);
  }
  return redacted;
}

// The prefix excludes path/URL token characters instead of allowlisting a few
// delimiters. This catches `path=C:/...`, `[C:/...]`, blockquote/comma forms,
// and decoded variants without treating the `s:/` suffix in `https://` as a
// Windows drive path.
const WINDOWS_ABSOLUTE_LOCATION = /(?:^|[^A-Za-z0-9_.@~:/\\-])(?:[A-Za-z]:[\\/]|\\\\(?:[?.]\\)?[^\\/\s]+[\\/])[^\s<>"'`]*/u;
const UNIX_ABSOLUTE_LOCATION = /(?:^|[^A-Za-z0-9_.@~:/\\-])\/(?:[^/\s<>"'`]+\/)*[^/\s<>"'`]+/u;
const FILE_LOCATION_URI = /(?:^|[^A-Za-z0-9_.@~:/\\-])file:(?:\/\/)?[^\s<>"'`]*/iu;
const RAW_SOURCE_LOCATION = /(?:^|[^A-Za-z0-9_.@~:/\\-])(?:\.{0,2}[\\/])?(?:[A-Za-z0-9_.@~-]+[\\/])+[A-Za-z0-9_.@~-]+\.[A-Za-z0-9]{1,16}(?:(?::|#L)\d+(?:[-:]\d+)?)?(?=$|[\s),.;'"?#\]])/u;

const MAX_LOCATION_DECODE_PASSES = 8;
const PERCENT_BYTE_RUN = /(?:%[0-9A-Fa-f]{2})+/gu;

function decodePercentByteRuns(value: string): string {
  return value.replace(PERCENT_BYTE_RUN, (encoded) => {
    const bytes = encoded.match(/[0-9A-Fa-f]{2}/gu);
    return bytes
      ? Buffer.from(bytes.map((byte) => Number.parseInt(byte, 16))).toString("utf8")
      : encoded;
  });
}

function decodedLocationCandidates(value: string): string[] {
  const candidates = [value];
  let current = value;
  let passes = 0;
  for (; passes < MAX_LOCATION_DECODE_PASSES; passes += 1) {
    const decoded = decodePercentByteRuns(current);
    if (decoded === current) break;
    candidates.push(decoded);
    current = decoded;
  }
  if (
    passes === MAX_LOCATION_DECODE_PASSES &&
    decodePercentByteRuns(current) !== current
  ) {
    throw new TypeError("MODEL_OUTPUT_ENCODING_DEPTH_FORBIDDEN");
  }
  return candidates;
}

function normalizeLocationSeparators(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[∕⁄／⧸]/gu, "/")
    .replace(/[⧵＼﹨]/gu, "\\");
}

function removeUnambiguousClosingHtmlTags(value: string): string {
  // A syntactically complete one-name closing tag is Markdown/HTML prose, not a
  // path token. Embedded separators (for example `</etc/passwd>`) do not match
  // and remain subject to the absolute-location detector.
  return value.replace(/<\/[A-Za-z][A-Za-z0-9-]*>/gu, "");
}

function visitModelStrings(value: unknown, visitor: (text: string) => void): void {
  if (typeof value === "string") {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitModelStrings(item, visitor);
    return;
  }
  if (!isRecord(value)) return;
  for (const item of Object.values(value)) visitModelStrings(item, visitor);
}

function assertNoAbsoluteModelLocations(value: unknown, workspaceRoot: string): void {
  const normalizedRoot = normalizedPath(workspaceRoot);
  const foldedRoot = /^[A-Za-z]:\//u.test(normalizedRoot)
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
  visitModelStrings(value, (text) => {
    for (const candidate of decodedLocationCandidates(text)) {
      const locationCandidate = removeUnambiguousClosingHtmlTags(
        normalizeLocationSeparators(candidate),
      );
      const normalized = locationCandidate.replaceAll("\\", "/");
      const folded = /^[A-Za-z]:\//u.test(foldedRoot) ? normalized.toLowerCase() : normalized;
      if (
        (foldedRoot.length > 0 && folded.includes(foldedRoot)) ||
        WINDOWS_ABSOLUTE_LOCATION.test(locationCandidate) ||
        UNIX_ABSOLUTE_LOCATION.test(locationCandidate) ||
        FILE_LOCATION_URI.test(locationCandidate)
      ) {
        throw new TypeError("MODEL_OUTPUT_LOCATION_FORBIDDEN");
      }
    }
  });
}

function assertNoRawSourceLocations(value: unknown): void {
  visitModelStrings(value, (text) => {
    for (const candidate of decodedLocationCandidates(text)) {
      if (RAW_SOURCE_LOCATION.test(normalizeLocationSeparators(candidate))) {
        throw new TypeError("MODEL_OUTPUT_LOCATION_FORBIDDEN");
      }
    }
  });
}

function fixedTransportFailure(error: unknown): "APP_SERVER_RESTARTED" | "APP_SERVER_TURN_FAILED" {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "APP_SERVER_EXITED"
  ) {
    return "APP_SERVER_RESTARTED";
  }
  return "APP_SERVER_TURN_FAILED";
}

const MAX_MODEL_OUTPUT_BYTES = 1_048_576;

type InternalRunEvent<T> =
  | { type: "started" }
  | { type: "completed"; output: T }
  | { type: "failed"; code: BridgeOperationFailureCode }
  | { type: "cancelled" };

export class ContextBridge {
  private readonly verifiedBindings = new Map<string, VerifiedBindingRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly auditKnownIds = new Set<string>();
  private readonly observedExecutionIds = new Set<string>();
  private readonly questionCandidates = new WeakMap<object, {
    readonly sessionId: string;
    readonly sourceAnchor: SourceAnchor;
    readonly runId: string;
    readonly generation: string;
    readonly snapshotDigest: string;
    readonly candidateDigest: string;
  }>();
  private readonly reviewedAudits = new WeakMap<object, {
    readonly sessionId: string;
    readonly answer: EvidenceAnswer;
    readonly candidate: ModelAnswerCandidate;
    readonly sourceAnchor: SourceAnchor;
    readonly auditResult: EvidenceSupportAuditResult;
  }>();
  private readonly acceptedSynthesisAnnotations = new WeakMap<object, {
    readonly sessionId: string;
    readonly annotation: AcceptedSynthesisAnnotation;
  }>();
  private readonly sessionTurnTails = new Map<string, Promise<void>>();
  private readonly limits: NormalizedContextBridgeLimits;
  private creatingSessions = 0;
  private verifyingBindings = 0;
  private storedKnownIdReferences = 0;
  private initializePromise?: Promise<unknown>;
  private isolationBroken = false;
  private readOnlyBroken = false;
  private modelSandboxBroken = false;
  private appServerRestarted = false;
  private readonly workspaceAuthority: WorkspaceSnapshotRecapturePlan;

  constructor(
    private readonly client: BridgeAppServerClient,
    private readonly options: ContextBridgeOptions,
  ) {
    this.limits = {
      maxSessions: bridgeLimit(options.limits?.maxSessions, BRIDGE_HARD_LIMITS.maxSessions),
      maxVerifiedBindings: bridgeLimit(options.limits?.maxVerifiedBindings, BRIDGE_HARD_LIMITS.maxVerifiedBindings),
      maxObservedExecutionIds: bridgeLimit(options.limits?.maxObservedExecutionIds, BRIDGE_HARD_LIMITS.maxObservedExecutionIds),
      maxAuditKnownIds: bridgeLimit(options.limits?.maxAuditKnownIds, BRIDGE_HARD_LIMITS.maxAuditKnownIds),
      maxStoredKnownIdReferences: bridgeLimit(options.limits?.maxStoredKnownIdReferences, BRIDGE_HARD_LIMITS.maxStoredKnownIdReferences),
    };
    try {
      this.workspaceAuthority = authenticateWorkspaceSnapshotForRecapture(
        options.workspaceSnapshot,
      );
    } catch {
      throw new ContextBridgeError("WORKSPACE_AUTHORITY_INVALID");
    }
  }

  private modelIsolationResult(): ModelIsolationResult {
    try {
      return normalizeModelIsolationResult(this.client.modelIsolationResult());
    } catch {
      return {
        status: "reader_only",
        code: "MODEL_ISOLATION_UNPROVEN",
        missing: ["effectiveTools.hostAttestation"],
      };
    }
  }

  async modelExecutionStatus(): Promise<ModelIsolationResult> {
    return this.modelIsolationResult();
  }

  private async captureWorkspaceDigest(plan: WorkspaceSnapshotRecapturePlan): Promise<string> {
    const capture = this.options.captureWorkspaceDigest ?? this.client.captureWorkspaceDigest;
    if (!capture) throw new ContextBridgeError("READ_ONLY_INVARIANT_UNPROVEN");
    try {
      return Sha256DigestSchema.parse(await capture.call(this.client, plan));
    } catch {
      throw new ContextBridgeError("READ_ONLY_INVARIANT_UNPROVEN");
    }
  }

  private async assertModelSandbox(): Promise<void> {
    const assertSandbox = this.options.assertModelSandbox ?? this.client.assertModelSandbox;
    if (!assertSandbox) throw new ContextBridgeError("MODEL_SANDBOX_UNAVAILABLE");
    try {
      await assertSandbox.call(this.client);
    } catch {
      throw new ContextBridgeError("MODEL_SANDBOX_UNAVAILABLE");
    }
  }

  private async acquireSessionTurn(sessionId: string): Promise<() => void> {
    const previous = this.sessionTurnTails.get(sessionId) ?? Promise.resolve();
    let resolveCurrent!: () => void;
    const current = new Promise<void>((resolve) => { resolveCurrent = resolve; });
    const tail = previous.then(() => current, () => current);
    this.sessionTurnTails.set(sessionId, tail);
    await previous.catch(() => undefined);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      resolveCurrent();
      void tail.then(() => {
        if (this.sessionTurnTails.get(sessionId) === tail) {
          this.sessionTurnTails.delete(sessionId);
        }
      });
    };
  }

  private async createDocumentOnlyThread(
    signal?: AbortSignal,
  ): Promise<BridgeOperationResult<{ threadId: string; knownIds: Set<string> }>> {
    const blocked = this.executionFailure();
    if (blocked) return { status: "failed", code: blocked };
    if (signal?.aborted) return { status: "cancelled" };
    try {
      await this.assertModelSandbox();
    } catch {
      this.modelSandboxBroken = true;
      return { status: "failed", code: "MODEL_ISOLATION_BROKEN" };
    }
    if (signal?.aborted) return { status: "cancelled" };

    let thread: AppServerThread;
    try {
      await this.initialize();
      thread = await this.client.startProjectEphemeralThread({
        emptyCwd: this.options.emptyCwd,
        developerInstructions: SERVER_OWNED_MODEL_POLICY,
      });
    } catch (error) {
      const code = fixedTransportFailure(error);
      if (code === "APP_SERVER_RESTARTED") this.appServerRestarted = true;
      return { status: "failed", code };
    }
    const knownBefore = this.allKnownInternalIds();
    const initialIds = collectProtocolInternalIds(thread);
    const initialIdsAreFresh = this.observeExecutionIds(initialIds);
    if (
      !initialIdsAreFresh ||
      !thread.ephemeral ||
      thread.forkedFromId !== null ||
      !sameWorkspace(thread.cwd, this.options.emptyCwd) ||
      thread.status.type !== "idle" ||
      thread.turns.length !== 0 ||
      initialIds.some((id) => knownBefore.has(id))
    ) {
      return { status: "failed", code: "MODEL_ISOLATION_UNPROVEN" };
    }
    if (signal?.aborted) return { status: "cancelled" };

    let verified: AppServerThread;
    try {
      verified = await this.client.readThread(thread.id, true);
    } catch (error) {
      const code = fixedTransportFailure(error);
      if (code === "APP_SERVER_RESTARTED") this.appServerRestarted = true;
      return { status: "failed", code };
    }
    const verifiedIds = collectProtocolInternalIds(verified);
    const verifiedIdsAreFresh = this.observeExecutionIds(verifiedIds, {
      allowedExecutionIds: new Set(initialIds),
    });
    if (
      !verifiedIdsAreFresh ||
      verified.id !== thread.id ||
      !verified.ephemeral ||
      verified.forkedFromId !== null ||
      !sameWorkspace(verified.cwd, this.options.emptyCwd) ||
      verified.status.type !== "idle" ||
      verified.turns.length !== 0 ||
      verifiedIds.some((id) => knownBefore.has(id))
    ) {
      return { status: "failed", code: "MODEL_ISOLATION_UNPROVEN" };
    }
    if (signal?.aborted) return { status: "cancelled" };
    return {
      status: "completed",
      output: {
        threadId: verified.id,
        knownIds: new Set([...initialIds, ...verifiedIds]),
      },
    };
  }

  private initialize(): Promise<unknown> {
    this.initializePromise ??= this.client.initialize();
    return this.initializePromise;
  }

  private issueOpaqueId(): string {
    return OpaqueIdSchema.parse(this.options.issueOpaqueId());
  }

  private allKnownInternalIds(): Set<string> {
    const ids = new Set<string>([
      ...this.auditKnownIds,
      ...this.observedExecutionIds,
    ]);
    for (const record of this.verifiedBindings.values()) {
      for (const id of record.knownIds) ids.add(id);
    }
    for (const session of this.sessions.values()) {
      for (const id of session.knownIds) ids.add(id);
    }
    return ids;
  }

  private observeExecutionIds(
    ids: readonly string[],
    options: {
      allowedKnownIds?: ReadonlySet<string>;
      allowedExecutionIds?: ReadonlySet<string>;
    } = {},
  ): boolean {
    const knownBefore = this.allKnownInternalIds();
    let collision = false;
    const newExecutionIds = new Set(
      ids.filter((id) => !this.observedExecutionIds.has(id)),
    );
    if (
      this.observedExecutionIds.size + newExecutionIds.size >
      this.limits.maxObservedExecutionIds
    ) {
      this.isolationBroken = true;
      return false;
    }
    for (const id of ids) {
      const allowedExecution = options.allowedExecutionIds?.has(id) ?? false;
      if (
        (this.observedExecutionIds.has(id) && !allowedExecution) ||
        (
          knownBefore.has(id) &&
          !(options.allowedKnownIds?.has(id) ?? false) &&
          !allowedExecution
        )
      ) {
        collision = true;
      }
    }
    // Observation is monotonic even when this response later fails shape or
    // collision checks. A rejected host id can never be retried as fresh.
    for (const id of ids) {
      const isExpectedCopiedHistory =
        (options.allowedKnownIds?.has(id) ?? false) &&
        !this.observedExecutionIds.has(id);
      if (!isExpectedCopiedHistory) this.observedExecutionIds.add(id);
    }
    return !collision;
  }

  private rememberAuditIds(ids: readonly string[]): boolean {
    const additions = new Set(ids.filter((id) => !this.auditKnownIds.has(id)));
    if (this.auditKnownIds.size + additions.size > this.limits.maxAuditKnownIds) {
      this.isolationBroken = true;
      return false;
    }
    for (const id of ids) this.auditKnownIds.add(id);
    return true;
  }

  async resolveTaskWorkspace(rawBinding: UnverifiedBinding): Promise<TaskWorkspaceResolution> {
    const binding = parseOwnHostContextCandidate(rawBinding);
    if (!binding) return { status: "unavailable" };
    let thread: AppServerThread;
    try {
      await this.initialize();
      thread = await this.client.readThread(binding.parentThreadId, true);
    } catch {
      return { status: "unavailable" };
    }
    if (
      thread.id !== binding.parentThreadId ||
      absolutePathFlavor(thread.cwd) === undefined ||
      (
        binding.parentTurnId !== undefined &&
        !thread.turns.some((turn) => turn.id === binding.parentTurnId)
      )
    ) return { status: "unavailable" };
    return { status: "resolved", workspaceRoot: thread.cwd };
  }

  async verifyBinding(
    rawBinding: UnverifiedBinding,
    workspaceRoot: string,
  ): Promise<TaskBindingResult> {
    if (
      this.verifiedBindings.size + this.verifyingBindings >=
      this.limits.maxVerifiedBindings
    ) return { status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" };
    this.verifyingBindings += 1;
    try {
    const binding = parseOwnHostContextCandidate(rawBinding);
    if (!binding) {
      return { status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" };
    }
    let thread: AppServerThread;
    try {
      await this.initialize();
      thread = await this.client.readThread(binding.parentThreadId, true);
    } catch {
      return { status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" };
    }
    if (thread.id !== binding.parentThreadId) {
      return { status: "mismatch", code: "TASK_CONTEXT_MISMATCH" };
    }
    if (!sameWorkspace(thread.cwd, workspaceRoot)) {
      return { status: "mismatch", code: "TASK_WORKSPACE_MISMATCH" };
    }
    if (
      binding.parentTurnId &&
      !thread.turns.some((turn) => turn.id === binding.parentTurnId)
    ) {
      return { status: "mismatch", code: "TASK_TURN_MISMATCH" };
    }

    const completed = latestCompletedTurn(thread);
    if (!completed) {
      return { status: "unavailable", code: "NO_COMPLETED_PARENT_TURN" };
    }

    const completedIndex = thread.turns.findIndex((turn) => turn.id === completed.id);
    if (completedIndex < 0) {
      return { status: "unavailable", code: "NO_COMPLETED_PARENT_TURN" };
    }
    const knownIds = new Set<string>([thread.id]);
    for (const id of thread.internalIds ?? []) knownIds.add(id);
    collectTurnAndItemIds(thread.turns, knownIds);
    if (
      this.storedKnownIdReferences + knownIds.size >
      this.limits.maxStoredKnownIdReferences
    ) return { status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" };

    const handle = createPublicBindingHandle(
      binding,
      () => this.issueOpaqueId(),
    );
    this.verifiedBindings.set(handle.bindingId, {
      sourceThreadId: thread.id,
      lastCompletedTurnId: completed.id,
      expectedForkTurns: thread.turns
        .slice(0, completedIndex + 1)
        .map((turn) => ({ id: turn.id, status: turn.status })),
      workspaceRoot,
      knownIds,
    });
    this.storedKnownIdReferences += knownIds.size;
    return {
      status: "verified",
      bindingId: handle.bindingId,
      cutoffLabel: "Through the latest completed parent turn",
    };
    } finally {
      this.verifyingBindings -= 1;
    }
  }

  async createSession(
    rawBinding: TaskBindingResult,
    workspaceRoot: string,
    documentPath: string,
  ): Promise<ReaderSession> {
    if (
      this.isolationBroken ||
      this.sessions.size + this.creatingSessions >= this.limits.maxSessions
    ) throw new ContextBridgeError("BRIDGE_CAPACITY_EXCEEDED");
    this.creatingSessions += 1;
    try {
    const binding = parseOwnTaskBindingResult(rawBinding);
    if (!binding) throw new ContextBridgeError("BINDING_HANDLE_INVALID");
    if (!sameWorkspace(workspaceRoot, this.workspaceAuthority.projectRoot)) {
      throw new ContextBridgeError("WORKSPACE_AUTHORITY_INVALID");
    }
    if (!isSeparatedAbsoluteSandbox(workspaceRoot, this.options.emptyCwd)) {
      throw new ContextBridgeError("MODEL_SANDBOX_UNAVAILABLE");
    }
    await this.assertModelSandbox();
    try {
      await this.initialize();
    } catch {
      throw new ContextBridgeError("TASK_CONTEXT_UNAVAILABLE");
    }
    let sideThread: AppServerThread;
    let contextMode: SessionRecord["contextMode"];
    let bindingStatus: ReaderSession["bindingStatus"];
    let degradationReason: string | undefined;
    let cutoffLabel: string | undefined;
    let knownIds = new Set<string>();

    if (binding.status === "verified") {
      const record = this.verifiedBindings.get(binding.bindingId);
      if (!record || !sameWorkspace(record.workspaceRoot, workspaceRoot)) {
        throw new ContextBridgeError("BINDING_HANDLE_INVALID");
      }
      try {
        sideThread = await this.client.forkEphemeral({
          threadId: record.sourceThreadId,
          lastTurnId: record.lastCompletedTurnId,
          emptyCwd: this.options.emptyCwd,
          developerInstructions: SERVER_OWNED_MODEL_POLICY,
        });
      } catch {
        throw new ContextBridgeError("TASK_CONTEXT_UNAVAILABLE");
      }
      const forkIds = collectProtocolInternalIds(sideThread);
      const forkIdsAreFresh = this.observeExecutionIds(forkIds, {
        allowedKnownIds: record.knownIds,
      });
      if (
        !forkIdsAreFresh ||
        record.knownIds.has(sideThread.id) ||
        !sideThread.ephemeral ||
        sideThread.forkedFromId !== record.sourceThreadId ||
        !sameWorkspace(sideThread.cwd, this.options.emptyCwd) ||
        sideThread.status.type !== "idle" ||
        sideThread.turns.length !== record.expectedForkTurns.length ||
        sideThread.turns.some((turn, index) =>
          turn.status === "inProgress" ||
          turn.id !== record.expectedForkTurns[index]?.id ||
          turn.status !== record.expectedForkTurns[index]?.status
        ) ||
        sideThread.turns.at(-1)?.id !== record.lastCompletedTurnId ||
        sideThread.turns.at(-1)?.status !== "completed"
      ) {
        throw new ContextBridgeError("EPHEMERAL_FORK_INVALID");
      }
      contextMode = "task_and_project";
      bindingStatus = "verified";
      cutoffLabel = binding.cutoffLabel;
      knownIds = new Set([...record.knownIds, sideThread.id]);
      for (const id of sideThread.internalIds ?? []) knownIds.add(id);
      collectTurnAndItemIds(sideThread.turns, knownIds);
    } else {
      try {
        sideThread = await this.client.startProjectEphemeralThread({
          emptyCwd: this.options.emptyCwd,
          developerInstructions: SERVER_OWNED_MODEL_POLICY,
        });
      } catch {
        throw new ContextBridgeError("TASK_CONTEXT_UNAVAILABLE");
      }
      const projectThreadIds = collectProtocolInternalIds(sideThread);
      const projectThreadIdsAreFresh = this.observeExecutionIds(projectThreadIds);
      if (
        !projectThreadIdsAreFresh ||
        !sideThread.ephemeral ||
        sideThread.forkedFromId !== null ||
        !sameWorkspace(sideThread.cwd, this.options.emptyCwd) ||
        sideThread.status.type !== "idle" ||
        sideThread.turns.length !== 0
      ) {
        throw new ContextBridgeError("PROJECT_EPHEMERAL_THREAD_INVALID");
      }
      contextMode = "project_only";
      bindingStatus = binding.status;
      degradationReason = "Task context unavailable; project evidence only";
      knownIds.add(sideThread.id);
      for (const id of sideThread.internalIds ?? []) knownIds.add(id);
    }

    await this.assertModelSandbox();

    const id = this.issueOpaqueId();
    const sessionInput = {
      id,
      bindingStatus,
      contextMode,
      rootId: this.workspaceAuthority.rootId,
      workspaceLabel: workspaceLabel(workspaceRoot),
      documentPath,
      ...(cutoffLabel ? { cutoffLabel } : {}),
      ...(degradationReason ? { degradationReason } : {}),
    };
    const parsed = ReaderSessionSchema.safeParse(sessionInput);
    if (!parsed.success) throw new ContextBridgeError("READER_SESSION_INVALID");
    if (
      this.storedKnownIdReferences + knownIds.size >
      this.limits.maxStoredKnownIdReferences
    ) {
      this.isolationBroken = true;
      throw new ContextBridgeError("BRIDGE_CAPACITY_EXCEEDED");
    }
    this.sessions.set(id, {
      sideThreadId: sideThread.id,
      contextMode,
      workspaceRoot,
      workspaceRootId: this.workspaceAuthority.rootId,
      documentPath: parsed.data.documentPath,
      knownIds,
    });
    this.storedKnownIdReferences += knownIds.size;
    return parsed.data;
    } finally {
      this.creatingSessions -= 1;
    }
  }

  private executionFailure(): BridgeOperationFailureCode | undefined {
    if (this.appServerRestarted) return "APP_SERVER_RESTARTED";
    if (this.isolationBroken) return "TOOL_ISOLATION_BROKEN";
    if (this.modelSandboxBroken) return "MODEL_ISOLATION_BROKEN";
    if (this.readOnlyBroken) return "READ_ONLY_INVARIANT_BROKEN";
    const isolation = this.modelIsolationResult();
    if (isolation.status === "enabled") return undefined;
    return isolation.code === "MODEL_ISOLATION_BROKEN"
      ? "MODEL_ISOLATION_BROKEN"
      : "MODEL_ISOLATION_UNPROVEN";
  }

  private async *runStructuredTurn<T>(input: {
    threadId: string;
    workspaceRoot: string;
    snapshotPlan: WorkspaceSnapshotRecapturePlan;
    knownIds: Set<string>;
    turn: ServerOwnedModelTurn;
    schema: z.ZodType<T>;
    signal?: AbortSignal;
  }): AsyncIterable<InternalRunEvent<T>> {
    const blocked = this.executionFailure();
    if (blocked) {
      yield { type: "failed", code: blocked };
      return;
    }
    if (input.signal?.aborted) {
      yield { type: "cancelled" };
      return;
    }
    if (input.turn.developerInstructions !== SERVER_OWNED_MODEL_POLICY) {
      yield { type: "failed", code: "MODEL_ISOLATION_UNPROVEN" };
      return;
    }

    try {
      await this.assertModelSandbox();
    } catch {
      this.modelSandboxBroken = true;
      yield { type: "failed", code: "MODEL_ISOLATION_BROKEN" };
      return;
    }
    if (input.signal?.aborted) {
      yield { type: "cancelled" };
      return;
    }

    let before: string;
    try {
      before = await this.captureWorkspaceDigest(input.snapshotPlan);
    } catch {
      yield { type: "failed", code: "READ_ONLY_INVARIANT_UNPROVEN" };
      return;
    }
    if (input.signal?.aborted) {
      yield { type: "cancelled" };
      return;
    }
    if (before !== input.snapshotPlan.snapshotDigest) {
      yield { type: "failed", code: "WORKSPACE_SNAPSHOT_STALE" };
      return;
    }

    const currentRunIds = new Set<string>();
    const registerRunIds = (ids: readonly string[]): boolean => {
      const accepted = this.observeExecutionIds(ids, {
        allowedExecutionIds: currentRunIds,
      });
      for (const id of ids) {
        currentRunIds.add(id);
        input.knownIds.add(id);
      }
      return accepted;
    };

    let afterChecked = false;
    let afterFailure: BridgeOperationFailureCode | undefined;
    const checkAfter = async (): Promise<BridgeOperationFailureCode | undefined> => {
      if (afterChecked) return afterFailure;
      afterChecked = true;
      try {
        await this.assertModelSandbox();
      } catch {
        this.modelSandboxBroken = true;
        afterFailure = "MODEL_ISOLATION_BROKEN";
        return afterFailure;
      }
      let after: string;
      try {
        after = await this.captureWorkspaceDigest(input.snapshotPlan);
      } catch {
        afterFailure = "READ_ONLY_INVARIANT_UNPROVEN";
        return afterFailure;
      }
      if (after !== before) {
        this.readOnlyBroken = true;
        afterFailure = "READ_ONLY_INVARIANT_BROKEN";
      }
      return afterFailure;
    };
    let turnId: string | undefined;
    let outputText = "";
    let outputBytes = 0;
    const interrupt = async (): Promise<void> => {
      if (!turnId) return;
      try {
        await this.client.interruptTurn(input.threadId, turnId);
      } catch {
        // Public failures stay fixed and contain no transport text.
      }
    };

    try {
      if (input.signal?.aborted) {
        yield { type: "cancelled" };
        return;
      }
      for await (const event of this.client.startTurn(
        {
          threadId: input.threadId,
          emptyCwd: this.options.emptyCwd,
          text: input.turn.text,
          outputSchema: input.turn.outputSchema,
        },
        input.signal,
      )) {
        if (event.type === "started") {
          if (turnId !== undefined) {
            await interrupt();
            const invariantFailure = await checkAfter();
            yield { type: "failed", code: invariantFailure ?? "APP_SERVER_TURN_FAILED" };
            return;
          }
          turnId = event.turnId;
          if (!registerRunIds([event.turnId])) {
            await interrupt();
            const invariantFailure = await checkAfter();
            yield { type: "failed", code: invariantFailure ?? "MODEL_ISOLATION_UNPROVEN" };
            return;
          }
          yield { type: "started" };
          continue;
        }
        if (event.type === "text_delta") {
          const deltaBytes = Buffer.byteLength(event.text, "utf8");
          if (deltaBytes > MAX_MODEL_OUTPUT_BYTES - outputBytes) {
            await interrupt();
            const invariantFailure = await checkAfter();
            yield { type: "failed", code: invariantFailure ?? "MODEL_OUTPUT_INVALID" };
            return;
          }
          outputBytes += deltaBytes;
          outputText += event.text;
          continue;
        }
        if (event.type === "item") {
          if (!registerRunIds(collectProtocolInternalIds(event.item))) {
            await interrupt();
            const invariantFailure = await checkAfter();
            yield { type: "failed", code: invariantFailure ?? "MODEL_ISOLATION_UNPROVEN" };
            return;
          }
          if (inspectModelEvent(event.item).status === "breach") {
            this.isolationBroken = true;
            await interrupt();
            await checkAfter();
            yield { type: "failed", code: "TOOL_ISOLATION_BROKEN" };
            return;
          }
          continue;
        }
        if (event.type === "cancelled") {
          const invariantFailure = await checkAfter();
          yield invariantFailure
            ? { type: "failed", code: invariantFailure }
            : { type: "cancelled" };
          return;
        }

        if (input.signal?.aborted) {
          await interrupt();
          const invariantFailure = await checkAfter();
          yield invariantFailure
            ? { type: "failed", code: invariantFailure }
            : { type: "cancelled" };
          return;
        }

        if (!registerRunIds(collectProtocolInternalIds(event.turn))) {
          await interrupt();
          const invariantFailure = await checkAfter();
          yield { type: "failed", code: invariantFailure ?? "MODEL_ISOLATION_UNPROVEN" };
          return;
        }
        if (event.turn.items.some((item) => inspectModelEvent(item).status === "breach")) {
          this.isolationBroken = true;
          await interrupt();
          await checkAfter();
          yield { type: "failed", code: "TOOL_ISOLATION_BROKEN" };
          return;
        }
        if (event.turn.status !== "completed") {
          const invariantFailure = await checkAfter();
          yield input.signal?.aborted && !invariantFailure
            ? { type: "cancelled" }
            : { type: "failed", code: invariantFailure ?? "APP_SERVER_TURN_FAILED" };
          return;
        }

        let parsedOutput: T;
        try {
          const decoded = redactDecodedStrings(JSON.parse(outputText), input.knownIds);
          parsedOutput = input.schema.parse(decoded);
          assertNoAbsoluteModelLocations(parsedOutput, input.workspaceRoot);
        } catch {
          const invariantFailure = await checkAfter();
          yield { type: "failed", code: invariantFailure ?? "MODEL_OUTPUT_INVALID" };
          return;
        }
        const invariantFailure = await checkAfter();
        if (invariantFailure) {
          yield { type: "failed", code: invariantFailure };
          return;
        }
        yield { type: "completed", output: parsedOutput };
        return;
      }
    } catch (error) {
      const invariantFailure = await checkAfter();
      if (invariantFailure) {
        yield { type: "failed", code: invariantFailure };
        return;
      }
      const failure = fixedTransportFailure(error);
      if (failure === "APP_SERVER_RESTARTED") this.appServerRestarted = true;
      yield input.signal?.aborted
        ? { type: "cancelled" }
        : { type: "failed", code: failure };
      return;
    } finally {
      if (!afterChecked) await checkAfter();
    }
    const invariantFailure = await checkAfter();
    yield input.signal?.aborted && !invariantFailure
      ? { type: "cancelled" }
      : { type: "failed", code: invariantFailure ?? "APP_SERVER_TURN_TERMINATED" };
  }

  async *ask(
    sessionId: string,
    question: AnchoredQuestion,
    signal?: AbortSignal,
  ): AsyncIterable<BridgeQuestionEvent> {
    if (!this.sessions.has(sessionId)) {
      yield { type: "failed", code: "SESSION_NOT_FOUND" };
      return;
    }
    const release = await this.acquireSessionTurn(sessionId);
    try {
      yield* this.askInSession(sessionId, question, signal);
    } finally {
      release();
    }
  }

  private async *askInSession(
    sessionId: string,
    question: AnchoredQuestion,
    signal?: AbortSignal,
  ): AsyncIterable<BridgeQuestionEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      yield { type: "failed", code: "SESSION_NOT_FOUND" };
      return;
    }

    let turn: ServerOwnedModelTurn;
    let issuedEvidenceIds: Set<string>;
    let snapshotPlan: WorkspaceSnapshotRecapturePlan;
    let sourceAnchor: SourceAnchor;
    let runId: string;
    let generation: string;
    let snapshotDigest: string;
    let expansionRequestsUsed: number;
    let contextMode: AnchoredQuestion["contextMode"];
    try {
      const values = exactOwnDataRecord(question, [
        "question",
        "contextMode",
        "sourceAnchor",
        "runId",
        "generation",
        "snapshotDigest",
        "workspaceSnapshot",
        "evidencePackets",
        "expansionRequestsUsed",
      ]);
      const questionText = z.string().parse(values.question);
      contextMode = z.enum(["task_and_project", "project_only", "document_only"])
        .parse(values.contextMode);
      if (contextMode !== session.contextMode && contextMode !== "document_only") {
        throw new TypeError("QUESTION_CONTEXT_MODE_INVALID");
      }
      sourceAnchor = parseOwnSourceAnchor(values.sourceAnchor);
      runId = OpaqueIdSchema.parse(values.runId);
      generation = OpaqueIdSchema.parse(values.generation);
      snapshotDigest = Sha256DigestSchema.parse(values.snapshotDigest);
      expansionRequestsUsed = z.number().int().min(0).max(2).parse(values.expansionRequestsUsed);
      const evidencePackets = exactOwnDataArray(values.evidencePackets, 3) as readonly EvidencePacket[];
      snapshotPlan = authenticateWorkspaceSnapshotForRecapture(
        values.workspaceSnapshot as CreatedWorkspaceSnapshot,
      );
      if (
        snapshotPlan.snapshotDigest !== snapshotDigest ||
        snapshotPlan.rootId !== session.workspaceRootId ||
        !sameWorkspace(snapshotPlan.projectRoot, session.workspaceRoot)
      ) throw new TypeError("QUESTION_SNAPSHOT_INVALID");
      const packet = serializeIssuedEvidenceForModel({
        packets: evidencePackets,
        expectedRunId: runId,
        expectedGeneration: generation,
        expectedSnapshotDigest: snapshotDigest,
      });
      issuedEvidenceIds = new Set(packet.evidence.map((evidence) => evidence.id));
      turn = buildQuestionTurn({
        contextMode,
        documentPath: session.documentPath,
        sourceAnchor,
        question: questionText,
        snapshotDigest,
        evidencePacket: packet,
      });
    } catch {
      yield { type: "failed", code: "QUESTION_PACKET_INVALID" };
      return;
    }

    let executionThreadId = session.sideThreadId;
    let executionKnownIds = session.knownIds;
    if (contextMode === "document_only") {
      const isolated = await this.createDocumentOnlyThread(signal);
      if (isolated.status === "cancelled") {
        yield { type: "cancelled" };
        return;
      }
      if (isolated.status === "failed") {
        yield { type: "failed", code: isolated.code };
        return;
      }
      executionThreadId = isolated.output.threadId;
      executionKnownIds = isolated.output.knownIds;
    }

    for await (const event of this.runStructuredTurn({
      threadId: executionThreadId,
      workspaceRoot: session.workspaceRoot,
      snapshotPlan,
      knownIds: executionKnownIds,
      turn,
      schema: ModelQuestionOutputSchema,
      ...(signal === undefined ? {} : { signal }),
    })) {
      if (event.type === "started") {
        yield { type: "progress", phase: "started" };
        continue;
      }
      if (event.type === "failed" || event.type === "cancelled") {
        yield event;
        return;
      }
      try {
        const output = freezeStructuredData(validateEvidenceQuestionOutput(
          event.output,
          expansionRequestsUsed,
        ));
        assertNoRawSourceLocations(output);
        if (output.kind === "answer") {
          const citedIds = [
            ...output.answer.claims.flatMap((claim) => claim.evidenceIds),
            ...output.answer.unknowns.flatMap((unknown) => unknown.evidenceIds),
          ];
          if (
            citedIds.some((id) => !issuedEvidenceIds.has(id)) ||
            output.answer.claims.some((claim) => claim.category === "task_decision")
          ) {
            throw new TypeError("MODEL_EVIDENCE_INVALID");
          }
          this.questionCandidates.set(output.answer, Object.freeze({
            sessionId,
            sourceAnchor,
            runId,
            generation,
            snapshotDigest,
            candidateDigest: digestCanonicalJson(output.answer),
          }));
        }
        yield { type: "completed", output };
      } catch {
        yield { type: "failed", code: "MODEL_OUTPUT_INVALID" };
      }
      return;
    }
  }

  private async collectStructuredResult<T>(
    events: AsyncIterable<InternalRunEvent<T>>,
  ): Promise<BridgeOperationResult<T>> {
    for await (const event of events) {
      if (event.type === "started") continue;
      if (event.type === "completed") return { status: "completed", output: event.output };
      if (event.type === "cancelled") return { status: "cancelled" };
      return { status: "failed", code: event.code };
    }
    return { status: "failed", code: "APP_SERVER_TURN_TERMINATED" };
  }

  async auditEvidence(
    input: EvidenceAuditInput,
    signal?: AbortSignal,
  ): Promise<BridgeOperationResult<EvidenceSupportAuditResult>> {
    const blocked = this.executionFailure();
    if (blocked) return { status: "failed", code: blocked };
    let sessionId: string;
    let rawCandidate: ModelAnswerCandidate;
    let rawAnswer: EvidenceAnswer;
    let rawWorkspaceSnapshot: CreatedWorkspaceSnapshot;
    try {
      const values = exactOwnDataRecord(
        input,
        ["sessionId", "candidate", "answer", "workspaceSnapshot"],
      );
      sessionId = OpaqueIdSchema.parse(values.sessionId);
      rawCandidate = values.candidate as ModelAnswerCandidate;
      rawAnswer = values.answer as EvidenceAnswer;
      rawWorkspaceSnapshot = values.workspaceSnapshot as CreatedWorkspaceSnapshot;
    } catch {
      return { status: "failed", code: "QUESTION_PACKET_INVALID" };
    }
    const session = this.sessions.get(sessionId);
    if (!session) return { status: "failed", code: "SESSION_NOT_FOUND" };
    let answer: EvidenceAnswer;
    let turn: ServerOwnedModelTurn;
    let snapshotPlan: WorkspaceSnapshotRecapturePlan;
    try {
      if (typeof rawCandidate !== "object" || rawCandidate === null) {
        throw new TypeError("AUDIT_CANDIDATE_INVALID");
      }
      const candidateBinding = this.questionCandidates.get(rawCandidate);
      answer = authenticateValidatedEvidenceAnswerForAudit(rawAnswer);
      snapshotPlan = authenticateWorkspaceSnapshotForRecapture(rawWorkspaceSnapshot);
      if (
        !candidateBinding ||
        candidateBinding.sessionId !== sessionId ||
        candidateBinding.runId !== answer.runId ||
        candidateBinding.generation !== answer.generation ||
        candidateBinding.snapshotDigest !== answer.snapshotDigest ||
        candidateBinding.candidateDigest !== answer.candidateDigest ||
        digestCanonicalJson(rawCandidate) !== candidateBinding.candidateDigest ||
        snapshotPlan.snapshotDigest !== answer.snapshotDigest ||
        snapshotPlan.rootId !== session.workspaceRootId ||
        !sameWorkspace(snapshotPlan.projectRoot, session.workspaceRoot)
      ) throw new TypeError("AUDIT_SNAPSHOT_INVALID");
      turn = buildEvidenceAuditTurn({ answer });
    } catch {
      return { status: "failed", code: "QUESTION_PACKET_INVALID" };
    }

    let auditThread: AppServerThread;
    try {
      await this.initialize();
      auditThread = await this.client.startProjectEphemeralThread({
        emptyCwd: this.options.emptyCwd,
        developerInstructions: turn.developerInstructions,
      });
    } catch {
      return { status: "failed", code: "APP_SERVER_TURN_FAILED" };
    }
    const knownBeforeAudit = new Set<string>(this.auditKnownIds);
    for (const record of this.verifiedBindings.values()) {
      for (const id of record.knownIds) knownBeforeAudit.add(id);
    }
    for (const record of this.sessions.values()) {
      for (const id of record.knownIds) knownBeforeAudit.add(id);
    }
    const responseIds = collectProtocolInternalIds(auditThread);
    const responseIdsAreFresh = this.observeExecutionIds(responseIds);
    const responseIdsRemembered = this.rememberAuditIds(responseIds);
    if (
      !responseIdsAreFresh ||
      !responseIdsRemembered ||
      !auditThread.ephemeral ||
      auditThread.forkedFromId !== null ||
      !sameWorkspace(auditThread.cwd, this.options.emptyCwd) ||
      auditThread.status.type !== "idle" ||
      auditThread.turns.length !== 0 ||
      responseIds.some((id) => knownBeforeAudit.has(id))
    ) {
      return { status: "failed", code: "MODEL_ISOLATION_UNPROVEN" };
    }
    let verifiedAuditThread: AppServerThread;
    try {
      verifiedAuditThread = await this.client.readThread(auditThread.id, true);
    } catch {
      return { status: "failed", code: "APP_SERVER_TURN_FAILED" };
    }
    const verifiedResponseIds = collectProtocolInternalIds(verifiedAuditThread);
    const verifiedResponseIdsAreFresh = this.observeExecutionIds(verifiedResponseIds, {
      allowedExecutionIds: new Set(responseIds),
    });
    const verifiedResponseIdsRemembered = this.rememberAuditIds(verifiedResponseIds);
    if (
      !verifiedResponseIdsAreFresh ||
      !verifiedResponseIdsRemembered ||
      verifiedAuditThread.id !== auditThread.id ||
      !verifiedAuditThread.ephemeral ||
      verifiedAuditThread.forkedFromId !== null ||
      !sameWorkspace(verifiedAuditThread.cwd, this.options.emptyCwd) ||
      verifiedAuditThread.status.type !== "idle" ||
      verifiedAuditThread.turns.length !== 0 ||
      verifiedResponseIds.some((id) => knownBeforeAudit.has(id))
    ) {
      return { status: "failed", code: "MODEL_ISOLATION_UNPROVEN" };
    }
    const result = await this.collectStructuredResult(this.runStructuredTurn({
      threadId: auditThread.id,
      workspaceRoot: session.workspaceRoot,
      snapshotPlan,
      knownIds: this.auditKnownIds,
      turn,
      schema: EvidenceSupportReviewSchema,
      ...(signal === undefined ? {} : { signal }),
    }));
    if (result.status !== "completed") return result;
    try {
      assertNoRawSourceLocations(result.output);
      const auditResult = freezeStructuredData(
        validateEvidenceSupportAudit(answer, result.output),
      );
      this.reviewedAudits.set(auditResult, {
        sessionId,
        answer: rawAnswer,
        candidate: rawCandidate,
        sourceAnchor: this.questionCandidates.get(rawCandidate)!.sourceAnchor,
        auditResult,
      });
      return {
        status: "completed",
        output: auditResult,
      };
    } catch {
      return { status: "failed", code: "MODEL_OUTPUT_INVALID" };
    }
  }

  issueAcceptedSynthesisAnnotation(
    sessionId: string,
    input: AcceptedSynthesisAnnotationRequest,
  ): AcceptedSynthesisAnnotation {
    const session = this.sessions.get(sessionId);
    let annotationId: string;
    let disposition: Exclude<Disposition, "reading_only" | "ignore">;
    let rawAnswer: EvidenceAnswer;
    let rawAuditResult: EvidenceSupportAuditResult;
    try {
      const values = exactOwnDataRecord(
        input,
        ["annotationId", "disposition", "answer", "auditResult"],
      );
      annotationId = OpaqueIdSchema.parse(values.annotationId);
      disposition = values.disposition as Exclude<Disposition, "reading_only" | "ignore">;
      rawAnswer = values.answer as EvidenceAnswer;
      rawAuditResult = values.auditResult as EvidenceSupportAuditResult;
    } catch {
      throw new ContextBridgeError("ANNOTATION_AUTHORITY_INVALID");
    }
    const auditBinding = typeof rawAuditResult === "object" && rawAuditResult !== null
      ? this.reviewedAudits.get(rawAuditResult)
      : undefined;
    if (
      !session ||
      !auditBinding ||
      auditBinding.sessionId !== sessionId ||
      auditBinding.answer !== rawAnswer ||
      auditBinding.auditResult.reviewStatus !== "evidence_reviewed" ||
      auditBinding.auditResult.unsupportedClaimIds.length !== 0
    ) {
      throw new ContextBridgeError("ANNOTATION_AUTHORITY_INVALID");
    }
    try {
      const answer = authenticateValidatedEvidenceAnswerForAudit(rawAnswer);
      const anchor = auditBinding.sourceAnchor;
      if (
        answer.documentPath !== session.documentPath ||
        anchor.documentPath !== session.documentPath ||
        answer.evidence.length === 0 ||
        !(["inline", "replace", "glossary", "faq"] as const).includes(disposition)
      ) throw new TypeError("Accepted annotation does not bind this reader session");
      const evidenceIds = new Set(answer.evidence.map((evidence) => evidence.id));
      if (answer.claims.some((claim) => claim.evidenceIds.some((id) => !evidenceIds.has(id)))) {
        throw new TypeError("Accepted annotation claims do not bind validated evidence");
      }
      const annotation = freezeStructuredData<AcceptedSynthesisAnnotation>({
        annotationId,
        disposition,
        anchor,
        claims: [...answer.claims],
        evidence: [...answer.evidence],
      });
      this.acceptedSynthesisAnnotations.set(annotation, { sessionId, annotation });
      return annotation;
    } catch (error) {
      if (error instanceof ContextBridgeError) throw error;
      throw new ContextBridgeError("ANNOTATION_AUTHORITY_INVALID");
    }
  }

  async synthesize(
    sessionId: string,
    input: SynthesisInput,
    signal?: AbortSignal,
  ): Promise<BridgeOperationResult<EditIntentBatch>> {
    if (!this.sessions.has(sessionId)) {
      return { status: "failed", code: "SESSION_NOT_FOUND" };
    }
    const release = await this.acquireSessionTurn(sessionId);
    try {
      return await this.synthesizeInSession(sessionId, input, signal);
    } finally {
      release();
    }
  }

  private async synthesizeInSession(
    sessionId: string,
    input: SynthesisInput,
    signal?: AbortSignal,
  ): Promise<BridgeOperationResult<EditIntentBatch>> {
    const session = this.sessions.get(sessionId);
    if (!session) return { status: "failed", code: "SESSION_NOT_FOUND" };
    let turn: ServerOwnedModelTurn;
    let snapshotPlan: WorkspaceSnapshotRecapturePlan;
    let trustedAnnotations: readonly AcceptedSynthesisAnnotation[];
    try {
      const values = exactOwnDataRecord(input, [
        "documentPath",
        "documentHash",
        "snapshotDigest",
        "workspaceSnapshot",
        "annotations",
      ]);
      const documentPath = z.string().parse(values.documentPath);
      const documentHash = Sha256DigestSchema.parse(values.documentHash);
      const snapshotDigest = Sha256DigestSchema.parse(values.snapshotDigest);
      const annotations = exactOwnDataArray(values.annotations, 64);
      if (documentPath !== session.documentPath) {
        throw new TypeError("SYNTHESIS_DOCUMENT_INVALID");
      }
      snapshotPlan = authenticateWorkspaceSnapshotForRecapture(
        values.workspaceSnapshot as CreatedWorkspaceSnapshot,
      );
      if (
        snapshotPlan.snapshotDigest !== snapshotDigest ||
        snapshotPlan.rootId !== session.workspaceRootId ||
        !sameWorkspace(snapshotPlan.projectRoot, session.workspaceRoot)
      ) throw new TypeError("SYNTHESIS_SNAPSHOT_INVALID");
      trustedAnnotations = annotations.map((rawAnnotation) => {
        if (typeof rawAnnotation !== "object" || rawAnnotation === null) {
          throw new TypeError("SYNTHESIS_ANNOTATION_INVALID");
        }
        const binding = this.acceptedSynthesisAnnotations.get(rawAnnotation);
        if (!binding || binding.sessionId !== sessionId) {
          throw new TypeError("SYNTHESIS_ANNOTATION_INVALID");
        }
        return binding.annotation;
      });
      turn = buildSynthesisTurn({
        documentPath,
        documentHash,
        snapshotDigest,
        annotations: trustedAnnotations,
      });
    } catch {
      return { status: "failed", code: "QUESTION_PACKET_INVALID" };
    }
    const result = await this.collectStructuredResult(this.runStructuredTurn({
      threadId: session.sideThreadId,
      workspaceRoot: session.workspaceRoot,
      snapshotPlan,
      knownIds: session.knownIds,
      turn,
      schema: EditIntentBatchSchema,
      ...(signal === undefined ? {} : { signal }),
    }));
    if (result.status !== "completed") return result;
    try {
      return {
        status: "completed",
        output: validateSynthesisAuthorityOutput(trustedAnnotations, result.output),
      };
    } catch {
      return { status: "failed", code: "MODEL_OUTPUT_INVALID" };
    }
  }
}
