import { Buffer } from "node:buffer";

import {
  EditIntentSchema,
  RelativePathSchema,
  type EditConflict,
  type EditIntent,
} from "@aimd/contracts";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { inspectMarkdownOutline, relocateSourceAnchor } from "./anchor.js";
import { sha256Text } from "./hash.js";

const MAX_EDIT_INTENTS = 256;
const MAX_PATCH_RESULT_BYTES = 2 * 1024 * 1024;
const DIFF_CONTEXT_LINES = 3;
const markdownParser = unified().use(remarkParse).use(remarkGfm);

export type PatchResult = Readonly<{
  markdown: string;
  unifiedDiff: string;
  sourceHash: string;
  resultHash: string;
  appliedAnnotationIds: string[];
  conflicts: EditConflict[];
}>;

export type MarkdownPatchErrorCode =
  | "INVALID_DOCUMENT_PATH"
  | "INVALID_EDIT_INTENT"
  | "DUPLICATE_ANNOTATION_ID"
  | "DOCUMENT_PATH_MISMATCH"
  | "MARKDOWN_COMPLEXITY_BUDGET"
  | "ANCHOR_MISSING"
  | "ANCHOR_AMBIGUOUS"
  | "ANCHOR_HEADING_MISMATCH"
  | "APPEND_SECTION_TARGET_INVALID"
  | "WHOLE_DOCUMENT_REWRITE"
  | "EDIT_CONFLICT";

const ERROR_MESSAGES: Readonly<Record<MarkdownPatchErrorCode, string>> = Object.freeze({
  INVALID_DOCUMENT_PATH: "The Markdown document path is invalid.",
  INVALID_EDIT_INTENT: "The edit intent is invalid.",
  DUPLICATE_ANNOTATION_ID: "Each annotation may provide only one edit intent.",
  DOCUMENT_PATH_MISMATCH: "Every edit intent must target the same Markdown document.",
  MARKDOWN_COMPLEXITY_BUDGET: "The Markdown exceeds the safe patch complexity budget.",
  ANCHOR_MISSING: "The source anchor is missing.",
  ANCHOR_AMBIGUOUS: "The source anchor is ambiguous.",
  ANCHOR_HEADING_MISMATCH: "The source anchor heading path does not match the document.",
  APPEND_SECTION_TARGET_INVALID:
    "The append-section target has no unique owning Markdown heading.",
  WHOLE_DOCUMENT_REWRITE: "A whole-document rewrite is not an accepted edit intent.",
  EDIT_CONFLICT: "The requested Markdown edits conflict.",
});

export class MarkdownPatchError extends Error {
  readonly code: MarkdownPatchErrorCode;
  readonly conflicts: EditConflict[];

  constructor(code: MarkdownPatchErrorCode, conflicts: EditConflict[] = []) {
    super(ERROR_MESSAGES[code]);
    this.name = "MarkdownPatchError";
    this.code = code;
    this.conflicts = conflicts.map((item) => ({ ...item }));
  }
}

type SourceEdit = {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly markdown: string;
  readonly annotationIds: readonly string[];
  readonly operation: EditIntent["operation"];
};

type Heading = {
  readonly depth: number;
  readonly path: readonly string[];
  readonly startOffset: number;
};

type DiffBlock = {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
};

function conflict(annotationId: string, reason: string): EditConflict {
  return { annotationId, reason };
}

