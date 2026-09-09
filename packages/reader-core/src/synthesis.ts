import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";

import {
  DispositionSchema,
  EditIntentBatchSchema,
  OpaqueIdSchema,
  RelativePathSchema,
  Sha256DigestSchema,
  SourceAnchorSchema,
  type Disposition,
  type EditIntent,
  type EditIntentBatch,
  type SourceAnchor,
} from "@aimd/contracts";

const MAX_SYNTHESIS_ANNOTATIONS = 256;
const MAX_SAFE_ARRAY_LENGTH = 512;
const MAX_SAFE_OBJECT_KEYS = 128;
const MAX_SAFE_NODES = 16_384;
const MAX_SAFE_DEPTH = 64;
const MAX_SAFE_STRING_BYTES = 2 * 1024 * 1024;

export type TrustedSynthesisAnnotation = {
  annotationId: string;
  selected: boolean;
  disposition: Disposition;
  anchor: SourceAnchor;
  evidenceIds: readonly string[];
};

export type SynthesisValidationInput = {
  acceptedAnnotations: readonly TrustedSynthesisAnnotation[];
  currentDocumentPath: string;
  currentDocumentHash: string;
};

export type SynthesisValidationErrorCode =
  | "INVALID_TRUSTED_INPUT"
  | "INVALID_MODEL_OUTPUT"
  | "NO_ELIGIBLE_ANNOTATIONS"
  | "ANNOTATION_COVERAGE_MISMATCH"
  | "SOURCE_ANCHOR_MISMATCH"
  | "EVIDENCE_AUTHORITY_MISMATCH"
  | "DISPOSITION_OPERATION_MISMATCH"
  | "OVERLAPPING_INTENTS";

const ERROR_MESSAGES: Readonly<Record<SynthesisValidationErrorCode, string>> = Object.freeze({
  INVALID_TRUSTED_INPUT: "The trusted synthesis input is invalid.",
  INVALID_MODEL_OUTPUT: "The structured edit batch is invalid.",
  NO_ELIGIBLE_ANNOTATIONS: "There are no selected editable annotations.",
  ANNOTATION_COVERAGE_MISMATCH:
    "Synthesis output must cover the exact selected annotation set.",
  SOURCE_ANCHOR_MISMATCH: "Synthesis output changed an accepted source anchor.",
  EVIDENCE_AUTHORITY_MISMATCH:
    "Synthesis output cited evidence outside its accepted annotation.",
  DISPOSITION_OPERATION_MISMATCH:
    "The synthesis operation does not match the accepted disposition.",
  OVERLAPPING_INTENTS: "Overlapping synthesis intents conflict.",
});

export class SynthesisValidationError extends Error {
  readonly code: SynthesisValidationErrorCode;

  constructor(code: SynthesisValidationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SynthesisValidationError";
    this.code = code;
  }
}

type CloneBudget = {
  nodes: number;
  stringBytes: number;
};

function clonePlainData(
  value: unknown,
  budget: CloneBudget,
  ancestors = new Set<object>(),
  depth = 0,
): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Unsafe synthesis data");
    return value;
  }
  if (typeof value === "string") {
    budget.stringBytes += Buffer.byteLength(value, "utf8");
    if (budget.stringBytes > MAX_SAFE_STRING_BYTES) throw new TypeError("Unsafe synthesis data");
    return value;
  }
  if (typeof value !== "object" || depth > MAX_SAFE_DEPTH || utilTypes.isProxy(value)) {
    throw new TypeError("Unsafe synthesis data");
  }
  if (ancestors.has(value)) throw new TypeError("Unsafe synthesis data");
  budget.nodes += 1;
  if (budget.nodes > MAX_SAFE_NODES) throw new TypeError("Unsafe synthesis data");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor?.value;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_SAFE_ARRAY_LENGTH
      ) {
        throw new TypeError("Unsafe synthesis data");
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== length + 1 ||
        keys.some((key) => key !== "length" && (
          typeof key !== "string" ||
          !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= length
        ))
      ) {
        throw new TypeError("Unsafe synthesis data");
      }
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new TypeError("Unsafe synthesis data");
        }
        result.push(clonePlainData(descriptor.value, budget, ancestors, depth + 1));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Unsafe synthesis data");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > MAX_SAFE_OBJECT_KEYS ||
      keys.some((key) => typeof key !== "string")
    ) {
      throw new TypeError("Unsafe synthesis data");
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("Unsafe synthesis data");
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: clonePlainData(descriptor.value, budget, ancestors, depth + 1),
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function safeClone(value: unknown): unknown {
  try {
    return clonePlainData(value, { nodes: 0, stringBytes: 0 });
  } catch {
    throw new TypeError("Unsafe synthesis data");
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected record");
  }
  return value as Record<string, unknown>;
}

function parseStringIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SYNTHESIS_ANNOTATIONS) {
    throw new TypeError("Expected bounded ids");
  }
  const ids = value.map((item) => OpaqueIdSchema.parse(item));
  if (new Set(ids).size !== ids.length) throw new TypeError("Expected unique ids");
  return ids;
}

