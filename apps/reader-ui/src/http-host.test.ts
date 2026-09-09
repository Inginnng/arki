import { describe, expect, it, vi } from "vitest";

import { createHttpReaderHost } from "./http-host.js";
import { ReaderHostError } from "./host.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("HTTP ReaderHost", () => {
  it("checks local health before forwarding an arbitrary Chinese question unchanged", async () => {
    const question = "MCP 到底是什么？请保留随机标记：甲-7f3c-乙。";
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (fetcher.mock.calls.length === 1) return jsonResponse({ ok: true, backend: "codex_cli" });
      return jsonResponse({ structuredContent: { job: { runId: "run-http-1" } }, content: [] });
    });
    const host = createHttpReaderHost({ fetch: fetcher });

    await host.connect();
    await expect(host.call("aimd_ask_start", {
      sessionId: "session-http-1",
      question: { question, startOffset: 12, endOffset: 15 },
    })).resolves.toEqual({ job: { runId: "run-http-1" } });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]).toEqual(["/api/health", expect.objectContaining({ method: "GET" })]);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/reader");
    const request = fetcher.mock.calls[1]?.[1];
    expect(request).toEqual(expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    }));
    expect(JSON.parse(String(request?.body))).toEqual({
      name: "aimd_ask_start",
      arguments: {
        sessionId: "session-http-1",
        question: { question, startOffset: 12, endOffset: 15 },
      },
    });
  });

  it("maps a failed health check to a stable error without exposing response details", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("internal path: D:\\secret", { status: 503 }));
    const host = createHttpReaderHost({ fetch: fetcher });

    const error = await host.connect().catch((reason: unknown) => reason);

    expect(error).toEqual(new ReaderHostError("LOCAL_BACKEND_UNAVAILABLE"));
    expect(String(error)).not.toContain("secret");
  });

  it("maps malformed tool responses to the existing safe transport error", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ debug: "D:\\secret\\stack.ts" }));
    const host = createHttpReaderHost({ fetch: fetcher });

    await expect(host.call("aimd_list_roots", {})).rejects.toEqual(new ReaderHostError("HOST_TRANSPORT_UNAVAILABLE"));
  });
});
