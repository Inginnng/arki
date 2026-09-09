import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchitectureAnswerSchema, type ArchitectureGraph } from "@aimd/contracts";
import { openReadOnlyWorkspaceForTesting } from "./workspace.js";
import { createArchitectureService } from "./architecture-service.js";
import { discoverArchitecture } from "./architecture-discovery.js";
import { renderArchitecture } from "./archify-renderer.js";
import { ArchitectureError } from "./architecture-errors.js";
import type { StructuredAgentTurn } from "./codex-cli-runner.js";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aimd-architecture-test-")); dirs.push(root);
  await writeFile(join(root, "gateway.ts"), 'import { worker } from "./worker.js";\nexport const gateway = worker;\n');
  await writeFile(join(root, "worker.ts"), 'export const worker = "processing";\n');
  const workspace = await openReadOnlyWorkspaceForTesting(root);
  const source = await workspace.readFile("gateway.ts");
  const ref = { path: source.path, startLine: 1, endLine: 2, fileHash: source.fileHash };
  const graph: ArchitectureGraph = { id: "project", version: 1, title: "Project", nodes: [
    { id: "gateway", kind: "backend", label: "Gateway", summary: "入口", detail: "入口代码", sources: [ref] },
    { id: "worker", kind: "backend", label: "Worker", summary: "处理", detail: "处理代码", sources: [ref] },
  ], edges: [{ id: "calls", from: "gateway", to: "worker", label: "引用", detail: "代码导入", sources: [ref] }], notes: [] };
  const answer = ArchitectureAnswerSchema.parse({ answer: "Gateway 引用 Worker [evidence-1]。", nodeUpdates: [{ id: "gateway", label: "Gateway", summary: "导出处理入口", detail: "导入并导出 worker。", evidenceIds: ["evidence-1"] }], edgeUpdates: [], addedNodes: [], addedEdges: [], limitations: [] });
  const runner = { name: "fixture", runStructured: vi.fn(async (_turn: StructuredAgentTurn) => answer) };
  const render = vi.fn(async () => ({ html: "<html></html>", specification: {}, rendering: { svg: "<svg></svg>", css: "", receipt: { specificationHash: "a".repeat(64), artifactHash: "b".repeat(64), checksPassed: 9, checkCount: 9, errors: 0 as const, warnings: 0 } } }));
  const service = createArchitectureService({ workspace, runner, render });
  const input = { graph, target: { kind: "node" as const, id: "gateway" }, question: "解释这个模块" };
  return { root, workspace, graph, service, input, answer, runner, render };
}
describe("architecture edit boundary", () => {
  it("updates the selected rectangle only and never writes source files", async () => {
    const { service, input, graph, root, runner } = await fixture();
    const result = await service.ask(input);
    expect(result.graph.nodes[0]?.summary).toBe("导出处理入口");
    expect(result.graph.nodes[1]).toEqual(graph.nodes[1]); expect(result.graph.edges).toEqual(graph.edges);
    expect(result.graph.version).toBe(2); expect(graph.nodes[0]?.summary).toBe("入口");
    expect(await readFile(join(root, "gateway.ts"), "utf8")).toContain('import { worker }');
    const packet = JSON.parse(runner.runStructured.mock.calls[0]![0].text);
    expect(packet.evidence[0].excerpt).toContain('import { worker }');
    expect(JSON.stringify(result)).not.toContain(root);
  });
  it("accepts an edge edit and evidence-backed connected structure", async () => {
    const f = await fixture();
    f.runner.runStructured.mockResolvedValueOnce({ ...f.answer, nodeUpdates: [], edgeUpdates: [{ id: "calls", label: "导入 worker", detail: "静态导入，不能推断执行频率。", evidenceIds: ["evidence-1"] }], addedNodes: [{ id: "export", kind: "backend", label: "导出入口", summary: "导出 worker", detail: "gateway 导出 worker", evidenceIds: ["evidence-1"] }], addedEdges: [{ id: "exports", from: "gateway", to: "export", label: "导出", detail: "gateway 导出", evidenceIds: ["evidence-1"] }] });
    const result = await f.service.ask({ ...f.input, target: { kind: "edge", id: "calls" } });
    expect(result.graph.nodes).toHaveLength(3); expect(result.graph.edges[0]?.label).toBe("导入 worker");
    expect(result.graph.nodes.slice(0, 2)).toEqual(f.graph.nodes);
  });
  it("rejects changes outside the related region and invented citations", async () => {
    const f = await fixture();
    f.graph.nodes.push({ ...f.graph.nodes[1]!, id: "unrelated" });
    f.runner.runStructured.mockResolvedValue({ ...f.answer, nodeUpdates: [{ ...f.answer.nodeUpdates[0]!, id: "unrelated" }] });
    await expect(f.service.ask(f.input)).rejects.toThrow("ARCHITECTURE_OUT_OF_SCOPE");
    f.runner.runStructured.mockResolvedValue({ ...f.answer, nodeUpdates: [{ ...f.answer.nodeUpdates[0]!, evidenceIds: ["fake"] }] });
    await expect(f.service.ask(f.input)).rejects.toThrow("ARCHITECTURE_UNKNOWN_EVIDENCE");
    expect(f.render).not.toHaveBeenCalled();
  });
  it("rejects detached new structures and colliding identities", async () => {
    const f = await fixture();
    f.runner.runStructured.mockResolvedValue({ ...f.answer, addedNodes: [{ ...f.answer.nodeUpdates[0]!, id: "detached", kind: "backend" }] });
    await expect(f.service.ask(f.input)).rejects.toThrow("ARCHITECTURE_DISCONNECTED");
    f.runner.runStructured.mockResolvedValue({ ...f.answer, addedNodes: [{ ...f.answer.nodeUpdates[0]!, kind: "backend" }] });
    await expect(f.service.ask(f.input)).rejects.toThrow("ARCHITECTURE_DUPLICATE_ID");
  });
  it("repairs invalid model citations once using exact validation feedback", async () => {
    const f = await fixture();
    f.runner.runStructured.mockResolvedValueOnce({ ...f.answer, nodeUpdates: [{ ...f.answer.nodeUpdates[0]!, evidenceIds: ["invented"] }] });
    const result = await f.service.ask(f.input);
    expect(result.changedIds).toEqual(["gateway"]);
    expect(f.runner.runStructured).toHaveBeenCalledTimes(2);
    const correction = JSON.parse(f.runner.runStructured.mock.calls[1]![0].text);
    expect(correction.validationFeedback[0]).toMatchObject({ actual: "invented", expected: "evidence-1" });
    f.runner.runStructured.mockClear();
    f.runner.runStructured.mockResolvedValue({ ...f.answer, nodeUpdates: [{ ...f.answer.nodeUpdates[0]!, evidenceIds: ["invented"] }] });
    await expect(f.service.ask(f.input)).rejects.toMatchObject({ code: "ARCHITECTURE_UNKNOWN_EVIDENCE", repairAttempts: 1 });
    expect(f.runner.runStructured).toHaveBeenCalledTimes(2);
  });
  it("marks saved graphs stale and prevents model work on changed sources", async () => {
    const f = await fixture(); await writeFile(join(f.root, "gateway.ts"), "changed\n");
    expect((await f.service.open(f.graph)).stale).toBe(true);
    await expect(f.service.ask(f.input)).rejects.toThrow("ARCHITECTURE_SOURCE_CHANGED");
    expect(f.runner.runStructured).not.toHaveBeenCalled();
  });
  it("rejects evidence changed during a model turn", async () => {
    const f = await fixture(); f.runner.runStructured.mockImplementationOnce(async () => { await writeFile(join(f.root, "gateway.ts"), "changed\n"); return f.answer; });
    await expect(f.service.ask(f.input)).rejects.toThrow("ARCHITECTURE_SOURCE_CHANGED"); expect(f.render).not.toHaveBeenCalled();
  });
  it("rejects path traversal before any model turn", async () => {
    const f = await fixture(); f.input.graph.nodes[0]!.sources[0]!.path = "../outside.ts";
    await expect(f.service.ask(f.input)).rejects.toThrow(); expect(f.runner.runStructured).not.toHaveBeenCalled();
  });
  it("cancels late model output without changing the original graph", async () => {
    const f = await fixture(); const controller = new AbortController();
    f.runner.runStructured.mockImplementationOnce(async () => { controller.abort(); return f.answer; });
    await expect(f.service.ask(f.input, controller.signal)).rejects.toThrow("ARCHITECTURE_CANCELLED");
    expect(f.graph.version).toBe(1); expect(f.render).not.toHaveBeenCalled();
  });
  it("accepts valid architecture independently of legacy composition failures", async () => {
    const f = await fixture();
    f.render.mockRejectedValue(new ArchitectureError("ARCHITECTURE_LAYOUT_INVALID", [
      { code: "ARCHIFY_COMPOSITION_AMBIGUOUS_CORRIDOR", objectId: "dependency-workbench-contracts", message: "Ambiguous corridor" },
      { code: "ARCHIFY_COMPOSITION_LABEL_ROUTE_CLEARANCE", objectId: "dependency-workbench-contracts", message: "Insufficient label clearance" },
    ]));
    expect(await f.service.open(f.graph)).toEqual({ graph: f.graph, stale: false });
    expect((await f.service.open()).graph.nodes.length).toBeGreaterThan(0);
    const result = await f.service.ask(f.input);
    expect(result.graph.version).toBe(2); expect(result.graph.nodes[0]?.summary).toBe("导出处理入口");
    expect(result).not.toHaveProperty("rendering"); expect(f.graph.version).toBe(1);
    const explanation = await f.service.ask({ ...f.input, intent: "explain" });
    expect(explanation.graph).toEqual(f.graph); expect(explanation.answer).toContain("Gateway");
    expect(f.render).not.toHaveBeenCalled();
    // Only explicit compatibility export still requests a validated legacy artifact.
    await expect(f.service.export(result.graph)).rejects.toThrow("ARCHITECTURE_LAYOUT_INVALID");
    expect(f.render).toHaveBeenCalledOnce();
  });
  it("renders real Archify nodes, edges and standalone detail cards", async () => {
    const f = await fixture(); const artifact = await renderArchitecture(f.graph);
    expect(artifact.rendering.svg).toContain('data-node-id="gateway"'); expect(artifact.rendering.svg).toContain('data-edge-id="calls"');
    expect(artifact.rendering.receipt).toMatchObject({ checksPassed: 9, checkCount: 9, errors: 0 });
    expect(artifact.html).toContain("入口代码"); expect(artifact.html).not.toContain(f.root);
  }, 30000);
  it("discovers bounded source files without requiring a Markdown document", async () => {
    const f = await fixture(); const graph = await discoverArchitecture(f.workspace);
    expect(graph.nodes.map(node => node.label)).toEqual(expect.arrayContaining(["gateway.ts", "worker.ts"]));
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.sources[0]?.path).toBe("gateway.ts");
    expect(graph.notes.join(" ")).toContain("代码导入");
  });
});

