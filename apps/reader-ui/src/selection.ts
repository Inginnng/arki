import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

export type SourceSelection = Readonly<{
  startOffset: number;
  endOffset: number;
  renderedText: string;
}>;

export class SelectionMappingError extends Error {
  constructor(readonly code: "SELECTION_EMPTY" | "SELECTION_UNMAPPED" | "SELECTION_AMBIGUOUS") {
    super(code);
    this.name = "SelectionMappingError";
  }
}

type PositionedElement = HTMLElement & { dataset: { sourceStart?: string; sourceEnd?: string } };

function positionedAncestor(node: Node): PositionedElement | undefined {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  const positioned = element?.closest<PositionedElement>("[data-source-start][data-source-end]");
  return positioned ?? undefined;
}

function bounds(element: PositionedElement, markdownLength: number): { start: number; end: number } {
  const start = Number.parseInt(element.dataset.sourceStart ?? "", 10);
  const end = Number.parseInt(element.dataset.sourceEnd ?? "", 10);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > markdownLength) {
    throw new SelectionMappingError("SELECTION_UNMAPPED");
  }
  return { start, end };
}

function textOffset(element: HTMLElement, container: Node, offset: number): number {
  const prefix = document.createRange();
  prefix.selectNodeContents(element);
  try {
    prefix.setEnd(container, offset);
  } catch {
    throw new SelectionMappingError("SELECTION_UNMAPPED");
  }
  return prefix.toString().length;
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; position?: { start: { offset?: number }; end: { offset?: number } } };
type VisibleLeaf = { start: number; end: number; value: string; contentStart: number | null };
const parser = unified().use(remarkParse).use(remarkGfm);
// Retain only one document. Parsing is shared by both endpoints and repeated selections.
let cachedMarkdown: string | undefined;
let cachedLeaves: VisibleLeaf[] = [];

function visibleLeaves(markdown: string): VisibleLeaf[] {
  if (markdown === cachedMarkdown) return cachedLeaves;
  const leaves: VisibleLeaf[] = [];
  const visit = (node: MarkdownNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (["text", "inlineCode", "code"].includes(node.type) && typeof node.value === "string" && typeof start === "number" && typeof end === "number") {
      const raw = markdown.slice(start, end);
      let contentStart: number | null = null;
      if (node.type === "text" && raw === node.value) contentStart = start;
      if (node.type === "inlineCode") {
        const delimiter = /^`+/.exec(raw)?.[0];
        if (delimiter && raw.endsWith(delimiter) && raw.slice(delimiter.length, -delimiter.length) === node.value) contentStart = start + delimiter.length;
      }
      if (node.type === "code") {
        // The opening fence and its metadata are never part of the visible body.
        const opening = /^ {0,3}(?:`{3,}|~{3,})[^\r\n]*\r?\n/.exec(raw)?.[0];
        const prefixLength = opening?.length ?? (/^[ \t]*/.exec(raw)?.[0].length ?? 0);
        if (raw.slice(prefixLength, prefixLength + node.value.length) === node.value) contentStart = start + prefixLength;
      }
      leaves.push({ start, end, value: node.value, contentStart });
    }
    // Link URLs/titles, image alt text, and definitions are metadata, not leaves.
    node.children?.forEach(visit);
  };
  visit(parser.parse(markdown) as MarkdownNode);
  cachedMarkdown = markdown; cachedLeaves = leaves;
  return leaves;
}

function sourceCharacters(element: PositionedElement, markdown: string): number[] {
  const span = bounds(element, markdown.length);
  const domText = element.textContent ?? "";
  const raw = markdown.slice(span.start, span.end);
  if (domText === raw) return Array.from({ length: raw.length }, (_, index) => span.start + index);
  let visible = "";
  let offsets: number[] = [];
  for (const leaf of visibleLeaves(markdown)) {
    if (leaf.end <= span.start || leaf.start >= span.end) continue;
    // Decoded entities, escapes, CRLF, and normalized code cannot use guessed offsets.
    if (leaf.contentStart === null) throw new SelectionMappingError("SELECTION_UNMAPPED");
    const first = Math.max(span.start, leaf.contentStart);
    const last = Math.min(span.end, leaf.contentStart + leaf.value.length);
    if (last <= first) continue;
    visible += markdown.slice(first, last);
    for (let offset = first; offset < last; offset++) offsets.push(offset);
  }
  if (element.tagName === "TD" || element.tagName === "TH") {
    // Table cell positions may include padding and a boundary pipe; these alone
    // can be removed, and the entire remaining visible cell must still agree.
    const leading = /^(?:\|)?[ \t]*/.exec(visible)?.[0].length ?? 0;
    const trailing = /[ \t]*(?:\|)?$/.exec(visible)?.[0].length ?? 0;
    const end = visible.length - trailing;
    visible = visible.slice(leading, end); offsets = offsets.slice(leading, end);
  }
  if ((element.tagName === "CODE" || element.tagName === "PRE") && domText === visible + "\n") {
    // ReactMarkdown adds a final code newline; it has no selectable source offset.
    visible += "\n"; offsets.push(-1);
  }
  if (visible !== domText) throw new SelectionMappingError("SELECTION_UNMAPPED");
  return offsets;
}

/** Maps only within parser-owned spans; it never searches the entire document. */
export function mapDomRangeToSource(range: Range, markdown: string): SourceSelection {
  if (range.collapsed) throw new SelectionMappingError("SELECTION_EMPTY");
  const renderedText = range.toString();
  if (renderedText.length === 0) throw new SelectionMappingError("SELECTION_EMPTY");
  const startElement = positionedAncestor(range.startContainer);
  const endElement = positionedAncestor(range.endContainer);
  if (!startElement || !endElement) throw new SelectionMappingError("SELECTION_UNMAPPED");
  const startCharacters = sourceCharacters(startElement, markdown);
  const endCharacters = startElement === endElement ? startCharacters : sourceCharacters(endElement, markdown);
  const start = startCharacters[textOffset(startElement, range.startContainer, range.startOffset)];
  const last = endCharacters[textOffset(endElement, range.endContainer, range.endOffset) - 1];
  if (start === undefined || last === undefined || start < 0 || last < start) throw new SelectionMappingError("SELECTION_UNMAPPED");
  return { startOffset: start, endOffset: last + 1, renderedText };
}
