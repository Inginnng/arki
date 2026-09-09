import { describe, expect, it } from "vitest";

import { initialReaderState, readerReducer, type ReaderState } from "./state.js";

const selection = { startOffset: 4, endOffset: 11, renderedText: "gateway" };
const document = { path: "README.md", hash: "a".repeat(64), markdown: "# Guide", headings: [], anchorStatus: { status: "available" as const } };

function preparedState(): ReaderState {
  return {
    ...initialReaderState,
    rootId: "root-1",
    document,
    selection,
    patch: { id: "preview-1", sessionId: "session-1", status: "ready", sourcePath: "README.md", targetPath: "README.explained.md", sourceHash: "a".repeat(64), resultHash: "b".repeat(64), diffHash: "c".repeat(64), markdown: "# Guide\n\nMore", unifiedDiff: "+More", annotationIds: ["run-1"], conflicts: [] },
    approvalToken: "token",
  };
}

describe("readerReducer", () => {
  it("keeps one continuous annotation thread per stable selection", () => {
    let state = readerReducer({ ...initialReaderState, document }, { type: "selection_captured", selection });
    state = readerReducer(state, { type: "question_started", runId: "run-1", question: "What is this?", selection, documentPath: document.path });
    state = readerReducer(state, { type: "question_finished", runId: "run-1", status: "completed" });
    state = readerReducer(state, { type: "question_started", runId: "run-2", question: "Why?", selection, documentPath: document.path });
    expect(state.annotations).toHaveLength(1);
    expect(state.annotations[0]?.questions.map((question) => question.question)).toEqual(["What is this?", "Why?"]);
  });

  it("represents pending, progress, reviewed, stale, unsupported, cancelled, and error outcomes", () => {
    let state = readerReducer({ ...initialReaderState, document }, { type: "selection_captured", selection });
    state = readerReducer(state, { type: "question_started", runId: "run-1", question: "Explain", selection, documentPath: document.path });
    expect(state.annotations[0]?.questions[0]?.status).toBe("queued");
    state = readerReducer(state, { type: "question_progress", runId: "run-1", status: "validating", message: "Reviewing evidence" });
    expect(state.annotations[0]?.questions[0]).toMatchObject({ status: "validating", message: "Reviewing evidence" });
    for (const status of ["completed", "stale", "unsupported", "cancelled", "failed"] as const) {
      state = readerReducer(state, { type: "question_finished", runId: "run-1", status });
      expect(state.annotations[0]?.questions[0]?.status).toBe(status);
    }
  });

  it("changes disposition and marks relocated failures as orphaned", () => {
    let state = readerReducer({ ...initialReaderState, document }, { type: "selection_captured", selection });
    state = readerReducer(state, { type: "question_started", runId: "run-1", question: "Explain", selection, documentPath: document.path });
    state = readerReducer(state, { type: "disposition_changed", annotationId: "run-1", disposition: "inline" });
    state = readerReducer(state, { type: "anchor_orphaned", annotationId: "run-1" });
    expect(state.annotations[0]).toMatchObject({ disposition: "inline", orphaned: true });
  });

  it("invalidates a prepared patch and approval when the document hash changes", () => {
    const state = readerReducer(preparedState(), {
      type: "document_loaded",
      document: { path: "README.md", hash: "d".repeat(64), markdown: "# Changed", headings: [], anchorStatus: { status: "available" } },
    });
    expect(state.patch).toBeNull();
    expect(state.approvalToken).toBeNull();
    expect(state.notice).toContain("文档已更改");
  });

  it("does not carry annotations or source evidence into another document", () => {
    let prepared = readerReducer(preparedState(), { type: "question_started", runId: "run-1", question: "Explain", selection, documentPath: document.path });
    prepared = { ...prepared, sourcePeek: { path: "src/a.ts", startLine: 1, endLine: 1, totalLines: 1, lines: [{ line: 1, text: "a" }], excerpt: "a", fileHash: "e".repeat(64), truncated: false } };
    const state = readerReducer(prepared, {
      type: "document_loaded",
      document: { path: "docs/other.md", hash: "f".repeat(64), markdown: "# Other", headings: [], anchorStatus: { status: "available" } },
    });
    expect(state.annotations).toEqual([]);
    expect(state.sourcePeek).toBeNull();
    expect(state.patch).toBeNull();
  });

  it("keeps patch conflicts explicit and invalidates approval on any new preview", () => {
    const state = readerReducer(preparedState(), {
      type: "patch_prepared",
      patch: { ...preparedState().patch!, id: "preview-2", status: "conflict", conflicts: [{ annotationId: "run-1", reason: "overlap" }] },
    });
    expect(state.patch?.status).toBe("conflict");
    expect(state.approvalToken).toBeNull();
  });

  it("rejects a late question start from another document", () => {
    const state = readerReducer(preparedState(), {
      type: "question_started",
      runId: "run-late",
      question: "Explain",
      selection,
      documentPath: "docs/other.md",
    });
    expect(state.annotations).toEqual([]);
    expect(state.notice).toContain("文档已切换");
  });
});
