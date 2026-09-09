import { randomUUID } from "node:crypto";

import {
  ContextModeSchema,
  EvidenceAnswerSchema,
  EvidenceReferenceSchema,
  EvidenceSupportReviewSchema,
  ModelAnswerCandidateSchema,
  ModelQuestionOutputSchema,
  OpaqueIdSchema,
  RelativePathSchema,
  Sha256DigestSchema,
  type AnswerReviewStatus,
  type ContextMode,
  type EvidenceAnswer,
  type EvidenceReference,
  type EvidenceSupportReview,
  type ModelAnswerCandidate,
  type ModelQuestionOutput,
} from "@aimd/contracts";

import { digestCanonicalJson, sha256Text } from "./hash.js";
import {
  assertSnapshotEvidenceBinding,
  assertSnapshotRegistration,
} from "./snapshot.js";

export type ProjectEvidenceKind =
  | "code_excerpt"
  | "test_excerpt"
  | "project_document";

export type ProjectEvidenceReference = Extract<
  EvidenceReference,
  { kind: ProjectEvidenceKind }
>;

export type EvidenceSource = {
  readonly kind: ProjectEvidenceKind;
  readonly path: string;
  /** Exact, unnumbered text returned by the guarded workspace range read. */
  readonly excerpt: string;
  /** SHA-256 of the guarded file's original bytes, including any BOM. */
  readonly fileHash: string;
  /** Opaque trusted same-file key; never copied into the public packet. */
  readonly sourceLocationKey: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly heading?: string;
};

export type EvidenceIdScope = "packet" | "evidence" | "unknown";
export type EvidenceIdFactory = (scope: EvidenceIdScope, index: number) => string;

/**
 * Transient workspace/project evidence issued by this process. It intentionally
 * does not assemble context-bridge task decisions or answer-service inference;
 * that multi-issuer boundary belongs to the side-context orchestration layer.
 *
 * JSON serialization is suitable for the model's read-only prompt, but a
 * deserialized copy is not a trusted packet and cannot be validated as issued.
 */
export type EvidencePacket = {
  readonly packetId: string;
  readonly runId: string;
  readonly generation: string;
  readonly snapshotDigest: string;
  readonly evidence: readonly ProjectEvidenceReference[];
  /** Detects mutation after trusted issuance; it is not a remote signature. */
  readonly integrityDigest: string;
};

export type IssueEvidencePacketInput = {
  readonly runId: string;
  readonly generation: string;
  /**
   * Must have been returned by createWorkspaceSnapshot in this process.
   * An expansion may cite only files already present in that snapshot's
   * relevant-file set. Discovering another file requires the caller to create
   * a union snapshot, start a new generation, and reissue all evidence with
   * new ids before retrying the model.
   */
  readonly snapshotDigest: string;
  readonly sources: readonly EvidenceSource[];
};

export type IssueEvidencePacketOptions = {
  readonly idFactory?: EvidenceIdFactory;
};

type ValidateEvidenceBaseInput = {
  readonly candidate: ModelAnswerCandidate;
  readonly expectedRunId: string;
  readonly expectedGeneration: string;
  readonly currentSnapshotDigest: string;
  readonly contextMode: ContextMode;
  readonly documentPath?: string;
  readonly readEvidence: (
    path: string,
    startLine: number,
    endLine: number,
  ) => EvidenceRangeRead | Promise<EvidenceRangeRead>;
  readonly idFactory?: EvidenceIdFactory;
};

export type ValidateEvidenceInput = ValidateEvidenceBaseInput &
  EvidencePacketSelection;

type EvidencePacketSelection =
  | {
      readonly packet: EvidencePacket;
      readonly packets?: never;
    }
  | {
      readonly packet?: never;
      readonly packets: readonly EvidencePacket[];
    };

export type SerializeIssuedEvidenceInput = EvidencePacketSelection & {
  readonly expectedRunId: string;
  readonly expectedGeneration: string;
  readonly expectedSnapshotDigest: string;
};

export type SerializedIssuedEvidence = {
  readonly version: 1;
  readonly runId: string;
  readonly generation: string;
  readonly snapshotDigest: string;
  readonly packetIds: readonly string[];
  readonly evidence: readonly ProjectEvidenceReference[];
};

export type EvidenceRangeRead = {
  readonly excerpt: string;
  readonly fileHash: string;
};

export type EvidenceSupportAuditResult = {
  readonly reviewStatus: "evidence_reviewed" | "unsupported";
  readonly supportReview: EvidenceSupportReview;
  readonly unsupportedClaimIds: readonly string[];
};

