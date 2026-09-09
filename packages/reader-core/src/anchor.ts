import { Buffer } from "node:buffer";

import { SourceAnchorSchema, type SourceAnchor } from "@aimd/contracts";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { sha256Text } from "./hash.js";

const CONTEXT_WINDOW = 256;
const MAX_RELOCATION_CANDIDATES = 1_024;
const MAX_ANCHOR_SOURCE_BYTES = 256 * 1024;
const MAX_ANCHOR_SOURCE_CODE_UNITS = 256 * 1024;
const MAX_ANCHOR_LINES = 4_096;
const MAX_ANCHOR_SYNTAX_MARKERS = 8_192;
const MAX_ANCHOR_POTENTIAL_HEADINGS = 1_024;
const ANCHOR_SYNTAX_MARKERS = new Set([
  "#", "*", "_", "~", "`", "[", "]", "<", ">", "!", "\\", "-", "+", "|", ".", ")",
]);
const POTENTIAL_HEADING = /^(?: {0,3}#{1,6}(?:[ \t]|$)| {0,3}(?:=+|-+)[ \t]*$)/u;

export type RelocatedSourceAnchor =
  | {
      readonly status: "exact" | "relocated";
      readonly startOffset: number;
      readonly endOffset: number;
    }
  | {
      readonly status: "orphaned";
      readonly reason: "missing" | "ambiguous";
    };

export type MarkdownOutlineHeading = Readonly<{
  readonly depth: number;
  readonly text: string;
  readonly line: number;
  readonly path: readonly string[];
  readonly startOffset: number;
}>;

export type MarkdownOutlineInspection =
  | Readonly<{
      status: "available";
      headings: readonly MarkdownOutlineHeading[];
    }>
  | Readonly<{
      status: "view_only";
      code: "SOURCE_ANCHOR_COMPLEXITY_BUDGET";
      headings: readonly [];
    }>;

type HeadingRecord = MarkdownOutlineHeading;

type SearchScope = {
  readonly startOffset: number;
  readonly endOffset: number;
};

type RelocationCandidate = {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly score: number;
};

type CandidateSearchResult = {
  readonly candidates: readonly RelocationCandidate[];
  readonly exceededBudget: boolean;
};

const markdownParser = unified().use(remarkParse).use(remarkGfm);

function isWithinAnchorDocumentBudget(markdown: string): boolean {
  if (
    markdown.length > MAX_ANCHOR_SOURCE_CODE_UNITS ||
    Buffer.byteLength(markdown, "utf8") > MAX_ANCHOR_SOURCE_BYTES
  ) {
    return false;
  }

  let lines = 1;
  let syntaxMarkers = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown[index]!;
    if (character === "\n") {
      if (markdown[index - 1] !== "\r") lines += 1;
    } else if (character === "\r") {
      lines += 1;
    }
    if (lines > MAX_ANCHOR_LINES) return false;

    if (ANCHOR_SYNTAX_MARKERS.has(character)) {
      syntaxMarkers += 1;
      if (syntaxMarkers > MAX_ANCHOR_SYNTAX_MARKERS) return false;
    }
  }

  let potentialHeadings = 0;
  for (const line of markdown.split(/\r\n|\n|\r/u)) {
    if (!POTENTIAL_HEADING.test(line)) continue;
    potentialHeadings += 1;
    if (potentialHeadings > MAX_ANCHOR_POTENTIAL_HEADINGS) return false;
  }
  return true;
}

function assertAnchorDocumentBudget(markdown: string): void {
  if (!isWithinAnchorDocumentBudget(markdown)) {
    throw new RangeError("Markdown exceeds the source-anchor complexity budget");
  }
}

function parseHeadingRecords(markdown: string): HeadingRecord[] {
  const tree = markdownParser.parse(markdown);
  const records: HeadingRecord[] = [];
  const stack: Array<{ readonly depth: number; readonly title: string }> = [];

  for (const child of tree.children) {
    if (child.type !== "heading") continue;

    const startOffset = child.position?.start.offset;
    const line = child.position?.start.line;
    if (startOffset === undefined || line === undefined) continue;

    const title = toString(child).trim();
    if (title.length === 0) continue;

    while ((stack.at(-1)?.depth ?? 0) >= child.depth) {
      stack.pop();
    }
    stack.push({ depth: child.depth, title });
    records.push({
      depth: child.depth,
      text: title,
      line,
      path: stack.map((entry) => entry.title),
      startOffset,
    });
  }

  return records;
}

function headingRecords(markdown: string): HeadingRecord[] {
  assertAnchorDocumentBudget(markdown);
  return parseHeadingRecords(markdown);
}

/**
 * Returns the exact bounded Markdown heading interpretation used by source
 * anchoring. Callers can keep an over-budget document readable without
 * invoking the AST parser or pretending that selection anchors are available.
 */
export function inspectMarkdownOutline(markdown: string): MarkdownOutlineInspection {
  if (!isWithinAnchorDocumentBudget(markdown)) {
    return {
      status: "view_only",
      code: "SOURCE_ANCHOR_COMPLEXITY_BUDGET",
      headings: [],
    };
  }
  return { status: "available", headings: parseHeadingRecords(markdown) };
}

function sameHeadingPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function headingPathAt(records: readonly HeadingRecord[], offset: number): string[] {
  let path: readonly string[] = [];
  for (const heading of records) {
    if (heading.startOffset > offset) break;
    path = heading.path;
  }
  return [...path];
}

