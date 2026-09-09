import { describe, expect, it } from "vitest";

import { SourceAnchorSchema, type SourceAnchor } from "@aimd/contracts";

import {
  createSourceAnchor,
  inspectMarkdownOutline,
  relocateSourceAnchor,
} from "./anchor.js";
import { sha256Text } from "./hash.js";

function selectionOffsets(markdown: string, selectedText: string, occurrence = 0) {
  let start = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    start = markdown.indexOf(selectedText, from);
    if (start < 0) throw new Error(`Missing fixture selection: ${selectedText}`);
    from = start + selectedText.length;
  }
  return { start, end: start + selectedText.length };
}

function createFixtureAnchor(
  markdown: string,
  selectedText: string,
  occurrence = 0,
): SourceAnchor {
  const { start, end } = selectionOffsets(markdown, selectedText, occurrence);
  return createSourceAnchor("docs/architecture.md", markdown, start, end);
}

describe("createSourceAnchor", () => {
  it("captures the exact hash, slice, heading hierarchy, context, and offsets", () => {
    const markdown = [
      "# System",
      "",
      "Introduction.",
      "",
      "## Runtime",
      "",
      "The gateway dispatches work to the worker.",
      "",
    ].join("\n");
    const selectedText = "gateway dispatches work";
    const { start, end } = selectionOffsets(markdown, selectedText);

    const anchor = createSourceAnchor("docs/architecture.md", markdown, start, end);

    expect(SourceAnchorSchema.parse(anchor)).toEqual(anchor);
    expect(anchor).toMatchObject({
      documentPath: "docs/architecture.md",
      documentHash: sha256Text(markdown),
      headingPath: ["System", "Runtime"],
      selectedText,
      startOffset: start,
      endOffset: end,
    });
    expect(anchor.prefix.length).toBeGreaterThan(0);
    expect(markdown.slice(start - anchor.prefix.length, start)).toBe(anchor.prefix);
    expect(anchor.suffix.length).toBeGreaterThan(0);
    expect(markdown.slice(end, end + anchor.suffix.length)).toBe(anchor.suffix);
  });

  it.each([
    "../README.md",
    "/tmp/README.md",
    "C:/project/README.md",
    "docs\\README.md",
    "docs//README.md",
  ])("rejects a document path excluded by SourceAnchorSchema: %s", (documentPath) => {
    expect(() => createSourceAnchor(documentPath, "valid text", 0, 5)).toThrow();
  });

  it.each([
    [-1, 4],
    [0.5, 4],
    [2, 2],
    [4, 2],
    [0, 11],
    [Number.NaN, 4],
  ])("rejects invalid or out-of-bounds offsets (%s, %s)", (start, end) => {
    expect(() => createSourceAnchor("README.md", "valid text", start, end)).toThrow(
      /offset|range|integer/i,
    );
  });

  it("rejects a blank selection consistently with SourceAnchorSchema", () => {
    expect(() => createSourceAnchor("README.md", "before   after", 6, 9)).toThrow(
      /selected text|relocation|anchor/i,
    );
  });

  it("uses UTF-16 offsets without corrupting Unicode selections", () => {
    const markdown = "# 国际化\r\n\r\n入口由 🚪 gateway 调用 worker。\r\n";
    const selectedText = "🚪 gateway";
    const { start, end } = selectionOffsets(markdown, selectedText);

    const anchor = createSourceAnchor("docs/i18n.md", markdown, start, end);

    expect(anchor.selectedText).toBe(selectedText);
    expect(anchor.headingPath).toEqual(["国际化"]);
    expect(anchor.startOffset).toBe(start);
    expect(anchor.endOffset).toBe(end);
    expect(markdown.slice(anchor.startOffset, anchor.endOffset)).toBe(selectedText);
    expect(relocateSourceAnchor(anchor, markdown)).toEqual({
      status: "exact",
      startOffset: start,
      endOffset: end,
    });
  });

  it("keeps captured context windows fixed and bounded", () => {
    const markdown = `${"p".repeat(600)}chosen term${"s".repeat(600)}`;
    const { start, end } = selectionOffsets(markdown, "chosen term");

    const anchor = createSourceAnchor("README.md", markdown, start, end);

    expect(anchor.prefix).toHaveLength(256);
    expect(anchor.suffix).toHaveLength(256);
    expect(anchor.prefix).toBe("p".repeat(256));
    expect(anchor.suffix).toBe("s".repeat(256));
  });

  it("uses Markdown AST headings, including Setext and inline formatting", () => {
    const markdown = [
      "```text",
      "# not a heading",
      "```",
      "",
      "*System* `core`",
      "===============",
      "",
      "### **Runtime**",
      "",
      "The selected term is here.",
      "",
    ].join("\n");

    const anchor = createFixtureAnchor(markdown, "selected term");

    expect(anchor.headingPath).toEqual(["System core", "Runtime"]);
  });

  it("exposes the canonical bounded outline used by source anchors", () => {
    const markdown = [
      "# *Architecture*",
      "",
      "~~~md",
      "~~~ still-open",
      "# Fence false",
      "~~~",
      "",
      "<div>",
      "# HTML false",
      "</div>",
      "",
      "Alpha",
      "Beta",
      "-----",
    ].join("\n");

    expect(inspectMarkdownOutline(markdown)).toEqual({
      status: "available",
      headings: [
        {
          depth: 1,
          text: "Architecture",
          line: 1,
          startOffset: 0,
          path: ["Architecture"],
        },
        {
          depth: 2,
          text: "Alpha\nBeta",
          line: 12,
          startOffset: markdown.indexOf("Alpha"),
          path: ["Architecture", "Alpha\nBeta"],
        },
      ],
    });
  });

  it("reports explicit view-only degradation before parsing an over-budget outline", () => {
    expect(inspectMarkdownOutline(`# ${"*".repeat(8_193)}\nbody`)).toEqual({
      status: "view_only",
      code: "SOURCE_ANCHOR_COMPLEXITY_BUDGET",
      headings: [],
    });
  });

  it("rejects a heading bomb before attempting Markdown AST anchoring", () => {
    const markdown = `${Array.from({ length: 1_025 }, (_, index) => `# h${index}`).join("\n")}\nterm`;
    const start = markdown.lastIndexOf("term");

    expect(() => createSourceAnchor("README.md", markdown, start, start + 4)).toThrow(
      /anchor.*complexity|complexity.*anchor/i,
    );
  });

  it("rejects oversized source and inline-syntax bombs before Markdown parsing", () => {
    const oversized = `${"plain ".repeat(50_000)}term`;
    const oversizedStart = oversized.lastIndexOf("term");
    expect(() =>
      createSourceAnchor("README.md", oversized, oversizedStart, oversizedStart + 4),
    ).toThrow(/anchor.*complexity|complexity.*anchor/i);

    const inlineBomb = `${"*a*".repeat(4_097)}term`;
    const inlineStart = inlineBomb.lastIndexOf("term");
    expect(() =>
      createSourceAnchor("README.md", inlineBomb, inlineStart, inlineStart + 4),
    ).toThrow(/anchor.*complexity|complexity.*anchor/i);
  });
});

