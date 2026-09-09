import { describe, expect, it } from "vitest";
import type { ArchitectureGraph, ArchitectureEvidence } from "@aimd/contracts";
import { applyArchitectureAnswer, architectureEditScope } from "./architecture-edit.js";
import { architectureFailure } from "./architecture-errors.js";
const ref = { path: "gateway.ts", startLine: 1, endLine: 1, fileHash: "a".repeat(64) };
const evidence: ArchitectureEvidence[] = [{ ...ref, id: "evidence-1", excerpt: "export const value = 1;" }];
const graph: ArchitectureGraph = { id: "graph", version: 1, title: "Example", nodes: ["gateway", "worker", "store", "remote"].map(id => ({ id, kind: "backend", label: id, summary: id, detail: id, sources: [ref] })), edges: [
  { id: "calls", from: "gateway", to: "worker", label: "calls", detail: "calls", sources: [ref] },
  { id: "saves", from: "worker", to: "store", label: "saves", detail: "saves", sources: [ref] },
], notes: [] };
const target = { kind: "node" as const, id: "gateway" };
const node = (id: string) => ({ id, label: id, summary: "完善职责", detail: "证据支持的说明", evidenceIds: ["evidence-1"] });
const empty = { answer: "已完善", nodeUpdates: [], edgeUpdates: [], addedNodes: [], addedEdges: [], limitations: [] };
function failure(proposal: unknown, scope: "related" | "diagram" = "related") {
  try { applyArchitectureAnswer(graph, target, scope, evidence, proposal); throw new Error("Expected rejection"); } catch (error) { return architectureFailure(error, "d699de5b-876a-4c85-a7d6-f83cbe36d644"); }
}
describe("expanded architecture editing", () => {
  it("edits selected node, direct neighbor and their relationship together", () => {
    const result = applyArchitectureAnswer(graph, target, "related", evidence, { ...empty, nodeUpdates: [node("gateway"), node("worker")], edgeUpdates: [{ id: "calls", label: "处理请求", detail: "关联模块协同处理", evidenceIds: ["evidence-1"] }] });
    expect(result.changedIds).toEqual(["gateway", "worker", "calls"]);
    expect(result.next.nodes[2]).toEqual(graph.nodes[2]); expect(result.next.nodes[3]).toEqual(graph.nodes[3]);
    expect(graph.version).toBe(1);
  });
  it("treats a selected edge as a focus with both endpoint neighborhoods", () => {
    expect(architectureEditScope(graph, { kind: "edge", id: "calls" }).nodeIds).toEqual(expect.arrayContaining(["gateway", "worker", "store"]));
  });
  it("allows whole-diagram edits including disconnected existing nodes", () => {
    expect(applyArchitectureAnswer(graph, target, "diagram", evidence, { ...empty, nodeUpdates: [node("remote")] }).next.nodes[3]?.summary).toBe("完善职责");
    expect(failure({ ...empty, nodeUpdates: [node("remote")] })).toMatchObject({ code: "ARCHITECTURE_OUT_OF_SCOPE", stage: "validation", issues: [{ objectId: "remote", field: "nodeUpdates", actual: "remote", expected: "gateway, worker" }] });
  });
  it("ignores unchanged echoed context even outside the editing region", () => {
    const original = graph.nodes[3]!;
    const result = applyArchitectureAnswer(graph, target, "related", evidence, { ...empty, nodeUpdates: [node("gateway"), { id: original.id, label: original.label, summary: original.summary, detail: original.detail, evidenceIds: ["old-citation"] }] });
    expect(result.changedIds).toEqual(["gateway"]);
    expect(result.next.nodes[3]).toEqual(original);
  });
  it("accepts structure attached through a direct neighbor", () => {
    const result = applyArchitectureAnswer(graph, target, "related", evidence, { ...empty, addedNodes: [{ ...node("new-step"), kind: "backend" }], addedEdges: [{ id: "new-link", from: "worker", to: "new-step", label: "处理", detail: "进一步处理", evidenceIds: ["evidence-1"] }] });
    expect(result.next.nodes).toHaveLength(5);
  });
  it("reports offending citation and available IDs with the object and field", () => {
    expect(failure({ ...empty, nodeUpdates: [{ ...node("worker"), evidenceIds: ["unknown-evidence"] }] })).toMatchObject({ code: "ARCHITECTURE_UNKNOWN_EVIDENCE", issues: [{ objectId: "worker", field: "nodeUpdates.evidenceIds", actual: "unknown-evidence", expected: "evidence-1" }] });
  });
  it("distinguishes collision, disconnection, endpoint and response-shape errors", () => {
    expect(failure({ ...empty, addedNodes: [{ ...node("gateway"), kind: "backend" }] }).code).toBe("ARCHITECTURE_DUPLICATE_ID");
    expect(failure({ ...empty, addedNodes: [{ ...node("detached"), kind: "backend" }] }).code).toBe("ARCHITECTURE_DISCONNECTED");
    expect(failure({ ...empty, addedEdges: [{ id: "bad", from: "worker", to: "missing", label: "bad", detail: "bad", evidenceIds: ["evidence-1"] }] }).code).toBe("ARCHITECTURE_INVALID_ENDPOINT");
    expect(failure({ ...empty, nodeUpdates: [{ ...node("worker"), summary: "x".repeat(65) }] })).toMatchObject({ code: "ARCHITECTURE_OUTPUT_INVALID", issues: [{ field: "nodeUpdates.0.summary", message: "字段超过允许上限 64。" }] });
  });
  it("does not expose raw model values or unknown exception messages in diagnostics", () => {
    const value = "C:\\Users\\private\\sensitive-file";
    expect(JSON.stringify(failure({ ...empty, [value]: value }))).not.toContain("private");
    expect(JSON.stringify(architectureFailure(new Error(value), "d699de5b-876a-4c85-a7d6-f83cbe36d644"))).not.toContain("private");
  });
});
