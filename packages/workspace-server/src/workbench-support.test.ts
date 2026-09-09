import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createLocalWebReaderApi } from "./web-gateway.js";
import type { ReaderMcpService } from "./mcp.js";
import { createSideQuestionService } from "./side-question-service.js";
import { openReadOnlyWorkspaceForTesting } from "./workspace.js";

it("keeps collection identity across server restarts while isolating projects and hiding paths", async () => {
  const roots = async (projectRoot: string, rootId: string) => {
    const service = { listRoots: async () => [{ rootId, workspaceLabel: "same-label" }] } as unknown as ReaderMcpService;
    const result = await createLocalWebReaderApi({ projectRoot, service }).dispatch({ name: "aimd_list_roots", arguments: {} });
    return result.structuredContent.roots as { rootId: string; storageKey: string }[];
  };
  const first = await roots("C:\\projects\\one", "root-before");
  const restarted = await roots("C:\\projects\\one", "root-after");
  const other = await roots("C:\\projects\\two", "root-third");
  expect(first[0]!.rootId).not.toBe(restarted[0]!.rootId);
  expect(first[0]!.storageKey).toBe(restarted[0]!.storageKey);
  expect(first[0]!.storageKey).not.toBe(other[0]!.storageKey);
  expect(first[0]!.storageKey).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(first)).not.toMatch(/projects|C:/u);
});

it("retrieves current code for a Chinese architecture question even when document terms do not name it", async () => {
  const root = await mkdtemp(join(tmpdir(), "aimd-architecture-"));
  try {
    await writeFile(join(root, "README.md"), "# 程序说明\n\n此项目接收请求。\n");
    await writeFile(join(root, "entry.ts"), "import { createServer } from 'node:http';\nexport const server = createServer();\n");
    const workspace = await openReadOnlyWorkspaceForTesting(root);
    const doc = await workspace.readDocumentSource("README.md");
    const run = vi.fn(async (_handle: string, request: { question: string }) => {
      const packet = JSON.parse(request.question);
      const code = packet.evidence.find((item: { path: string }) => item.path === "entry.ts");
      expect(code).toBeDefined();
      return { concept: "", projectClaims: [{ statement: "入口创建 HTTP 服务。", evidenceIds: [code.id] }], taskDiscussion: "", unknowns: ["尚未覆盖其他模块。"] };
    });
    const runtime = { run, listTasks: vi.fn(), selectTask: vi.fn() };
    const service = createSideQuestionService({ workspace, runtime });
    const result = await service.ask({ selectionHandle: "selected-task", documentPath: "README.md", documentHash: doc.hash, startOffset: 0, endOffset: doc.source.length, question: "分析程序的模块职责与调用流程。" });
    expect(run).toHaveBeenCalledOnce();
    expect(result.evidence.some(item => item.path === "entry.ts")).toBe(true);
    expect(result.retrievalTruncated).toBe(true);
    expect(result.evidence.length).toBeLessThanOrEqual(8);
  } finally { await rm(root, { recursive: true, force: true }); }
});