const defaultIdFactory: EvidenceIdFactory = (scope) => `${scope}-${randomUUID()}`;
const MAX_EVIDENCE_SOURCES = 64;
const MAX_EVIDENCE_EXCERPT_LINES = 200;
const MAX_EVIDENCE_EXCERPT_BYTES = 64 * 1024;
const MAX_EVIDENCE_PACKET_BYTES = 512 * 1024;
const MAX_EVIDENCE_CHAIN_SOURCES = 64;
const MAX_EVIDENCE_CHAIN_BYTES = 512 * 1024;
export const MAX_EVIDENCE_EXPANSION_REQUESTS = 2;
const MAX_EVIDENCE_PACKETS_PER_RUN = 1 + MAX_EVIDENCE_EXPANSION_REQUESTS;
const UTF8_ENCODER = new TextEncoder();

type IssuedEvidenceBinding = {
  readonly id: string;
  readonly kind: ProjectEvidenceKind;
  readonly sourceLocationKey: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly excerpt: string;
  readonly excerptHash: string;
  readonly fileHash: string;
  readonly snapshotDigest: string;
  readonly heading?: string;
};

type IssuedPacketBinding = {
  readonly packetId: string;
  readonly runId: string;
  readonly generation: string;
  readonly snapshotDigest: string;
  readonly evidenceById: ReadonlyMap<string, IssuedEvidenceBinding>;
};

const issuedPackets = new WeakMap<EvidencePacket, IssuedPacketBinding>();
type AuthorityPropertyBinding = {
  readonly key: string;
  readonly value: unknown;
  readonly enumerable: boolean;
  readonly configurable: boolean;
  readonly writable: boolean;
};

type AuthorityNodeBinding = {
  readonly node: object;
  readonly prototype: object | null;
  readonly properties: readonly AuthorityPropertyBinding[];
};

type ValidatedAnswerBinding = {
  readonly expectedDigest: string;
  readonly auditAnswer: EvidenceAnswer;
  readonly nodes: readonly AuthorityNodeBinding[];
};

const validatedAnswers = new WeakMap<EvidenceAnswer, ValidatedAnswerBinding>();

function cloneAuthorityData(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== "object" || depth > 64 || seen.has(value)) {
    throw new TypeError("Validated evidence answer authority is invalid");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 1_024) {
        throw new TypeError("Validated evidence answer authority is invalid");
      }
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError("Validated evidence answer authority is invalid");
        }
        result.push(cloneAuthorityData(descriptor.value, seen, depth + 1));
      }
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => key !== "length" && (
        typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length
      ))) {
        throw new TypeError("Validated evidence answer authority is invalid");
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Validated evidence answer authority is invalid");
    }
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError("Validated evidence answer authority is invalid");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("Validated evidence answer authority is invalid");
      }
      result[key] = cloneAuthorityData(descriptor.value, seen, depth + 1);
    }
    return result;
  } catch (error) {
    if (error instanceof TypeError && error.message === "Validated evidence answer authority is invalid") {
      throw error;
    }
    throw new TypeError("Validated evidence answer authority is invalid");
  } finally {
    seen.delete(value);
  }
}

function captureAuthorityGraph(value: object): readonly AuthorityNodeBinding[] {
  const nodes: AuthorityNodeBinding[] = [];
  const seen = new Set<object>();
  const capture = (node: object, depth: number): void => {
    if (depth > 64 || seen.has(node)) {
      throw new TypeError("Validated evidence answer authority is invalid");
    }
    seen.add(node);
    let prototype: object | null;
    let keys: PropertyKey[];
    try {
      prototype = Object.getPrototypeOf(node) as object | null;
      keys = Reflect.ownKeys(node);
    } catch {
      throw new TypeError("Validated evidence answer authority is invalid");
    }
    const properties: AuthorityPropertyBinding[] = [];
    for (const key of keys) {
      if (typeof key !== "string") {
        throw new TypeError("Validated evidence answer authority is invalid");
      }
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(node, key);
      } catch {
        throw new TypeError("Validated evidence answer authority is invalid");
      }
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("Validated evidence answer authority is invalid");
      }
      properties.push({
        key,
        value: descriptor.value,
        enumerable: descriptor.enumerable ?? false,
        configurable: descriptor.configurable ?? false,
        writable: descriptor.writable ?? false,
      });
      if (typeof descriptor.value === "object" && descriptor.value !== null) {
        capture(descriptor.value, depth + 1);
      }
    }
    nodes.push({ node, prototype, properties });
  };
  capture(value, 0);
  return nodes;
}

function freezeAuthorityData<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freezeAuthorityData(item);
  return Object.freeze(value);
}

