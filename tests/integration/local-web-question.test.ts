import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCodexCliBridge,
  createLocalWebReaderApi,
  createProductionReaderService,
} from "../../packages/workspace-server/src/index.js";
import { sha256Text } from "../../packages/reader-core/src/index.js";

const directories: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local web question flow", () => {
  it("carries an arbitrary browser question through the production service to the runner", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "aimd-web-project-"));
    const dataRoot = await mkdtemp(join(tmpdir(), "aimd-web-data-"));
    directories.push(projectRoot, dataRoot);
    const markdown = "# MCP\n\nMCP 是模型上下文协议。\n";
    await writeFile(join(projectRoot, "README.md"), markdown, "utf8");
    const observedQuestions: string[] = [];
    const runner = {
      name: "recording-codex",
      runStructured: vi.fn(async (turn: { text: string }) => {
        const envelope = JSON.parse(turn.text) as {
          payload: {
            question: string;
            untrustedEvidencePacket: { evidence: Array<{ id: string }> };
          };
        };
        observedQuestions.push(envelope.payload.question);
        return {
          kind: "answer",
          answer: {
            conclusionClaimId: "claim-web",
            claims: [{
              id: "claim-web",
              statement: `runner-observed:${sha256Text(envelope.payload.question)}`,
              category: "document_literal",
              evidenceIds: [envelope.payload.untrustedEvidencePacket.evidence[0]!.id],
            }],
            unknowns: [],
          },
        };
      }),
    };
    const service = createProductionReaderService({
      environment: {},
      userDataBaseDir: dataRoot,
      connectBridge: async (input) => ({
        bridge: createCodexCliBridge({
          canonicalRoot: input.canonicalRoot,
          rootId: input.workspaceSnapshot.publicSnapshot.rootId,
          workspaceLabel: input.workspaceLabel,
          runner,
        }),
        resolveTaskWorkspace: async () => ({ status: "unavailable" }),
        close: async () => undefined,
      }),
      writer: {
        capability: async () => ({ status: "unavailable", code: "SAFE_WRITE_UNAVAILABLE" }),
        createExplainedSibling: async () => { throw new Error("SAFE_WRITE_UNAVAILABLE"); },
      },
    });
    const api = createLocalWebReaderApi({ projectRoot, service });
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
    const call = async (name: string, args: unknown) => {
      const response = await fetch(`${origin}/api/reader`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ name, arguments: args }),
      });
      return await response.json() as { isError?: boolean; structuredContent: Record<string, unknown> };
    };

    const rootsResult = await call("aimd_list_roots", {});
    const rootId = (rootsResult.structuredContent.roots as Array<{ rootId: string }>)[0]!.rootId;
    const sessionResult = await call("aimd_create_session", { rootId, path: "README.md" });
    const sessionId = (sessionResult.structuredContent.session as { id: string }).id;
    const question = `MCP 如何连接本地 Agent？-${crypto.randomUUID()}\n请结合选区解释`;
    const startOffset = markdown.indexOf("MCP 是模型");
    const start = await call("aimd_ask_start", {
      sessionId,
      question: { question, startOffset, endOffset: startOffset + 3 },
    });
    const runId = (start.structuredContent.job as { runId: string }).runId;

    let answer: { claims: Array<{ statement: string }>; reviewStatus: string } | undefined;
    for (let attempt = 0; attempt < 100 && !answer; attempt += 1) {
      const poll = await call("aimd_question_events", { runId });
      const page = poll.structuredContent.page as { outcome: string; events?: Array<{ type: string; payload: { answer?: typeof answer } }> };
      const completed = page.events?.find((event) => event.type === "completed");
      answer = completed?.payload.answer;
      if (!answer) await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(observedQuestions).toEqual([question]);
    expect(runner.runStructured).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({
      reviewStatus: "citation_validated",
      claims: [{ statement: `runner-observed:${sha256Text(question)}` }],
    });
    await service.close();
  });
});
