import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openReadOnlyWorkspaceForTesting } from "./workspace.js";
import { createSideQuestionService } from "./side-question-service.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aimd-side-service-")); dirs.push(root);
  await writeFile(join(root, "README.md"), "# Reader\n\nMCP connects tools.\n");
  await writeFile(join(root, "server.ts"), "export const MCP_TRANSPORT = 'stdio';\n");
  const workspace = await openReadOnlyWorkspaceForTesting(root);
  const doc = await workspace.readDocumentSource("README.md");
  const run = vi.fn(async (_handle: string, request: { question: string }) => {
    const packet = JSON.parse(request.question);
    return { concept: "MCP 是模型上下文协议。", projectClaims: [{ statement: "文档描述 MCP 连接工具。", evidenceIds: [packet.evidence[0].id] }], taskDiscussion: "任务片段未提供额外决定。", unknowns: [] };
  });
  const runtime = { listTasks: vi.fn(async () => []), selectTask: vi.fn(async () => ({ handle: "selected-1", title: "test", cutoffLabel: "固定截止", historyTruncated: false })), run };
  const service = createSideQuestionService({ workspace, runtime });
  const input = { selectionHandle: "selected-1", documentPath: "README.md", documentHash: doc.hash, startOffset: 10, endOffset: 13, question: "MCP 是什么？" };
  return { service, input, run, root, workspace };
}
describe("side question evidence boundary", () => {
  it("locates selected evidence correctly in CR-only Markdown", async () => {
    const { service, input, root, workspace } = await fixture();
    const source = Array.from({ length: 10 }, (_, i) => "paragraph " + i).join("\r") + "\rMCP selected paragraph.\r";
    await writeFile(join(root, "README.md"), source);
    const doc = await workspace.readDocumentSource("README.md");
    const startOffset = source.indexOf("MCP");
    const result = await service.ask({ ...input, documentHash: doc.hash, startOffset, endOffset: startOffset + 3 });
    expect(result.evidence[0]?.startLine).toBe(6);
    expect(result.evidence[0]?.excerpt).toContain("11: MCP selected paragraph.");
  });
  it("rejects a document changed between selection read and evidence read", async () => {
    const { service, input, run, root, workspace } = await fixture();
    const read = workspace.readDocumentSource.bind(workspace);
    vi.spyOn(workspace, "readDocumentSource").mockImplementationOnce(async path => {
      const doc = await read(path);
      await writeFile(join(root, "README.md"), "# Reader\n\nMCP changed tools.\n");
      return doc;
    });
    await expect(service.ask(input)).rejects.toMatchObject({ code: "SIDE_SOURCE_CHANGED" });
    expect(run).not.toHaveBeenCalled();
  });
  it("discloses discarded retrieval terms", async () => {
    const { service, input, workspace } = await fixture();
    vi.spyOn(workspace, "searchProject").mockResolvedValue({ query: "fixture", matches: [], inspectedPaths: [], truncated: false });
    const result = await service.ask({ ...input, question: "alpha bravo charlie delta echo" });
    expect(result.retrievalTruncated).toBe(true);
  });
  it("uses real current project excerpts and returns only issued citations", async () => {
    const { service, input, run } = await fixture();
    const result = await service.ask(input);
    expect(result.answer.concept).toContain("模型上下文协议");
    expect(result.reviewStatus).toBe("citation_validated");
    expect(result.evidence[0]).toMatchObject({ path: "README.md", startLine: 1 });
    expect(JSON.stringify(result)).not.toContain("taskId");
    expect(run).toHaveBeenCalledOnce();
  });
  it("rejects stale documents before invoking the model", async () => {
    const { service, input, run } = await fixture();
    await expect(service.ask({ ...input, documentHash: "0".repeat(64) })).rejects.toMatchObject({ code: "SIDE_SOURCE_CHANGED" });
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects invented evidence references", async () => {
    const { service, input, run } = await fixture();
    run.mockResolvedValueOnce({ concept: "concept", projectClaims: [{ statement: "invented", evidenceIds: ["not-issued"] }], taskDiscussion: "", unknowns: [] });
    await expect(service.ask(input)).rejects.toMatchObject({ code: "SIDE_OUTPUT_INVALID" });
  });
  it("rejects citations if files change while the model runs", async () => {
    const { service, input, run, root } = await fixture();
    const original = run.getMockImplementation()!;
    run.mockImplementationOnce(async (handle, request) => { const answer = await original(handle, request); await writeFile(join(root, "README.md"), "changed"); return answer; });
    await expect(service.ask(input)).rejects.toMatchObject({ code: "SIDE_SOURCE_CHANGED" });
  });
  it("rejects path traversal and invalid selection offsets", async () => {
    const { service, input, run } = await fixture();
    await expect(service.ask({ ...input, documentPath: "../secret.md" })).rejects.toBeDefined();
    await expect(service.ask({ ...input, endOffset: 9999 })).rejects.toMatchObject({ code: "SIDE_SELECTION_INVALID" });
    expect(run).not.toHaveBeenCalled();
  });
});