describe("relocateSourceAnchor", () => {
  it("returns exact only when both the document hash and selected slice match", () => {
    const markdown = "# Flow\n\nThe gateway calls the worker.\n";
    const anchor = createFixtureAnchor(markdown, "gateway calls the worker");

    expect(relocateSourceAnchor(anchor, markdown)).toEqual({
      status: "exact",
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
    });

    const movedAnchor = SourceAnchorSchema.parse({
      ...anchor,
      startOffset: 0,
      endOffset: anchor.selectedText.length,
    });
    expect(relocateSourceAnchor(movedAnchor, markdown)).toMatchObject({
      status: "relocated",
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
    });
  });

  it("marks the same slice as relocated when an edit elsewhere changed the hash", () => {
    const original = "# Flow\n\nThe gateway calls the worker.\n";
    const anchor = createFixtureAnchor(original, "gateway calls the worker");
    const changed = `${original}\nUnrelated appendix.\n`;

    expect(relocateSourceAnchor(anchor, changed)).toEqual({
      status: "relocated",
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
    });
  });

  it("fails closed for a contract-valid rendered selection with a widened source span", () => {
    const markdown = "`term`";
    const widenedAnchor = SourceAnchorSchema.parse({
      documentPath: "README.md",
      documentHash: sha256Text(markdown),
      headingPath: [],
      selectedText: "term",
      prefix: "",
      suffix: "",
      startOffset: 0,
      endOffset: markdown.length,
    });

    expect(relocateSourceAnchor(widenedAnchor, markdown)).toEqual({
      status: "orphaned",
      reason: "missing",
    });
  });

  it("relocates after an earlier edit within the recorded heading", () => {
    const original = "# Intro\n\nAlpha.\n\n## Flow\n\nThe gateway calls the worker.\n";
    const anchor = createFixtureAnchor(original, "gateway calls the worker");
    const changed = [
      "# Intro",
      "",
      "New paragraph.",
      "",
      "Alpha.",
      "",
      "## Flow",
      "",
      "The gateway calls the worker.",
      "",
    ].join("\n");
    const expectedStart = changed.indexOf(anchor.selectedText);

    expect(relocateSourceAnchor(anchor, changed)).toEqual({
      status: "relocated",
      startOffset: expectedStart,
      endOffset: expectedStart + anchor.selectedText.length,
    });
  });

  it("limits relocation to the recorded nested heading path", () => {
    const original = [
      "# Backend",
      "",
      "## Flow",
      "",
      "The shared term describes backend ingress.",
      "",
      "# Frontend",
      "",
      "## Flow",
      "",
      "The shared term describes browser ingress.",
      "",
    ].join("\n");
    const anchor = createFixtureAnchor(original, "shared term");
    const changed = `Preface.\n\n${original}`;
    const expectedStart = changed.indexOf("shared term");

    expect(anchor.headingPath).toEqual(["Backend", "Flow"]);
    expect(relocateSourceAnchor(anchor, changed)).toEqual({
      status: "relocated",
      startOffset: expectedStart,
      endOffset: expectedStart + anchor.selectedText.length,
    });
  });

  it("keeps a preamble anchor out of later heading scopes", () => {
    const original = "Preamble term.\n\n# Details\n\nPreamble term.\n";
    const anchor = createFixtureAnchor(original, "Preamble term");
    const changed = `Inserted.\n\n${original}`;
    const expectedStart = changed.indexOf("Preamble term");

    expect(anchor.headingPath).toEqual([]);
    expect(relocateSourceAnchor(anchor, changed)).toEqual({
      status: "relocated",
      startOffset: expectedStart,
      endOffset: expectedStart + anchor.selectedText.length,
    });
  });

  it("uses prefix and suffix agreement to choose one repeated selection", () => {
    const original = [
      "# Flow",
      "",
      "Primary route: shared term -> worker alpha.",
      "Fallback route: shared term -> worker beta.",
      "",
    ].join("\n");
    const anchor = createFixtureAnchor(original, "shared term", 1);
    const changed = [
      "# Flow",
      "",
      "Intro changed.",
      "Primary route: shared term -> worker alpha.",
      "Fallback route: shared term -> worker beta.",
      "",
    ].join("\n");
    const expectedStart = selectionOffsets(changed, "shared term", 1).start;

    expect(relocateSourceAnchor(anchor, changed)).toEqual({
      status: "relocated",
      startOffset: expectedStart,
      endOffset: expectedStart + anchor.selectedText.length,
    });
  });

  it("orphans a tied relocation instead of guessing", () => {
    const anchor = SourceAnchorSchema.parse({
      documentPath: "docs/architecture.md",
      documentHash: sha256Text("an older document"),
      headingPath: [],
      selectedText: "shared term",
      prefix: "",
      suffix: "",
      startOffset: 0,
      endOffset: "shared term".length,
    });

    expect(relocateSourceAnchor(anchor, "shared term\nshared term")).toEqual({
      status: "orphaned",
      reason: "ambiguous",
    });
  });

  it("aggregates candidates from repeated sibling heading paths before deciding", () => {
    const original = "# System\n\n## Flow\n\nUnique term.\n";
    const anchor = createFixtureAnchor(original, "Unique term");
    const changed = [
      "# System",
      "",
      "## Flow",
      "",
      "Unique term.",
      "",
      "## Flow",
      "",
      "Unique term.",
      "",
    ].join("\n");

    expect(relocateSourceAnchor(anchor, changed)).toEqual({
      status: "orphaned",
      reason: "ambiguous",
    });
  });

  it("considers overlapping exact-text occurrences and refuses a tie", () => {
    const anchor = SourceAnchorSchema.parse({
      documentPath: "README.md",
      documentHash: sha256Text("old content"),
      headingPath: [],
      selectedText: "aaa",
      prefix: "",
      suffix: "",
      startOffset: 0,
      endOffset: 3,
    });

    expect(relocateSourceAnchor(anchor, "aaaa")).toEqual({
      status: "orphaned",
      reason: "ambiguous",
    });
  });

  it("fails closed when repeated text exceeds the relocation candidate budget", () => {
    const anchor = SourceAnchorSchema.parse({
      documentPath: "README.md",
      documentHash: sha256Text("old content"),
      headingPath: [],
      selectedText: "a",
      prefix: "UNIQUE",
      suffix: "",
      startOffset: 0,
      endOffset: 1,
    });
    const adversarial = `${"a ".repeat(1_025)}UNIQUEa`;

    expect(relocateSourceAnchor(anchor, adversarial)).toEqual({
      status: "orphaned",
      reason: "ambiguous",
    });
  });

  it("fails closed for a non-server anchor with oversized context windows", () => {
    const oversizedPrefix = "x".repeat(257);
    const anchor = SourceAnchorSchema.parse({
      documentPath: "README.md",
      documentHash: sha256Text("old content"),
      headingPath: [],
      selectedText: "term",
      prefix: oversizedPrefix,
      suffix: "",
      startOffset: 0,
      endOffset: 4,
    });

    expect(relocateSourceAnchor(anchor, `${oversizedPrefix}term`)).toEqual({
      status: "orphaned",
      reason: "missing",
    });
  });

  it("fails closed before parsing a changed document beyond the anchor complexity budget", () => {
    const anchor = SourceAnchorSchema.parse({
      documentPath: "README.md",
      documentHash: sha256Text("old content"),
      headingPath: [],
      selectedText: "term",
      prefix: "",
      suffix: "",
      startOffset: 0,
      endOffset: 4,
    });
    const headingBomb = `${Array.from({ length: 1_025 }, (_, index) => `# h${index}`).join("\n")}\nterm`;

    expect(relocateSourceAnchor(anchor, headingBomb)).toEqual({
      status: "orphaned",
      reason: "ambiguous",
    });
  });

  it("orphans a missing selection or missing heading path", () => {
    const original = "# Backend\n\n## Flow\n\nThe gateway calls the worker.\n";
    const anchor = createFixtureAnchor(original, "gateway calls the worker");

    expect(relocateSourceAnchor(anchor, "# Backend\n\n## Flow\n\nNo match.\n")).toEqual({
      status: "orphaned",
      reason: "missing",
    });
    expect(
      relocateSourceAnchor(anchor, "# Frontend\n\n## Flow\n\nThe gateway calls the worker.\n"),
    ).toEqual({ status: "orphaned", reason: "missing" });
  });

  it("handles relocation in CRLF Markdown with Unicode context", () => {
    const original = "# 系统\r\n\r\n## 流程\r\n\r\n入口 🚪 调用 worker。\r\n";
    const anchor = createFixtureAnchor(original, "🚪 调用 worker");
    const changed = "# 系统\r\n\r\n新增说明。\r\n\r\n## 流程\r\n\r\n入口 🚪 调用 worker。\r\n";
    const expectedStart = changed.indexOf(anchor.selectedText);

    expect(relocateSourceAnchor(anchor, changed)).toEqual({
      status: "relocated",
      startOffset: expectedStart,
      endOffset: expectedStart + anchor.selectedText.length,
    });
  });

  it("rejects a runtime anchor that violates SourceAnchorSchema", () => {
    const malformed = {
      documentPath: "../outside.md",
      documentHash: "not-a-hash",
      headingPath: [],
      selectedText: "term",
      prefix: "",
      suffix: "",
      startOffset: 0,
      endOffset: 4,
    } as unknown as SourceAnchor;

    expect(() => relocateSourceAnchor(malformed, "term")).toThrow();
  });
});