function throwForAnnotations(
  code: MarkdownPatchErrorCode,
  annotationIds: readonly string[],
): never {
  throw new MarkdownPatchError(
    code,
    annotationIds.map((annotationId) => conflict(annotationId, ERROR_MESSAGES[code])),
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function owningHeadingIndex(headings: readonly Heading[], offset: number): number {
  let owner = -1;
  for (const [index, heading] of headings.entries()) {
    if (heading.startOffset > offset) break;
    owner = index;
  }
  return owner;
}

function appendSectionOffset(
  headings: readonly Heading[],
  ownerIndex: number,
  sourceLength: number,
): number {
  const owner = headings[ownerIndex];
  if (!owner) return -1;
  for (let index = ownerIndex + 1; index < headings.length; index += 1) {
    const candidate = headings[index];
    if (candidate && candidate.depth <= owner.depth) return candidate.startOffset;
  }
  return sourceLength;
}

function editsOverlap(left: SourceEdit, right: SourceEdit): boolean {
  const leftInsertion = left.startOffset === left.endOffset;
  const rightInsertion = right.startOffset === right.endOffset;
  if (leftInsertion && rightInsertion) return left.startOffset === right.startOffset;
  if (leftInsertion) {
    return left.startOffset > right.startOffset && left.startOffset < right.endOffset;
  }
  if (rightInsertion) {
    return right.startOffset > left.startOffset && right.startOffset < left.endOffset;
  }
  return left.startOffset < right.endOffset && right.startOffset < left.endOffset;
}

function mergeAndValidateEdits(edits: readonly SourceEdit[]): SourceEdit[] {
  const merged: SourceEdit[] = [];

  for (const edit of edits) {
    const identicalInsertion = merged.find(
      (candidate) =>
        candidate.startOffset === candidate.endOffset &&
        edit.startOffset === edit.endOffset &&
        candidate.startOffset === edit.startOffset &&
        candidate.markdown === edit.markdown,
    );
    if (identicalInsertion) {
      const index = merged.indexOf(identicalInsertion);
      merged[index] = {
        ...identicalInsertion,
        annotationIds: [...identicalInsertion.annotationIds, ...edit.annotationIds],
      };
      continue;
    }
    merged.push(edit);
  }

  const conflictingIds = new Set<string>();
  for (let leftIndex = 0; leftIndex < merged.length; leftIndex += 1) {
    const left = merged[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < merged.length; rightIndex += 1) {
      const right = merged[rightIndex];
      if (!right || !editsOverlap(left, right)) continue;
      for (const annotationId of left.annotationIds) conflictingIds.add(annotationId);
      for (const annotationId of right.annotationIds) conflictingIds.add(annotationId);
    }
  }

  if (conflictingIds.size > 0) {
    const orderedIds = edits
      .flatMap((edit) => edit.annotationIds)
      .filter((annotationId) => conflictingIds.has(annotationId));
    throwForAnnotations("EDIT_CONFLICT", orderedIds);
  }
  return merged;
}

function splitLines(text: string): { readonly lines: string[]; readonly finalNewline: boolean } {
  if (text.length === 0) return { lines: [], finalNewline: false };
  const finalNewline = /(?:\r\n|\n|\r)$/u.test(text);
  const lines = text.split(/\r\n|\n|\r/u);
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  const newline = /\r\n|\n|\r/gu;
  for (let match = newline.exec(text); match; match = newline.exec(text)) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

function lineAtOffset(starts: readonly number[], offset: number, lineCount: number): number {
  if (lineCount === 0) return 0;
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return Math.min(Math.max(high, 0), lineCount - 1);
}

function linePositionAtOffset(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(high, 0);
}

function isLineBoundary(starts: readonly number[], offset: number): boolean {
  const position = linePositionAtOffset(starts, offset);
  return starts[position] === offset;
}

function diffBlocks(
  source: string,
  result: string,
  edits: readonly SourceEdit[],
): DiffBlock[] {
  const oldSplit = splitLines(source);
  const newSplit = splitLines(result);
  const oldStarts = lineStarts(source);
  const newStarts = lineStarts(result);
  let delta = 0;
  const blocks: DiffBlock[] = [];

  for (const edit of [...edits].sort((left, right) => {
    if (left.startOffset !== right.startOffset) return left.startOffset - right.startOffset;
    return (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset);
  })) {
    const newStartOffset = edit.startOffset + delta;
    const newEndOffset = newStartOffset + edit.markdown.length;
    const lineAligned =
      isLineBoundary(oldStarts, edit.startOffset) &&
      isLineBoundary(oldStarts, edit.endOffset) &&
      (edit.markdown.length === 0 || /(?:\r\n|\n|\r)$/u.test(edit.markdown));
    const oldStart = lineAligned
      ? linePositionAtOffset(oldStarts, edit.startOffset)
      : lineAtOffset(oldStarts, edit.startOffset, oldSplit.lines.length);
    const oldEnd = lineAligned
      ? linePositionAtOffset(oldStarts, edit.endOffset)
      : Math.min(
        oldSplit.lines.length,
        lineAtOffset(
          oldStarts,
          edit.endOffset > edit.startOffset ? edit.endOffset - 1 : edit.startOffset,
          oldSplit.lines.length,
        ) + 1,
      );
    const newStart = lineAligned
      ? linePositionAtOffset(newStarts, newStartOffset)
      : lineAtOffset(newStarts, newStartOffset, newSplit.lines.length);
    const newEnd = lineAligned
      ? linePositionAtOffset(newStarts, newEndOffset)
      : Math.min(
        newSplit.lines.length,
        lineAtOffset(
          newStarts,
          newEndOffset > newStartOffset ? newEndOffset - 1 : newStartOffset,
          newSplit.lines.length,
        ) + 1,
      );
    blocks.push({
      oldStart,
      oldEnd,
      newStart,
      newEnd,
    });
    delta += edit.markdown.length - (edit.endOffset - edit.startOffset);
  }

  const merged: DiffBlock[] = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    if (
      previous &&
      (block.oldStart < previous.oldEnd || block.newStart < previous.newEnd)
    ) {
      previous.oldEnd = Math.max(previous.oldEnd, block.oldEnd);
      previous.newEnd = Math.max(previous.newEnd, block.newEnd);
    } else {
      merged.push({ ...block });
    }
  }
  return merged;
}

function appendDiffLine(
  output: string[],
  prefix: " " | "+" | "-",
  line: string,
  isLast: boolean,
  finalNewline: boolean,
): void {
  output.push(`${prefix}${line}`);
  if (isLast && !finalNewline) output.push("\\ No newline at end of file");
}

function createUnifiedDiff(
  documentPath: string,
  source: string,
  result: string,
  edits: readonly SourceEdit[],
): string {
  if (source === result) return "";
  const oldSplit = splitLines(source);
  const newSplit = splitLines(result);
  const output = [`--- a/${documentPath}`, `+++ b/${documentPath}`];

  const hunks: DiffBlock[][] = [];
  for (const block of diffBlocks(source, result, edits)) {
    const current = hunks.at(-1);
    const previous = current?.at(-1);
    if (
      current &&
      previous &&
      block.oldStart - previous.oldEnd <= DIFF_CONTEXT_LINES * 2 &&
      block.newStart - previous.newEnd <= DIFF_CONTEXT_LINES * 2
    ) {
      current.push(block);
    } else {
      hunks.push([block]);
    }
  }

  for (const hunk of hunks) {
    const first = hunk[0];
    const last = hunk.at(-1);
    if (!first || !last) continue;
    const prefixCount = Math.min(DIFF_CONTEXT_LINES, first.oldStart, first.newStart);
    const suffixCount = Math.min(
      DIFF_CONTEXT_LINES,
      oldSplit.lines.length - last.oldEnd,
      newSplit.lines.length - last.newEnd,
    );
    const oldStart = first.oldStart - prefixCount;
    const newStart = first.newStart - prefixCount;
    const oldEnd = last.oldEnd + suffixCount;
    const newEnd = last.newEnd + suffixCount;
    const oldCount = oldEnd - oldStart;
    const newCount = newEnd - newStart;
    const oldCoordinate = oldCount === 0 ? oldStart : oldStart + 1;
    const newCoordinate = newCount === 0 ? newStart : newStart + 1;
    output.push(`@@ -${oldCoordinate},${oldCount} +${newCoordinate},${newCount} @@`);
    for (let oldIndex = oldStart; oldIndex < first.oldStart; oldIndex += 1) {
      appendDiffLine(
        output,
        " ",
        oldSplit.lines[oldIndex] ?? "",
        oldIndex === oldSplit.lines.length - 1,
        oldSplit.finalNewline,
      );
    }
    let oldCursor = first.oldStart;
    let newCursor = first.newStart;
    for (const block of hunk) {
      const oldGap = block.oldStart - oldCursor;
      const newGap = block.newStart - newCursor;
      if (oldGap !== newGap || oldGap < 0) {
        throw new MarkdownPatchError("EDIT_CONFLICT");
      }
      for (let index = 0; index < oldGap; index += 1) {
        const oldIndex = oldCursor + index;
        appendDiffLine(
          output,
          " ",
          oldSplit.lines[oldIndex] ?? "",
          oldIndex === oldSplit.lines.length - 1,
          oldSplit.finalNewline,
        );
      }
      for (let oldIndex = block.oldStart; oldIndex < block.oldEnd; oldIndex += 1) {
        appendDiffLine(
          output,
          "-",
          oldSplit.lines[oldIndex] ?? "",
          oldIndex === oldSplit.lines.length - 1,
          oldSplit.finalNewline,
        );
      }
      for (let newIndex = block.newStart; newIndex < block.newEnd; newIndex += 1) {
        appendDiffLine(
          output,
          "+",
          newSplit.lines[newIndex] ?? "",
          newIndex === newSplit.lines.length - 1,
          newSplit.finalNewline,
        );
      }
      oldCursor = block.oldEnd;
      newCursor = block.newEnd;
    }
    for (let oldIndex = last.oldEnd; oldIndex < oldEnd; oldIndex += 1) {
      appendDiffLine(
        output,
        " ",
        oldSplit.lines[oldIndex] ?? "",
        oldIndex === oldSplit.lines.length - 1,
        oldSplit.finalNewline,
      );
    }
  }
  return `${output.join("\n")}\n`;
}

function applySourceEdits(source: string, edits: readonly SourceEdit[]): string {
  let result = source;
  const descending = [...edits].sort((left, right) => {
    if (left.startOffset !== right.startOffset) return right.startOffset - left.startOffset;
    const leftLength = left.endOffset - left.startOffset;
    const rightLength = right.endOffset - right.startOffset;
    return rightLength - leftLength;
  });
  for (const edit of descending) {
    result = `${result.slice(0, edit.startOffset)}${edit.markdown}${result.slice(edit.endOffset)}`;
  }
  return result;
}

export function applyEditIntents(source: string, rawIntents: EditIntent[]): PatchResult {
  if (typeof source !== "string" || !Array.isArray(rawIntents) || rawIntents.length === 0) {
    throw new MarkdownPatchError("INVALID_EDIT_INTENT");
  }
  if (rawIntents.length > MAX_EDIT_INTENTS) {
    throw new MarkdownPatchError("INVALID_EDIT_INTENT");
  }

  const outline = inspectMarkdownOutline(source);
  if (outline.status !== "available") {
    throw new MarkdownPatchError("MARKDOWN_COMPLEXITY_BUDGET");
  }
  const headings: readonly Heading[] = outline.headings;

  let intents: EditIntent[];
  try {
    intents = rawIntents.map((intent) => EditIntentSchema.parse(intent));
  } catch {
    throw new MarkdownPatchError("INVALID_EDIT_INTENT");
  }

  const annotationIds = intents.map((intent) => intent.annotationId);
  if (new Set(annotationIds).size !== annotationIds.length) {
    throw new MarkdownPatchError("DUPLICATE_ANNOTATION_ID");
  }
  const documentPath = intents[0]?.targetAnchor.documentPath;
  if (!documentPath || intents.some((intent) => intent.targetAnchor.documentPath !== documentPath)) {
    throwForAnnotations("DOCUMENT_PATH_MISMATCH", annotationIds);
  }

  const edits: SourceEdit[] = intents.map((intent) => {
    const relocated = relocateSourceAnchor(intent.targetAnchor, source);
    if (relocated.status === "orphaned") {
      const code = relocated.reason === "ambiguous" ? "ANCHOR_AMBIGUOUS" : "ANCHOR_MISSING";
      throwForAnnotations(code, [intent.annotationId]);
    }

    const ownerIndex = owningHeadingIndex(headings, relocated.startOffset);
    const owner = headings[ownerIndex];
    const actualHeadingPath = owner?.path ?? [];
    if (!sameStringArray(actualHeadingPath, intent.targetAnchor.headingPath)) {
      throwForAnnotations("ANCHOR_HEADING_MISMATCH", [intent.annotationId]);
    }

    if (intent.operation === "insert_after") {
      return {
        startOffset: relocated.endOffset,
        endOffset: relocated.endOffset,
        markdown: intent.markdown,
        annotationIds: [intent.annotationId],
        operation: intent.operation,
      };
    }
    if (intent.operation === "replace") {
      if (relocated.startOffset === 0 && relocated.endOffset === source.length) {
        throwForAnnotations("WHOLE_DOCUMENT_REWRITE", [intent.annotationId]);
      }
      return {
        startOffset: relocated.startOffset,
        endOffset: relocated.endOffset,
        markdown: intent.markdown,
        annotationIds: [intent.annotationId],
        operation: intent.operation,
      };
    }
    if (intent.operation === "append_section") {
      if (
        !owner ||
        headings.filter((heading) => sameStringArray(heading.path, owner.path)).length !== 1
      ) {
        throwForAnnotations("APPEND_SECTION_TARGET_INVALID", [intent.annotationId]);
      }
      const offset = appendSectionOffset(headings, ownerIndex, source.length);
      if (offset < 0) {
        throwForAnnotations("APPEND_SECTION_TARGET_INVALID", [intent.annotationId]);
      }
      return {
        startOffset: offset,
        endOffset: offset,
        markdown: intent.markdown,
        annotationIds: [intent.annotationId],
        operation: intent.operation,
      };
    }
    throw new MarkdownPatchError("INVALID_EDIT_INTENT");
  });

  const replacements = edits
    .filter((edit) => edit.operation === "replace" && edit.endOffset > edit.startOffset)
    .sort((left, right) => left.startOffset - right.startOffset);
  let coveredUntil = 0;
  const coveringIds: string[] = [];
  for (const replacement of replacements) {
    if (replacement.startOffset > coveredUntil) break;
    if (replacement.endOffset <= coveredUntil) continue;
    coveredUntil = replacement.endOffset;
    coveringIds.push(...replacement.annotationIds);
    if (coveredUntil === source.length) {
      throwForAnnotations("WHOLE_DOCUMENT_REWRITE", coveringIds);
    }
  }

  const safeEdits = mergeAndValidateEdits(edits);
  const markdown = applySourceEdits(source, safeEdits);
  if (Buffer.byteLength(markdown, "utf8") > MAX_PATCH_RESULT_BYTES) {
    throw new MarkdownPatchError("MARKDOWN_COMPLEXITY_BUDGET");
  }
  try {
    markdownParser.parse(markdown);
  } catch {
    throw new MarkdownPatchError("INVALID_EDIT_INTENT");
  }

  return Object.freeze({
    markdown,
    unifiedDiff: createUnifiedDiff(documentPath, source, markdown, safeEdits),
    sourceHash: sha256Text(source),
    resultHash: sha256Text(markdown),
    appliedAnnotationIds: annotationIds,
    conflicts: [],
  });
}

export function defaultExplainedPath(documentPath: string): string {
  let parsed: string;
  try {
    parsed = RelativePathSchema.parse(documentPath);
  } catch {
    throw new MarkdownPatchError("INVALID_DOCUMENT_PATH");
  }
  const match = /^(.*\/)?([^/]+)\.(?:md|markdown)$/iu.exec(parsed);
  const directory = match?.[1] ?? "";
  const stem = match?.[2];
  if (!stem || stem === ".") throw new MarkdownPatchError("INVALID_DOCUMENT_PATH");
  return `${directory}${stem}.explained.md`;
}
