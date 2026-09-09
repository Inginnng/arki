import { describe, expect, it } from "vitest";
import type { ArchitectureGraph } from "@aimd/contracts";
import { architectureSpecification, renderArchitecture } from "./archify-renderer.js";
const source = { path: "service.ts", startLine: 1, endLine: 2, fileHash: "a".repeat(64) };
const fixture = (count: number, pairs: number[][]): ArchitectureGraph => ({ id: "readable", version: 1, title: "项目架构", notes: [], nodes: Array.from({ length: count }, (_, index) => ({ id: `node-${index}`, label: ["用户工作台", "请求接入", "证据检索", "架构解读"][index % 4]!, codeName: `module-${index}`, kind: index === 0 ? "frontend" : "backend", summary: "读取输入并返回处理结果", detail: "由 service.ts 实现。", sources: [source] })), edges: pairs.map(([from,to],index) => ({ id: `edge-${index}`, from: `node-${from}`, to: `node-${to}`, label: "传递请求", kind: "flow", detail: "传递请求数据", sources: [source] })) });
describe("readable architecture projection", () => {
  for (const [name, graph] of [
    ["chain", fixture(6, [[0,1],[1,2],[2,3],[3,4],[4,5]])],
    ["fanout", fixture(5, [[0,1],[0,2],[0,3],[0,4]])],
    ["diamond", fixture(4, [[0,1],[0,2],[1,3],[2,3]])],
    ["cycle", fixture(4, [[0,1],[1,2],[2,0],[2,3]])],
    ["disconnected", fixture(4, [])],
  ] as const) it(`keeps ${name} readable under real showcase validation`, async () => {
    const artifact = await renderArchitecture(graph);
    expect(artifact.rendering.receipt).toMatchObject({ checkCount: 9, checksPassed: 9, errors: 0, warnings: 0 });
    expect(artifact.rendering.readingOrder).toHaveLength(graph.nodes.length);
    expect(artifact.rendering.displayedEdgeIds?.every(id => graph.edges.some(edge => edge.id === id))).toBe(true);
    for (const edge of graph.edges) expect(artifact.html).toContain(edge.detail);
  }, 30000);
  it("uses the evidenced narrative order, and preserves all unprojected relations", () => {
    const graph = fixture(4, [[0,1],[0,2],[1,3],[2,3]]);
    graph.narrative = { title: "一次请求", summary: "工作台提交请求并获得处理结果。", edgeIds: ["edge-1", "edge-3"], sources: [source] };
    const specification = architectureSpecification(graph);
    expect(specification.components.slice(0,3).map(node => node.id)).toEqual(["node-0","node-2","node-3"]);
    expect(specification.connections.slice(0,2).map(edge => edge.id)).toEqual(graph.narrative.edgeIds);
    expect(graph.edges).toHaveLength(4);
    expect(specification.cards.filter(card => card.items.includes("传递请求数据"))).toHaveLength(4);
  });
});