function scopesForHeadingPath(
  records: readonly HeadingRecord[],
  headingPath: readonly string[],
  markdownLength: number,
): SearchScope[] {
  if (headingPath.length === 0) {
    return [{ startOffset: 0, endOffset: records[0]?.startOffset ?? markdownLength }];
  }

  const scopes: SearchScope[] = [];
  for (const [index, heading] of records.entries()) {
    if (!sameHeadingPath(heading.path, headingPath)) continue;
    scopes.push({
      startOffset: heading.startOffset,
      endOffset: records[index + 1]?.startOffset ?? markdownLength,
    });
  }
  return scopes;
}

function commonSuffixLength(left: string, right: string): number {
  const maximum = Math.min(left.length, right.length);
  let length = 0;
  while (length < maximum && left[left.length - length - 1] === right[right.length - length - 1]) {
    length += 1;
  }
  return length;
}

function commonPrefixLength(left: string, right: string): number {
  const maximum = Math.min(left.length, right.length);
  let length = 0;
  while (length < maximum && left[length] === right[length]) {
    length += 1;
  }
  return length;
}

function contextScore(
  anchor: SourceAnchor,
  markdown: string,
  scope: SearchScope,
  startOffset: number,
  endOffset: number,
): number {
  const preceding = markdown.slice(
    Math.max(scope.startOffset, startOffset - anchor.prefix.length),
    startOffset,
  );
  const following = markdown.slice(
    endOffset,
    Math.min(scope.endOffset, endOffset + anchor.suffix.length),
  );
  return (
    commonSuffixLength(anchor.prefix, preceding) +
    commonPrefixLength(anchor.suffix, following)
  );
}

function candidatesWithinScopes(
  anchor: SourceAnchor,
  markdown: string,
  scopes: readonly SearchScope[],
): CandidateSearchResult {
  const candidates: RelocationCandidate[] = [];

  for (const scope of scopes) {
    let fromOffset = scope.startOffset;
    while (fromOffset <= scope.endOffset - anchor.selectedText.length) {
      const startOffset = markdown.indexOf(anchor.selectedText, fromOffset);
      if (startOffset < 0 || startOffset + anchor.selectedText.length > scope.endOffset) break;

      if (candidates.length >= MAX_RELOCATION_CANDIDATES) {
        return { candidates, exceededBudget: true };
      }

      const endOffset = startOffset + anchor.selectedText.length;
      candidates.push({
        startOffset,
        endOffset,
        score: contextScore(anchor, markdown, scope, startOffset, endOffset),
      });
      fromOffset = startOffset + 1;
    }
  }

  return { candidates, exceededBudget: false };
}

function assertValidSelectionRange(markdown: string, startOffset: number, endOffset: number): void {
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) {
    throw new RangeError("Source anchor offsets must be integers");
  }
  if (startOffset < 0 || endOffset <= startOffset || endOffset > markdown.length) {
    throw new RangeError("Source anchor offsets are outside the Markdown range");
  }
}

/**
 * Creates a raw-source anchor at the trusted server boundary.
 *
 * Browser/UI callers must submit only an opaque document reference and
 * selection hints. The workspace service rereads the bound Markdown and calls
 * this function; client-supplied hashes or ready-made anchors are never trusted.
 */
export function createSourceAnchor(
  path: string,
  markdown: string,
  start: number,
  end: number,
): SourceAnchor {
  assertValidSelectionRange(markdown, start, end);
  const records = headingRecords(markdown);

  return SourceAnchorSchema.parse({
    documentPath: path,
    documentHash: sha256Text(markdown),
    headingPath: headingPathAt(records, start),
    selectedText: markdown.slice(start, end),
    prefix: markdown.slice(Math.max(0, start - CONTEXT_WINDOW), start),
    suffix: markdown.slice(end, Math.min(markdown.length, end + CONTEXT_WINDOW)),
    startOffset: start,
    endOffset: end,
  });
}

export function relocateSourceAnchor(
  rawAnchor: SourceAnchor,
  markdown: string,
): RelocatedSourceAnchor {
  const anchor = SourceAnchorSchema.parse(rawAnchor);
  if (anchor.endOffset - anchor.startOffset !== anchor.selectedText.length) {
    // SourceAnchorSchema intentionally permits rendered text to be paired with
    // a wider Markdown source span (for example `term` versus term). Without a
    // separately stored raw source slice/span digest, narrowing that span to a
    // matching substring would be an unsafe guess.
    return { status: "orphaned", reason: "missing" };
  }
  if (anchor.prefix.length > CONTEXT_WINDOW || anchor.suffix.length > CONTEXT_WINDOW) {
    return { status: "orphaned", reason: "missing" };
  }
  if (!isWithinAnchorDocumentBudget(markdown)) {
    return { status: "orphaned", reason: "ambiguous" };
  }
  if (
    anchor.documentHash === sha256Text(markdown) &&
    markdown.slice(anchor.startOffset, anchor.endOffset) === anchor.selectedText
  ) {
    return {
      status: "exact",
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
    };
  }

  const records = headingRecords(markdown);
  const scopes = scopesForHeadingPath(records, anchor.headingPath, markdown.length);
  const search = candidatesWithinScopes(anchor, markdown, scopes);
  if (search.exceededBudget) {
    return { status: "orphaned", reason: "ambiguous" };
  }
  const candidates = [...search.candidates];
  if (candidates.length === 0) {
    return { status: "orphaned", reason: "missing" };
  }

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best) {
    return { status: "orphaned", reason: "missing" };
  }
  if (candidates[1]?.score === best.score) {
    return { status: "orphaned", reason: "ambiguous" };
  }

  return {
    status: "relocated",
    startOffset: best.startOffset,
    endOffset: best.endOffset,
  };
}