function parseTrustedInput(rawInput: unknown): SynthesisValidationInput {
  try {
    const input = asRecord(safeClone(rawInput));
    if (
      !exactKeys(input, [
        "acceptedAnnotations",
        "currentDocumentPath",
        "currentDocumentHash",
      ])
    ) {
      throw new TypeError("Unexpected trusted input");
    }
    const currentDocumentPath = RelativePathSchema.parse(input.currentDocumentPath);
    const currentDocumentHash = Sha256DigestSchema.parse(input.currentDocumentHash);
    if (
      !Array.isArray(input.acceptedAnnotations) ||
      input.acceptedAnnotations.length === 0 ||
      input.acceptedAnnotations.length > MAX_SYNTHESIS_ANNOTATIONS
    ) {
      throw new TypeError("Expected annotations");
    }
    const acceptedAnnotations = input.acceptedAnnotations.map((rawAnnotation) => {
      const item = asRecord(rawAnnotation);
      if (
        !exactKeys(item, [
          "annotationId",
          "selected",
          "disposition",
          "anchor",
          "evidenceIds",
        ]) ||
        typeof item.selected !== "boolean"
      ) {
        throw new TypeError("Unexpected annotation");
      }
      return {
        annotationId: OpaqueIdSchema.parse(item.annotationId),
        selected: item.selected,
        disposition: DispositionSchema.parse(item.disposition),
        anchor: SourceAnchorSchema.parse(item.anchor),
        evidenceIds: parseStringIds(item.evidenceIds),
      } satisfies TrustedSynthesisAnnotation;
    });
    if (
      new Set(acceptedAnnotations.map(({ annotationId }) => annotationId)).size !==
      acceptedAnnotations.length
    ) {
      throw new TypeError("Duplicate trusted annotation");
    }
    for (const annotation of acceptedAnnotations) {
      if (
        annotation.selected &&
        annotation.disposition !== "reading_only" &&
        annotation.disposition !== "ignore" &&
        (
          annotation.anchor.documentPath !== currentDocumentPath ||
          annotation.anchor.documentHash !== currentDocumentHash
        )
      ) {
        throw new TypeError("Selected annotation does not bind current document");
      }
    }
    return {
      acceptedAnnotations,
      currentDocumentPath,
      currentDocumentHash,
    };
  } catch {
    throw new SynthesisValidationError("INVALID_TRUSTED_INPUT");
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameAnchor(left: SourceAnchor, right: SourceAnchor): boolean {
  return left.documentPath === right.documentPath &&
    left.documentHash === right.documentHash &&
    left.selectedText === right.selectedText &&
    left.prefix === right.prefix &&
    left.suffix === right.suffix &&
    left.startOffset === right.startOffset &&
    left.endOffset === right.endOffset &&
    sameStringArray(left.headingPath, right.headingPath);
}

function expectedOperation(disposition: Disposition): EditIntent["operation"] | null {
  if (disposition === "inline") return "insert_after";
  if (disposition === "replace") return "replace";
  if (disposition === "glossary" || disposition === "faq") return "append_section";
  return null;
}

function normalizeMarkdown(markdown: string): string {
  const lines = markdown
    .replace(/\r\n?|\n/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/u, ""));
  while (lines[0]?.length === 0) lines.shift();
  while (lines.at(-1)?.length === 0) lines.pop();
  return lines.join("\n");
}

function insertionPoint(intent: EditIntent): number | null {
  return intent.operation === "insert_after" ? intent.targetAnchor.endOffset : null;
}

function intentsOverlap(left: EditIntent, right: EditIntent): boolean {
  if (sameAnchor(left.targetAnchor, right.targetAnchor)) return true;
  if (left.operation === "append_section" && right.operation === "append_section") {
    return left.targetAnchor.documentPath === right.targetAnchor.documentPath &&
      sameStringArray(left.targetAnchor.headingPath, right.targetAnchor.headingPath);
  }
  if (left.operation === "replace" && right.operation === "replace") {
    return left.targetAnchor.startOffset < right.targetAnchor.endOffset &&
      right.targetAnchor.startOffset < left.targetAnchor.endOffset;
  }
  const leftPoint = insertionPoint(left);
  const rightPoint = insertionPoint(right);
  if (leftPoint !== null && rightPoint !== null) return leftPoint === rightPoint;
  if (leftPoint !== null && right.operation === "replace") {
    return leftPoint > right.targetAnchor.startOffset &&
      leftPoint < right.targetAnchor.endOffset;
  }
  if (rightPoint !== null && left.operation === "replace") {
    return rightPoint > left.targetAnchor.startOffset &&
      rightPoint < left.targetAnchor.endOffset;
  }
  return false;
}

function safeDuplicate(
  left: EditIntent,
  right: EditIntent,
  annotations: ReadonlyMap<string, TrustedSynthesisAnnotation>,
): boolean {
  const leftAnnotation = annotations.get(left.annotationId);
  const rightAnnotation = annotations.get(right.annotationId);
  return left.operation !== "replace" &&
    right.operation !== "replace" &&
    leftAnnotation !== undefined &&
    rightAnnotation !== undefined &&
    sameAnchor(left.targetAnchor, right.targetAnchor) &&
    leftAnnotation.disposition === rightAnnotation.disposition &&
    normalizeMarkdown(left.markdown) === normalizeMarkdown(right.markdown);
}

function freezeDeep<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) freezeDeep(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function copyBatch(batch: EditIntentBatch): EditIntentBatch {
  return {
    intents: batch.intents.map((intent) => ({
      annotationId: intent.annotationId,
      operation: intent.operation,
      targetAnchor: {
        documentPath: intent.targetAnchor.documentPath,
        documentHash: intent.targetAnchor.documentHash,
        headingPath: [...intent.targetAnchor.headingPath],
        selectedText: intent.targetAnchor.selectedText,
        prefix: intent.targetAnchor.prefix,
        suffix: intent.targetAnchor.suffix,
        startOffset: intent.targetAnchor.startOffset,
        endOffset: intent.targetAnchor.endOffset,
      },
      markdown: intent.markdown,
      rationale: intent.rationale,
      evidenceIds: [...intent.evidenceIds],
    })),
    conflicts: batch.conflicts.map((conflict) => ({
      annotationId: conflict.annotationId,
      reason: conflict.reason,
    })),
  };
}

export function validateSynthesisOutput(
  raw: unknown,
  rawTrustedInput: SynthesisValidationInput,
): EditIntentBatch {
  const trustedInput = parseTrustedInput(rawTrustedInput);
  const eligible = trustedInput.acceptedAnnotations.filter(
    (annotation) =>
      annotation.selected &&
      annotation.disposition !== "reading_only" &&
      annotation.disposition !== "ignore",
  );
  if (eligible.length === 0) {
    throw new SynthesisValidationError("NO_ELIGIBLE_ANNOTATIONS");
  }

  let batch: EditIntentBatch;
  try {
    batch = EditIntentBatchSchema.parse(safeClone(raw));
  } catch {
    throw new SynthesisValidationError("INVALID_MODEL_OUTPUT");
  }

  const expected = new Map(eligible.map((annotation) => [annotation.annotationId, annotation]));
  const outcomes = [
    ...batch.intents.map(({ annotationId }) => annotationId),
    ...batch.conflicts.map(({ annotationId }) => annotationId),
  ];
  if (
    outcomes.length !== expected.size ||
    outcomes.some((annotationId) => !expected.has(annotationId)) ||
    [...expected.keys()].some((annotationId) => !outcomes.includes(annotationId))
  ) {
    throw new SynthesisValidationError("ANNOTATION_COVERAGE_MISMATCH");
  }

  const result = copyBatch(batch);
  for (const intent of result.intents) {
    const annotation = expected.get(intent.annotationId);
    if (!annotation || !sameAnchor(intent.targetAnchor, annotation.anchor)) {
      throw new SynthesisValidationError("SOURCE_ANCHOR_MISMATCH");
    }
    if (intent.operation !== expectedOperation(annotation.disposition)) {
      throw new SynthesisValidationError("DISPOSITION_OPERATION_MISMATCH");
    }
    const evidenceIds = new Set(annotation.evidenceIds);
    if (intent.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))) {
      throw new SynthesisValidationError("EVIDENCE_AUTHORITY_MISMATCH");
    }
  }

  for (let leftIndex = 0; leftIndex < result.intents.length; leftIndex += 1) {
    const left = result.intents[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < result.intents.length; rightIndex += 1) {
      const right = result.intents[rightIndex];
      if (!right || !intentsOverlap(left, right)) continue;
      if (!safeDuplicate(left, right, expected)) {
        throw new SynthesisValidationError("OVERLAPPING_INTENTS");
      }
      right.markdown = left.markdown;
    }
  }

  return freezeDeep(result);
}
