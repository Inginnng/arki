import type { EditIntent, SourceAnchor } from "@aimd/contracts";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

import { createSourceAnchor } from "./anchor.js";
import { sha256Text } from "./hash.js";
import {
  MarkdownPatchError,
  applyEditIntents,
  defaultExplainedPath,
  type MarkdownPatchErrorCode,
} from "./markdown.js";

function editIntent(
  source: string,
  selectedText: string,
  overrides: Partial<EditIntent> = {},
): EditIntent {
  const startOffset = source.indexOf(selectedText);
  if (startOffset < 0) throw new Error(`Missing test selection: ${selectedText}`);

  return {
    annotationId: "annotation-1",
    operation: "insert_after",
    targetAnchor: createSourceAnchor(
      "docs/guide.md",
      source,
      startOffset,
      startOffset + selectedText.length,
    ),
    markdown: "\n\n> Explanation.",
    rationale: "Explain the selected text.",
    evidenceIds: ["evidence-1"],
    ...overrides,
  };
}

function capturePatchError(run: () => unknown, code: MarkdownPatchErrorCode): MarkdownPatchError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MarkdownPatchError);
    expect(error).toMatchObject({ code });
    return error as MarkdownPatchError;
  }
  throw new Error(`Expected MarkdownPatchError ${code}`);
}