function authorityGraphMatches(nodes: readonly AuthorityNodeBinding[]): boolean {
  try {
    for (const binding of nodes) {
      if (Object.getPrototypeOf(binding.node) !== binding.prototype) return false;
      const keys = Reflect.ownKeys(binding.node);
      if (
        keys.length !== binding.properties.length ||
        keys.some((key, index) => key !== binding.properties[index]?.key)
      ) {
        return false;
      }
      for (const expected of binding.properties) {
        const descriptor = Object.getOwnPropertyDescriptor(binding.node, expected.key);
        if (
          !descriptor ||
          !("value" in descriptor) ||
          !Object.is(descriptor.value, expected.value) ||
          (descriptor.enumerable ?? false) !== expected.enumerable ||
          (descriptor.configurable ?? false) !== expected.configurable ||
          (descriptor.writable ?? false) !== expected.writable
        ) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses the model's strict answer-or-request union and enforces the service
 * retry budget. Evidence requests contain search intent only; raw locators are
 * rejected by ModelQuestionOutputSchema.
 */
export function validateEvidenceQuestionOutput(
  rawOutput: unknown,
  expansionRequestsUsed: number,
): ModelQuestionOutput {
  if (
    !Number.isSafeInteger(expansionRequestsUsed) ||
    expansionRequestsUsed < 0 ||
    expansionRequestsUsed > MAX_EVIDENCE_EXPANSION_REQUESTS
  ) {
    throw new RangeError("Evidence expansion budget counter is invalid");
  }
  const output = ModelQuestionOutputSchema.parse(rawOutput);
  if (
    output.kind === "evidence_request" &&
    expansionRequestsUsed >= MAX_EVIDENCE_EXPANSION_REQUESTS
  ) {
    throw new RangeError("Evidence expansion request limit of two has been reached");
  }
  return output;
}

function canonicalRelativePath(value: string): string {
  if (
    value.includes(":" ) ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)
  ) {
    throw new TypeError("Evidence path must be relative to the bound workspace root");
  }

  const segments: string[] = [];
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new TypeError("Evidence path traversal is not allowed");
    }
    segments.push(segment);
  }
  return RelativePathSchema.parse(segments.join("/"));
}

type LineSpan = { readonly start: number; readonly end: number };

function lineSpans(content: string): readonly LineSpan[] {
  const spans: LineSpan[] = [];
  let start = 0;
  const newline = /\r\n|\n|\r/g;
  for (let match = newline.exec(content); match; match = newline.exec(content)) {
    spans.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  if (start < content.length) {
    spans.push({ start, end: content.length });
  }
  return spans;
}

function validateExcerptRange(excerpt: string, startLine: number, endLine: number): string {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < 1) {
    throw new RangeError("Evidence line range must use positive 1-based integers");
  }
  if (endLine < startLine) {
    throw new RangeError("Evidence line range end must not precede its start");
  }

  const lineCount = lineSpans(excerpt).length;
  if (lineCount > MAX_EVIDENCE_EXCERPT_LINES) {
    throw new RangeError("Evidence excerpt exceeds the line limit");
  }
  if (lineCount !== endLine - startLine + 1) {
    throw new RangeError("Evidence excerpt line count does not match its absolute range");
  }
  return excerpt;
}

function packetPayload(packet: Omit<EvidencePacket, "integrityDigest">): unknown {
  return {
    version: 1,
    packetId: packet.packetId,
    runId: packet.runId,
    generation: packet.generation,
    snapshotDigest: packet.snapshotDigest,
    evidence: packet.evidence,
  };
}

type ValidatedPacket = {
  readonly packet: EvidencePacket;
  readonly issuance: IssuedPacketBinding;
};

function validatePacket(packet: EvidencePacket): ValidatedPacket {
  const integrityDigest = Sha256DigestSchema.parse(packet.integrityDigest);
  if (
    digestCanonicalJson(
      packetPayload({
        packetId: packet.packetId,
        runId: packet.runId,
        generation: packet.generation,
        snapshotDigest: packet.snapshotDigest,
        evidence: packet.evidence,
      }),
    ) !== integrityDigest
  ) {
    throw new TypeError("Evidence packet integrity check failed");
  }

  const packetId = OpaqueIdSchema.parse(packet.packetId);
  const runId = OpaqueIdSchema.parse(packet.runId);
  const generation = OpaqueIdSchema.parse(packet.generation);
  const snapshotDigest = Sha256DigestSchema.parse(packet.snapshotDigest);
  const evidence = packet.evidence.map((record) => {
    const parsed = EvidenceReferenceSchema.parse(record);
    if (parsed.kind === "task_decision" || parsed.kind === "inference") {
      throw new TypeError("Workspace evidence packets may contain only project excerpts");
    }
    if (sha256Text(parsed.excerpt) !== parsed.excerptHash) {
      throw new TypeError("Evidence excerpt hash does not match its exact excerpt");
    }
    if (
      parsed.provenance.packetId !== packetId ||
      parsed.provenance.runId !== runId ||
      parsed.provenance.generation !== generation ||
      parsed.snapshotDigest !== snapshotDigest
    ) {
      throw new TypeError("Evidence provenance does not match its packet binding");
    }
    return parsed;
  });
  const ids = evidence.map((record) => record.id);
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("Evidence packet ids must be unique");
  }
  if (
    ids.includes(packetId) ||
    packetId === runId ||
    packetId === generation ||
    ids.includes(runId) ||
    ids.includes(generation)
  ) {
    throw new TypeError("Evidence packet, run, generation, and evidence ids must be distinct");
  }

  const parsedPacket = { packetId, runId, generation, snapshotDigest, evidence };
  const issuance = issuedPackets.get(packet);
  if (
    !issuance ||
    issuance.packetId !== packetId ||
    issuance.runId !== runId ||
    issuance.generation !== generation ||
    issuance.snapshotDigest !== snapshotDigest ||
    issuance.evidenceById.size !== evidence.length
  ) {
    throw new TypeError("Evidence packet was not issued by the trusted workspace broker");
  }
  for (const record of evidence) {
    const bound = issuance.evidenceById.get(record.id);
    const heading = record.kind === "project_document" ? record.heading : undefined;
    if (
      !bound ||
      bound.kind !== record.kind ||
      bound.path !== record.path ||
      bound.startLine !== record.startLine ||
      bound.endLine !== record.endLine ||
      bound.excerpt !== record.excerpt ||
      bound.excerptHash !== record.excerptHash ||
      bound.fileHash !== record.fileHash ||
      bound.snapshotDigest !== record.snapshotDigest ||
      bound.heading !== heading
    ) {
      throw new TypeError("Evidence packet was not issued by the trusted workspace broker");
    }
  }

  return {
    packet: { ...parsedPacket, integrityDigest },
    issuance,
  };
}