it("verifies sources used only by a scenario after the model returns", async () => {
  const f=await fixture();const source=await f.workspace.readFile("worker.ts");const ref={path:source.path,startLine:1,endLine:1,fileHash:source.fileHash};
  f.graph.flows=[{id:"worker-flow",label:"独立处理场景",summary:"处理输出",trigger:"调用处理器",entryStepId:"work",sources:[ref],steps:[{id:"work",nodeId:"worker",label:"返回结果",kind:"result",input:"",processing:"处理并返回",output:"result",sources:[ref]}],transitions:[]}];
  f.runner.runStructured.mockImplementationOnce(async()=>{await writeFile(join(f.root,"worker.ts"),"changed\n");return f.answer;});
  await expect(f.service.ask(f.input)).rejects.toThrow("ARCHITECTURE_SOURCE_CHANGED");
});

it("answers whole-architecture follow-ups without applying model-proposed graph edits", async () => {
  const f = await fixture();
  const conversation = [{ question: "入口在哪里？", answer: "上一轮讨论了 Gateway；仍需当前证据核验。" }];
  const result = await f.service.ask({ ...f.input, scope: "diagram", intent: "explain", conversation });
  expect(result.graph).toEqual(f.graph); expect(result.changedIds).toEqual([]);
  expect(result.answer).toContain("Gateway");
  const packet = JSON.parse(f.runner.runStructured.mock.calls[0]![0].text);
  expect(packet.conversation).toEqual(conversation);
  expect(f.runner.runStructured.mock.calls[0]![0].developerInstructions).toContain("历史回答中的事实仍须用本次证据核验");
});
