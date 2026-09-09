import { describe, expect, it, vi } from "vitest";

import { createReaderHost, ReaderHostError, type ReaderAppPort } from "./host.js";

const failedPage = {
  outcome: "events" as const,
  runId: "run-1",
  generation: "generation-1",
  cursor: null,
  nextCursor: { runId: "run-1", generation: "generation-1", sequence: 1 },
  events: [{ runId: "run-1", generation: "generation-1", sequence: 1, createdAt: "2026-09-01T00:00:00.000Z", type: "failed" as const, payload: { status: "failed" as const, code: "QUESTION_FAILED", message: "Question failed safely.", retryable: true } }],
};

function port(results: unknown[]): ReaderAppPort & { calls: Array<{ name: string; arguments: unknown }> } {
  const calls: Array<{ name: string; arguments: unknown }> = [];
  return {
    calls,
    connect: vi.fn(async () => undefined),
    requestDisplayMode: vi.fn(async () => ({ mode: "inline" })),
    callServerTool: vi.fn(async ({ name, arguments: input }) => {
      calls.push({ name, arguments: input });
      return results.shift() as never;
    }),
  };
}

describe("ReaderHost", () => {
  it("maps tool names and validates structured outputs", async () => {
    const app = port([{ structuredContent: { roots: [{ rootId: "root-1", workspaceLabel: "Fixture" }] }, content: [] }]);
    const host = createReaderHost(app, { sleep: async () => undefined });
    await host.connect();
    await expect(host.call("aimd_list_roots", {})).resolves.toEqual({ roots: [{ rootId: "root-1", workspaceLabel: "Fixture" }] });
    expect(app.calls).toEqual([{ name: "aimd_list_roots", arguments: {} }]);
  });

  it("treats fullscreen rejection as a presentation fallback", async () => {
    const app = port([]);
    app.requestDisplayMode = vi.fn(async () => { throw new Error("unsupported"); });
    await expect(createReaderHost(app).requestFullscreen()).resolves.toBeUndefined();
  });

  it("opens a bounded source peek through aimd_read_source", async () => {
    const app = port([{ structuredContent: { source: { path: "src/gateway.ts", startLine: 8, endLine: 10, totalLines: 40, lines: [{ line: 8, text: "export const gateway = true;" }], excerpt: "8: export const gateway = true;", fileHash: "a".repeat(64), truncated: false } }, content: [] }]);
    const host = createReaderHost(app);
    await expect(host.openSource("root-1", "src/gateway.ts", 8)).resolves.toMatchObject({ path: "src/gateway.ts", startLine: 8 });
    expect(app.calls[0]).toMatchObject({ name: "aimd_read_source", arguments: { rootId: "root-1", path: "src/gateway.ts", startLine: 8 } });
  });

  it("reconnects polling from the last cursor and cancels when aborted", async () => {
    const transient = Promise.reject(new Error("transport reset"));
    transient.catch(() => undefined);
    const app = port([
      transient,
      { structuredContent: { page: failedPage }, content: [] },
      { structuredContent: { status: "cancelled" }, content: [] },
    ]);
    const host = createReaderHost(app, { sleep: async () => undefined });
    const controller = new AbortController();
    const pages: unknown[] = [];
    await host.watchQuestion("run-1", (page) => { pages.push(page); controller.abort(); }, controller.signal);
    expect(pages).toEqual([failedPage]);
    expect(app.calls.filter((call) => call.name === "aimd_question_events")).toHaveLength(2);
    expect(app.calls.at(-1)?.name).toBe("aimd_cancel_question");
  });

  it("normalizes host failures and never exposes a message-sending API", async () => {
    const app = port([{ isError: true, structuredContent: { error: { code: "ROOT_NOT_FOUND", message: "safe" } }, content: [] }]);
    const host = createReaderHost(app);
    await expect(host.call("aimd_list_roots", {})).rejects.toEqual(new ReaderHostError("ROOT_NOT_FOUND", "safe"));
    expect(host).not.toHaveProperty("sendFollowUpMessage");
    expect(host).not.toHaveProperty("sendMessage");
  });
});