export function issueEvidencePacket(
  input: IssueEvidencePacketInput,
  options: IssueEvidencePacketOptions = {},
): EvidencePacket {
  if (input.sources.length > MAX_EVIDENCE_SOURCES) {
    throw new TypeError("Evidence source count exceeds the packet limit");
  }
  let totalSourceBytes = 0;
  const pathByPhysicalLocation = new Map<string, string>();
  const physicalLocationByPath = new Map<string, string>();
  for (const source of input.sources) {
    const sourceBytes = UTF8_ENCODER.encode(source.excerpt).byteLength;
    if (sourceBytes > MAX_EVIDENCE_EXCERPT_BYTES) {
      throw new TypeError("Evidence source bytes exceed the per-excerpt limit");
    }
    totalSourceBytes += sourceBytes;
    if (totalSourceBytes > MAX_EVIDENCE_PACKET_BYTES) {
      throw new TypeError("Evidence source bytes exceed the packet limit");
    }
    if (
      typeof source.sourceLocationKey !== "string" ||
      source.sourceLocationKey.length === 0 ||
      source.sourceLocationKey.length > 160 ||
      /[\u0000-\u001f\u007f]/.test(source.sourceLocationKey)
    ) throw new TypeError("Evidence physical source identity is invalid");
    const path = canonicalRelativePath(source.path);
    const existingPath = pathByPhysicalLocation.get(source.sourceLocationKey);
    if (existingPath !== undefined && existingPath !== path) {
      throw new TypeError("Evidence aliases cannot represent one physical source as distinct paths");
    }
    const existingPhysicalLocation = physicalLocationByPath.get(path);
    if (
      existingPhysicalLocation !== undefined &&
      existingPhysicalLocation !== source.sourceLocationKey
    ) {
      throw new TypeError("One evidence path cannot represent distinct physical sources");
    }
    pathByPhysicalLocation.set(source.sourceLocationKey, path);
    physicalLocationByPath.set(path, source.sourceLocationKey);
  }
  const idFactory = options.idFactory ?? defaultIdFactory;
  const packetId = OpaqueIdSchema.parse(idFactory("packet", 0));
  const runId = OpaqueIdSchema.parse(input.runId);
  const generation = OpaqueIdSchema.parse(input.generation);
  if (runId === generation) {
    throw new TypeError("Run and generation ids must be distinct");
  }
  const snapshotDigest = Sha256DigestSchema.parse(input.snapshotDigest);
  assertSnapshotRegistration(snapshotDigest);
  const evidence = input.sources.map((source, index): ProjectEvidenceReference => {
    const path = canonicalRelativePath(source.path);
    const excerpt = validateExcerptRange(source.excerpt, source.startLine, source.endLine);
    const fileHash = Sha256DigestSchema.parse(source.fileHash);
    assertSnapshotEvidenceBinding(snapshotDigest, path, fileHash);
    const common = {
      id: OpaqueIdSchema.parse(idFactory("evidence", index)),
      path,
      startLine: source.startLine,
      endLine: source.endLine,
      excerpt,
      excerptHash: sha256Text(excerpt),
      fileHash,
      snapshotDigest,
      provenance: {
        issuer: "workspace_service" as const,
        packetId,
        runId,
        generation,
      },
    };
    const raw = source.kind === "project_document" && source.heading !== undefined
      ? { ...common, kind: source.kind, heading: source.heading }
      : { ...common, kind: source.kind };
    const parsed = EvidenceReferenceSchema.parse(raw);
    if (parsed.kind === "task_decision" || parsed.kind === "inference") {
      throw new TypeError("Unexpected non-project evidence record");
    }
    return parsed;
  });

  const issuedIds = evidence.map((record) => record.id);
  if (
    new Set(issuedIds).size !== issuedIds.length ||
    issuedIds.includes(packetId) ||
    issuedIds.includes(runId) ||
    issuedIds.includes(generation) ||
    packetId === runId ||
    packetId === generation
  ) {
    throw new TypeError(
      "Injected packet, run, generation, and evidence ids must be unique and distinct",
    );
  }
  const packet = { packetId, runId, generation, snapshotDigest, evidence };
  const issuedPacket: EvidencePacket = {
    ...packet,
    integrityDigest: digestCanonicalJson(packetPayload(packet)),
  };
  issuedPackets.set(issuedPacket, {
    packetId,
    runId,
    generation,
    snapshotDigest,
    evidenceById: new Map(
      evidence.map((record, index) => {
        const source = input.sources[index]!;
        const heading = record.kind === "project_document" ? record.heading : undefined;
        return [
          record.id,
          {
            id: record.id,
            kind: record.kind,
            sourceLocationKey: source.sourceLocationKey,
            path: record.path,
            startLine: record.startLine,
            endLine: record.endLine,
            excerpt: record.excerpt,
            excerptHash: record.excerptHash,
            fileHash: record.fileHash,
            snapshotDigest: record.snapshotDigest,
            ...(heading === undefined ? {} : { heading }),
          },
        ];
      }),
    ),
  });
  return issuedPacket;
}