describe("applyEditIntents", () => {
  it("inserts an accepted explanation without reformatting unrelated Markdown", () => {
    const source = "# Design\n\nBefore.\n\n## Queue\n\nThe worker drains it.\n\nAfter.\n";
    const result = applyEditIntents(source, [
      editIntent(source, "The worker drains it.", {
        markdown: "\n\n> **Explanation:** The queue decouples intake from execution.",
      }),
    ]);

    expect(result.markdown).toBe(
      "# Design\n\nBefore.\n\n## Queue\n\nThe worker drains it.\n\n" +
        "> **Explanation:** The queue decouples intake from execution.\n\nAfter.\n",
    );
    expect(result).toMatchObject({
      sourceHash: sha256Text(source),
      resultHash: sha256Text(result.markdown),
      appliedAnnotationIds: ["annotation-1"],
      conflicts: [],
    });
    expect(result.unifiedDiff).toContain("--- a/docs/guide.md");
    expect(result.unifiedDiff).toContain("+++ b/docs/guide.md");
    expect(result.unifiedDiff).toContain(
      "+> **Explanation:** The queue decouples intake from execution.",
    );
  });

  it("applies replacements from the end so original UTF-16 offsets stay valid", () => {
    const source = "# Values\n\nFirst: one.\n\nSecond: two.\n";
    const first = editIntent(source, "one", {
      annotationId: "annotation-first",
      operation: "replace",
      markdown: "ONE-LONG",
    });
    const second = editIntent(source, "two", {
      annotationId: "annotation-second",
      operation: "replace",
      markdown: "TWO",
    });

    const result = applyEditIntents(source, [first, second]);

    expect(result.markdown).toBe("# Values\n\nFirst: ONE-LONG.\n\nSecond: TWO.\n");
    expect(result.appliedAnnotationIds).toEqual([
      "annotation-first",
      "annotation-second",
    ]);
  });

  it("renders an exact diff when an insertion and replacement share a line-boundary offset", () => {
    const source = "# H\n\nOne\nTwo\n";
    const replacement = editIntent(source, "Two\n", {
      annotationId: "annotation-replace",
      operation: "replace",
      markdown: "Second\n",
    });
    const insertion = editIntent(source, "One\n", {
      annotationId: "annotation-insert",
      operation: "insert_after",
      markdown: "Inserted\n",
    });

    const result = applyEditIntents(source, [replacement, insertion]);

    expect(result.markdown).toBe("# H\n\nOne\nInserted\nSecond\n");
    expect(result.unifiedDiff).toContain("+Inserted\n");
    expect(result.unifiedDiff).toContain("-Two\n+Second\n");
    expect(result.unifiedDiff).toContain("@@ -1,4 +1,5 @@");
  });

  it("preserves CRLF bytes around an exact insertion", () => {
    const source = "# Guide\r\n\r\nKeep.\r\n\r\nTarget.\r\n";
    const result = applyEditIntents(source, [
      editIntent(source, "Target.", {
        markdown: "\r\n\r\n> CRLF explanation.",
      }),
    ]);

    expect(result.markdown).toBe(
      "# Guide\r\n\r\nKeep.\r\n\r\nTarget.\r\n\r\n> CRLF explanation.\r\n",
    );
    expect(result.markdown.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("does not invent a trailing newline", () => {
    const source = "# Guide\n\nTarget.";
    const result = applyEditIntents(source, [
      editIntent(source, "Target.", { markdown: "\n\nExplanation." }),
    ]);

    expect(result.markdown).toBe("# Guide\n\nTarget.\n\nExplanation.");
    expect(result.markdown.endsWith("\n")).toBe(false);
  });

  it("changes only a table cell and preserves fenced code verbatim", () => {
    const source =
      "# Status\n\n```txt\nstate = pending\n```\n\n| Item | State |\n| --- | --- |\n| job | pending |\n";
    const tablePending = source.lastIndexOf("pending");
    const intent = editIntent(source, "pending", {
      operation: "replace",
      markdown: "ready",
      targetAnchor: createSourceAnchor(
        "docs/guide.md",
        source,
        tablePending,
        tablePending + "pending".length,
      ),
    });

    const result = applyEditIntents(source, [intent]);

    expect(result.markdown).toBe(
      "# Status\n\n```txt\nstate = pending\n```\n\n| Item | State |\n| --- | --- |\n| job | ready |\n",
    );
    expect(() => unified().use(remarkParse).use(remarkGfm).parse(result.markdown)).not.toThrow();
  });

  it("appends within the target heading section before the next peer heading", () => {
    const source =
      "# Guide\n\nIntro.\n\n## One\n\nTarget.\n\n### Existing\n\nNested.\n\n## Two\n\nNext.\n";
    const result = applyEditIntents(source, [
      editIntent(source, "Target.", {
        operation: "append_section",
        markdown: "### Added\n\nExtra.\n\n",
      }),
    ]);

    expect(result.markdown).toBe(
      "# Guide\n\nIntro.\n\n## One\n\nTarget.\n\n### Existing\n\nNested.\n\n" +
        "### Added\n\nExtra.\n\n## Two\n\nNext.\n",
    );
    expect(result.unifiedDiff).toContain(" ## Two\n");
    expect(result.unifiedDiff).not.toContain("-## Two");
    expect(result.unifiedDiff).not.toContain("-Next.");
  });

  it("keeps the following line as context for a pure line-boundary insertion", () => {
    const source = "# One\n\nTarget.\n\n## Two\n\nNext.\n";
    const result = applyEditIntents(source, [
      editIntent(source, "Target.", {
        operation: "append_section",
        markdown: "## Added\n\nExtra.\n\n",
      }),
    ]);

    expect(result.markdown).toContain("## Two\n\nNext.\n");
    expect(result.unifiedDiff).toContain(" Next.\n");
    expect(result.unifiedDiff).not.toContain("-Next.");
  });

  it("rejects append_section when the anchor has no owning heading", () => {
    const source = "Preamble target.\n\n# Later\n\nBody.\n";
    const error = capturePatchError(
      () =>
        applyEditIntents(source, [
          editIntent(source, "target", {
            operation: "append_section",
            markdown: "## Added\n",
          }),
        ]),
      "APPEND_SECTION_TARGET_INVALID",
    );

    expect(error.conflicts).toEqual([
      {
        annotationId: "annotation-1",
        reason: "The append-section target has no unique owning Markdown heading.",
      },
    ]);
  });

  it("rejects append_section when the owning heading path is duplicated", () => {
    const source = "# Guide\n\n## Same\n\nFirst target.\n\n## Same\n\nSecond.\n";

    const error = capturePatchError(
      () =>
        applyEditIntents(source, [
          editIntent(source, "First target.", {
            operation: "append_section",
            markdown: "### Added\n\nExtra.\n\n",
          }),
        ]),
      "APPEND_SECTION_TARGET_INVALID",
    );

    expect(error.conflicts).toHaveLength(1);
  });

  it("rejects an edit whose relocated anchor is ambiguous", () => {
    const original = "same\n";
    const ambiguousSource = "same\n\nsame\n";
    const ambiguous = editIntent(original, "same");

    const error = capturePatchError(
      () => applyEditIntents(ambiguousSource, [ambiguous]),
      "ANCHOR_AMBIGUOUS",
    );

    expect(error.message).toMatch(/anchor.*ambiguous/i);
    expect(error.conflicts).toEqual([
      { annotationId: "annotation-1", reason: "The source anchor is ambiguous." },
    ]);
  });

  it("rejects an orphaned anchor rather than guessing a destination", () => {
    const original = "needle\n";
    const missing = editIntent(original, "needle");

    const error = capturePatchError(
      () => applyEditIntents("gone\n", [missing]),
      "ANCHOR_MISSING",
    );

    expect(error.conflicts).toEqual([
      { annotationId: "annotation-1", reason: "The source anchor is missing." },
    ]);
  });

  it("rejects an exact offset whose claimed heading path is inconsistent", () => {
    const source = "# Real\n\nTarget.\n";
    const intent = editIntent(source, "Target.");
    const forgedAnchor: SourceAnchor = {
      ...intent.targetAnchor,
      headingPath: ["Invented"],
    };

    capturePatchError(
      () => applyEditIntents(source, [{ ...intent, targetAnchor: forgedAnchor }]),
      "ANCHOR_HEADING_MISMATCH",
    );
  });

  it("merges byte-identical insertions at the same original offset", () => {
    const source = "# Guide\n\nTarget.\n";
    const first = editIntent(source, "Target.", {
      annotationId: "annotation-first",
      markdown: "\n\n> Shared.",
    });
    const second = editIntent(source, "Target.", {
      annotationId: "annotation-second",
      markdown: "\n\n> Shared.",
    });

    const result = applyEditIntents(source, [first, second]);

    expect(result.markdown).toBe("# Guide\n\nTarget.\n\n> Shared.\n");
    expect(result.appliedAnnotationIds).toEqual([
      "annotation-first",
      "annotation-second",
    ]);
  });

  it("fails closed with typed conflicts for contradictory same-point insertions", () => {
    const source = "# Guide\n\nTarget.\n";
    const first = editIntent(source, "Target.", {
      annotationId: "annotation-first",
      markdown: "\n\n> First.",
    });
    const second = editIntent(source, "Target.", {
      annotationId: "annotation-second",
      markdown: "\n\n> Second.",
    });

    const error = capturePatchError(
      () => applyEditIntents(source, [first, second]),
      "EDIT_CONFLICT",
    );

    expect(error.conflicts.map(({ annotationId }) => annotationId)).toEqual([
      "annotation-first",
      "annotation-second",
    ]);
  });

  it("reports every annotation participating in a transitive same-point conflict", () => {
    const source = "# Guide\n\nTarget.\n";
    const first = editIntent(source, "Target.", {
      annotationId: "annotation-a",
      markdown: "\n\n> Shared.",
    });
    const conflicting = editIntent(source, "Target.", {
      annotationId: "annotation-b",
      markdown: "\n\n> Different.",
    });
    const duplicate = editIntent(source, "Target.", {
      annotationId: "annotation-c",
      markdown: "\n\n> Shared.",
    });

    const error = capturePatchError(
      () => applyEditIntents(source, [first, conflicting, duplicate]),
      "EDIT_CONFLICT",
    );

    expect(error.conflicts.map(({ annotationId }) => annotationId)).toEqual([
      "annotation-a",
      "annotation-b",
      "annotation-c",
    ]);
  });

  it("fails closed for overlapping replacements, even when replacement bytes match", () => {
    const source = "# Guide\n\nabcdef.\n";
    const first = editIntent(source, "abcd", {
      annotationId: "annotation-first",
      operation: "replace",
      markdown: "same",
    });
    const second = editIntent(source, "bcde", {
      annotationId: "annotation-second",
      operation: "replace",
      markdown: "same",
    });

    const error = capturePatchError(
      () => applyEditIntents(source, [first, second]),
      "EDIT_CONFLICT",
    );

    expect(error.conflicts).toHaveLength(2);
  });

  it("rejects a replacement that rewrites the entire document", () => {
    const source = "Whole document.";
    const intent = editIntent(source, source, {
      operation: "replace",
      markdown: "Completely different document.",
    });

    const error = capturePatchError(
      () => applyEditIntents(source, [intent]),
      "WHOLE_DOCUMENT_REWRITE" as MarkdownPatchErrorCode,
    );

    expect(error.message).toMatch(/whole-document/i);
  });

  it("rejects adjacent replacements that collectively rewrite the entire document", () => {
    const source = "abcdef";
    const first = editIntent(source, "abc", {
      annotationId: "annotation-first",
      operation: "replace",
      markdown: "XXX",
    });
    const second = editIntent(source, "def", {
      annotationId: "annotation-second",
      operation: "replace",
      markdown: "YYY",
    });

    const error = capturePatchError(
      () => applyEditIntents(source, [first, second]),
      "WHOLE_DOCUMENT_REWRITE",
    );

    expect(error.conflicts.map(({ annotationId }) => annotationId)).toEqual([
      "annotation-first",
      "annotation-second",
    ]);
  });

  it("rejects a repeated annotation id before applying anything", () => {
    const source = "# Guide\n\nOne. Two.\n";
    const first = editIntent(source, "One.", { annotationId: "annotation-same" });
    const second = editIntent(source, "Two.", { annotationId: "annotation-same" });

    capturePatchError(
      () => applyEditIntents(source, [first, second]),
      "DUPLICATE_ANNOTATION_ID",
    );
  });

  it("rejects an operation outside the contracts enum at runtime", () => {
    const source = "# Guide\n\nTarget.\n";
    const invalid = {
      ...editIntent(source, "Target."),
      operation: "insert_before",
    } as unknown as EditIntent;

    capturePatchError(() => applyEditIntents(source, [invalid]), "INVALID_EDIT_INTENT");
  });

  it("rejects over-budget Markdown before attempting anchor relocation", () => {
    const original = "x\n";
    const intent = editIntent(original, "x");
    const overBudget = "x".repeat(256 * 1024 + 1);

    capturePatchError(
      () => applyEditIntents(overBudget, [intent]),
      "MARKDOWN_COMPLEXITY_BUDGET",
    );
  });
});

describe("defaultExplainedPath", () => {
  it("creates a safe sibling path for supported Markdown extensions", () => {
    expect(defaultExplainedPath("docs/guide.md")).toBe("docs/guide.explained.md");
    expect(defaultExplainedPath("docs/guide.markdown")).toBe("docs/guide.explained.md");
    expect(defaultExplainedPath("README.MD")).toBe("README.explained.md");
  });

  it.each([
    "",
    ".md",
    "docs/.md",
    "docs/guide.txt",
    "/docs/guide.md",
    "C:/docs/guide.md",
    "../guide.md",
    "docs/../guide.md",
    "docs\\guide.md",
  ])("rejects unsafe or non-Markdown path %s", (documentPath) => {
    capturePatchError(
      () => defaultExplainedPath(documentPath),
      "INVALID_DOCUMENT_PATH",
    );
  });
});
