import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalWebReaderApi } from "./web-gateway.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("local web reader API", () => {
  it("forwards arbitrary HTTP questions unchanged and never accepts a browser cross-origin caller", async () => {
    const startQuestion = vi.fn(async () => ({ runId: "run-live-1" }));
    const service = {
      listRoots: vi.fn(async () => [{ rootId: "root-live", workspaceLabel: "fixture" }]),
      listDocuments: vi.fn(async () => []),
      openDocument: vi.fn(async () => ({})),
      readSource: vi.fn(async () => ({})),
      captureSessionBinding: vi.fn(() => ({ status: "unavailable" })),
      createSessionFromBinding: vi.fn(async () => ({})),
      authorizeAccess: vi.fn(async () => undefined),
      startQuestion,
      pollQuestion: vi.fn(async () => ({})),
      cancelQuestion: vi.fn(async () => undefined),
      setDisposition: vi.fn(async () => undefined),
      preparePatch: vi.fn(async () => ({})),
      approvePatch: vi.fn(async () => ({})),
      writeExplained: vi.fn(async () => ({})),
    };
    const api = createLocalWebReaderApi({
      projectRoot: "C:\\fixture-project",
      service,
    });
    const server = createServer((request, response) => {
      void api.handle(request, response).then((handled) => {
        if (!handled) response.writeHead(404).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    const question = `网页问题-${crypto.randomUUID()}-中文\n第二行`;
    const response = await fetch(`${origin}/api/reader`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        name: "aimd_ask_start",
        arguments: {
          sessionId: "session-live",
          question: { question, startOffset: 3, endOffset: 6 },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      structuredContent: { job: { runId: "run-live-1" } },
    });
    expect(service.authorizeAccess).toHaveBeenCalledWith(
      { kind: "session", id: "session-live" },
      [{ uri: expect.stringMatching(/^file:/u) }],
    );
    expect(startQuestion).toHaveBeenCalledWith("session-live", {
      question,
      startOffset: 3,
      endOffset: 6,
    });

    const rejected = await fetch(`${origin}/api/reader`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ name: "aimd_list_roots", arguments: {} }),
    });
    expect(rejected.status).toBe(403);
    expect(service.listRoots).not.toHaveBeenCalled();
  });
});