function packetList(input: EvidencePacketSelection): readonly EvidencePacket[] {
  const raw = input as object;
  let packetDescriptor: PropertyDescriptor | undefined;
  let packetsDescriptor: PropertyDescriptor | undefined;
  try {
    packetDescriptor = Object.getOwnPropertyDescriptor(raw, "packet");
    packetsDescriptor = Object.getOwnPropertyDescriptor(raw, "packets");
  } catch {
    throw new TypeError("Evidence packet input must use own data properties");
  }
  const hasPacket = packetDescriptor !== undefined;
  const hasPackets = packetsDescriptor !== undefined;
  if (hasPacket === hasPackets) {
    throw new TypeError("Exactly one of packet or packets must be supplied");
  }
  const selectedDescriptor = hasPacket ? packetDescriptor : packetsDescriptor;
  if (!selectedDescriptor || !("value" in selectedDescriptor)) {
    throw new TypeError("Evidence packet input must use an own data property");
  }
  const selected = selectedDescriptor.value as unknown;
  if (hasPacket) {
    if (typeof selected !== "object" || selected === null || Array.isArray(selected)) {
      throw new TypeError("Evidence packet input is invalid");
    }
    return [selected as EvidencePacket];
  }
  if (!Array.isArray(selected)) {
    throw new TypeError("At least one evidence packet is required");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(selected, "length");
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value as unknown
    : undefined;
  if (!Number.isInteger(length) || (length as number) <= 0) {
    throw new TypeError("At least one evidence packet is required");
  }
  if ((length as number) > MAX_EVIDENCE_PACKETS_PER_RUN) {
    throw new TypeError("Evidence expansion packet limit exceeded");
  }
  const packets: EvidencePacket[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(selected, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("Evidence packet arrays must contain own data properties");
    }
    const packet = descriptor.value as unknown;
    if (typeof packet !== "object" || packet === null || Array.isArray(packet)) {
      throw new TypeError("Evidence packet input is invalid");
    }
    packets.push(packet as EvidencePacket);
  }
  return packets;
}

type ValidatedPacketSet = {
  readonly runId: string;
  readonly generation: string;
  readonly snapshotDigest: string;
  readonly packetIds: readonly string[];
  readonly evidence: readonly ProjectEvidenceReference[];
};

function validatePacketSet(
  rawPackets: readonly EvidencePacket[],
  expectedRunId: string,
  expectedGeneration: string,
): ValidatedPacketSet {
  const validated = rawPackets.map(validatePacket);
  const first = validated[0]!;
  const packetIds = new Set<string>();
  const evidenceIds = new Set<string>();
  const physicalToPath = new Map<string, string>();
  const pathToPhysical = new Map<string, string>();
  const evidence: ProjectEvidenceReference[] = [];
  let aggregateSourceBytes = 0;

  for (const { packet, issuance } of validated) {
    if (packet.runId !== expectedRunId) {
      throw new TypeError("Evidence packet was not issued for this run");
    }
    if (packet.generation !== expectedGeneration) {
      throw new TypeError("Evidence packet was not issued for this generation");
    }
    if (packet.snapshotDigest !== first.packet.snapshotDigest) {
      throw new TypeError("Evidence expansion packets must share one snapshot");
    }
    if (packetIds.has(packet.packetId)) {
      throw new TypeError("Packet ids must be unique across evidence expansions");
    }
    packetIds.add(packet.packetId);
    if (evidence.length + packet.evidence.length > MAX_EVIDENCE_CHAIN_SOURCES) {
      throw new TypeError("Evidence source count exceeds the expansion-chain aggregate limit");
    }

    for (const record of packet.evidence) {
      aggregateSourceBytes += UTF8_ENCODER.encode(record.excerpt).byteLength;
      if (aggregateSourceBytes > MAX_EVIDENCE_CHAIN_BYTES) {
        throw new TypeError("Evidence source bytes exceed the expansion-chain aggregate limit");
      }
      if (evidenceIds.has(record.id)) {
        throw new TypeError("Evidence ids must be unique across expansion packets");
      }
      evidenceIds.add(record.id);
      const bound = issuance.evidenceById.get(record.id)!;
      const existingPath = physicalToPath.get(bound.sourceLocationKey);
      if (existingPath !== undefined && existingPath !== bound.path) {
        throw new TypeError(
          "Physical-source aliases cannot satisfy distinct-path evidence rules",
        );
      }
      const existingPhysical = pathToPhysical.get(bound.path);
      if (
        existingPhysical !== undefined &&
        existingPhysical !== bound.sourceLocationKey
      ) {
        throw new TypeError(
          "One evidence path cannot represent distinct physical sources across packets",
        );
      }
      physicalToPath.set(bound.sourceLocationKey, bound.path);
      pathToPhysical.set(bound.path, bound.sourceLocationKey);
      evidence.push(record);
    }
  }

  for (const packetId of packetIds) {
    if (
      evidenceIds.has(packetId) ||
      packetId === expectedRunId ||
      packetId === expectedGeneration
    ) {
      throw new TypeError("Packet ids must be distinct from run, generation, and evidence ids");
    }
  }
  if (evidenceIds.has(expectedRunId) || evidenceIds.has(expectedGeneration)) {
    throw new TypeError("Evidence ids must be distinct from run and generation ids");
  }

  return {
    runId: expectedRunId,
    generation: expectedGeneration,
    snapshotDigest: first.packet.snapshotDigest,
    packetIds: [...packetIds],
    evidence,
  };
}

/**
 * Authenticates live, process-issued packet objects and emits the bounded DTO
 * that may cross into an untrusted model prompt. JSON-round-tripped packets do
 * not retain the WeakMap issuance authority and are rejected.
 */
export function serializeIssuedEvidenceForModel(
  input: SerializeIssuedEvidenceInput,
): SerializedIssuedEvidence {
  const expectedRunId = OpaqueIdSchema.parse(input.expectedRunId);
  const expectedGeneration = OpaqueIdSchema.parse(input.expectedGeneration);
  const expectedSnapshotDigest = Sha256DigestSchema.parse(input.expectedSnapshotDigest);
  assertSnapshotRegistration(expectedSnapshotDigest);
  const packetSet = validatePacketSet(
    packetList(input),
    expectedRunId,
    expectedGeneration,
  );
  if (packetSet.snapshotDigest !== expectedSnapshotDigest) {
    throw new TypeError("Evidence packet snapshot does not match the expected snapshot");
  }

  const evidence = packetSet.evidence.map((record) => Object.freeze({
    ...record,
    provenance: Object.freeze({ ...record.provenance }),
  })) as readonly ProjectEvidenceReference[];
  return Object.freeze({
    version: 1 as const,
    runId: packetSet.runId,
    generation: packetSet.generation,
    snapshotDigest: packetSet.snapshotDigest,
    packetIds: Object.freeze([...packetSet.packetIds]),
    evidence: Object.freeze(evidence),
  });
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function baseReviewStatus(candidate: ModelAnswerCandidate): AnswerReviewStatus {
  if (candidate.unknowns.some((unknown) => unknown.code === "evidence_conflict")) return "conflict";
  if (candidate.unknowns.some((unknown) => unknown.code === "stale_snapshot")) return "stale";
  if (candidate.unknowns.length > 0) return "unsupported";
  return "citation_validated";
}

/**
 * Validates workspace-issued project evidence only. Task-decision and inference
 * evidence are intentionally assembled later by the side-context service.
 */
export async function validateEvidence(
  input: ValidateEvidenceInput,
): Promise<EvidenceAnswer> {
  const candidate = ModelAnswerCandidateSchema.parse(input.candidate);
  const expectedRunId = OpaqueIdSchema.parse(input.expectedRunId);
  const expectedGeneration = OpaqueIdSchema.parse(input.expectedGeneration);
  const packetSet = validatePacketSet(
    packetList(input),
    expectedRunId,
    expectedGeneration,
  );
  const currentSnapshotDigest = Sha256DigestSchema.parse(input.currentSnapshotDigest);
  assertSnapshotRegistration(currentSnapshotDigest);
  const contextMode = ContextModeSchema.parse(input.contextMode);

  const issuedById = new Map(packetSet.evidence.map((record) => [record.id, record]));
  const requestedIds = new Set<string>();
  for (const claim of candidate.claims) {
    for (const evidenceId of claim.evidenceIds) requestedIds.add(evidenceId);
  }
  for (const unknown of candidate.unknowns) {
    for (const evidenceId of unknown.evidenceIds) requestedIds.add(evidenceId);
  }
  for (const evidenceId of requestedIds) {
    if (!issuedById.has(evidenceId)) {
      throw new TypeError(`Evidence id ${evidenceId} was not issued for this run`);
    }
  }
  const claimEvidenceById = new Map(
    candidate.claims.map((claim) => [claim.id, new Set(claim.evidenceIds)]),
  );
  for (const unknown of candidate.unknowns) {
    const namedClaimEvidence = new Set(
      unknown.claimIds.flatMap((claimId) => [
        ...(claimEvidenceById.get(claimId) ?? []),
      ]),
    );
    for (const evidenceId of unknown.evidenceIds) {
      if (!namedClaimEvidence.has(evidenceId)) {
        throw new TypeError(
          "Unknown evidence must be cited by its named claims before validation",
        );
      }
    }
  }
  const selectedEvidence = packetSet.evidence.filter((record) => requestedIds.has(record.id));

  const staleIds = new Set<string>();
  if (packetSet.snapshotDigest !== currentSnapshotDigest) {
    if (selectedEvidence.length === 0) {
      throw new TypeError("Evidence snapshot changed before answer validation");
    }
    for (const evidence of selectedEvidence) staleIds.add(evidence.id);
  } else {
    await Promise.all(
      selectedEvidence.map(async (evidence) => {
        let current: EvidenceRangeRead;
        try {
          current = await input.readEvidence(evidence.path, evidence.startLine, evidence.endLine);
        } catch {
          staleIds.add(evidence.id);
          return;
        }
        const currentHash = Sha256DigestSchema.safeParse(current.fileHash);
        if (!currentHash.success || typeof current.excerpt !== "string") {
          staleIds.add(evidence.id);
          return;
        }
        if (
          currentHash.data !== evidence.fileHash ||
          current.excerpt !== evidence.excerpt ||
          sha256Text(current.excerpt) !== evidence.excerptHash
        ) {
          staleIds.add(evidence.id);
        }
      }),
    );
  }

  const staleUnknowns = [];
  if (staleIds.size > 0) {
    if (candidate.unknowns.some((unknown) => unknown.code !== "stale_snapshot")) {
      throw new TypeError("Candidate uncertainty cannot be safely merged with stale evidence");
    }
    const affectedClaimIds = candidate.claims
      .filter((claim) => claim.evidenceIds.some((id) => staleIds.has(id)))
      .map((claim) => claim.id);
    if (affectedClaimIds.length === 0) {
      throw new TypeError("Stale evidence must be associated with at least one claim");
    }
    const unknownId = OpaqueIdSchema.parse((input.idFactory ?? defaultIdFactory)("unknown", 0));
    staleUnknowns.push({
      id: unknownId,
      code: "stale_snapshot" as const,
      statement: "The workspace snapshot or cited file changed after evidence issuance.",
      claimIds: affectedClaimIds,
      evidenceIds: selectedEvidence
        .filter((record) => staleIds.has(record.id))
        .map((record) => record.id),
    });
  }

  const reviewStatus = staleIds.size > 0 ? "stale" : baseReviewStatus(candidate);
  const documentPath = input.documentPath === undefined
    ? undefined
    : canonicalRelativePath(input.documentPath);
  const answer = {
    ...candidate,
    runId: packetSet.runId,
    generation: packetSet.generation,
    candidateDigest: digestCanonicalJson(candidate),
    reviewStatus,
    contextMode,
    ...(documentPath === undefined ? {} : { documentPath }),
    evidence: selectedEvidence,
    unknowns: staleIds.size > 0 ? staleUnknowns : candidate.unknowns,
    snapshotDigest: packetSet.snapshotDigest,
  };
  const validated = EvidenceAnswerSchema.parse(answer);
  const expectedDigest = digestCanonicalJson(validated);
  const nodes = captureAuthorityGraph(validated);
  const auditAnswer = freezeAuthorityData(
    EvidenceAnswerSchema.parse(cloneAuthorityData(validated)),
  );
  validatedAnswers.set(validated, { expectedDigest, auditAnswer, nodes });
  return validated;
}

/**
 * Authenticates the exact live object returned by validateEvidence and returns
 * a detached data-only copy for the independent audit prompt. JSON copies and
 * post-validation mutation do not retain this process-local authority.
 */
export function authenticateValidatedEvidenceAnswerForAudit(
  rawAnswer: EvidenceAnswer,
): EvidenceAnswer {
  if (typeof rawAnswer !== "object" || rawAnswer === null || Array.isArray(rawAnswer)) {
    throw new TypeError("Validated evidence answer authority is missing");
  }
  const binding = validatedAnswers.get(rawAnswer);
  if (!binding) {
    throw new TypeError("Validated evidence answer authority is missing");
  }
  if (
    !authorityGraphMatches(binding.nodes) ||
    digestCanonicalJson(binding.auditAnswer) !== binding.expectedDigest
  ) {
    throw new TypeError("Validated evidence answer authority was mutated");
  }
  return binding.auditAnswer;
}

/**
 * Validates a structured result produced by separately orchestrated review.
 * This function does not call a model and cannot prove reviewer independence or
 * semantic entailment; it proves only exact candidate/evidence correspondence
 * and maps verdicts to an honest machine status.
 */
export function validateEvidenceSupportAudit(
  rawAnswer: EvidenceAnswer,
  rawReview: EvidenceSupportReview,
): EvidenceSupportAuditResult {
  const answer = EvidenceAnswerSchema.parse(rawAnswer);
  const supportReview = EvidenceSupportReviewSchema.parse(rawReview);

  if (answer.reviewStatus !== "citation_validated") {
    throw new TypeError("Only a citation-validated answer can receive an evidence support audit");
  }

  if (
    supportReview.runId !== answer.runId ||
    supportReview.generation !== answer.generation ||
    supportReview.candidateDigest !== answer.candidateDigest ||
    supportReview.snapshotDigest !== answer.snapshotDigest
  ) {
    throw new TypeError("Evidence audit does not bind the answer candidate and run");
  }
  if (supportReview.records.length !== answer.claims.length) {
    throw new TypeError("Evidence audit must review every claim exactly once");
  }

  const recordByClaim = new Map(supportReview.records.map((record) => [record.claimId, record]));
  for (const claim of answer.claims) {
    const record = recordByClaim.get(claim.id);
    if (!record) {
      throw new TypeError(`Evidence audit is missing claim ${claim.id}`);
    }
    if (!sameStringSet(record.evidenceIds, claim.evidenceIds)) {
      throw new TypeError("Evidence audit must use exactly the claim's cited evidence");
    }
  }
  for (const record of supportReview.records) {
    if (!answer.claims.some((claim) => claim.id === record.claimId)) {
      throw new TypeError(`Evidence audit added unknown claim ${record.claimId}`);
    }
  }

  const unsupportedClaimIds = supportReview.records
    .filter((record) => record.verdict !== "directly_supported")
    .map((record) => record.claimId);
  return {
    reviewStatus: unsupportedClaimIds.length === 0 ? "evidence_reviewed" : "unsupported",
    supportReview,
    unsupportedClaimIds,
  };
}
