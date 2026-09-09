import type { ArchitectureFlow, ArchitectureGraph } from "@aimd/contracts";

export type FlowScenario = ArchitectureFlow & { legacy?: boolean };
/** Old reading paths are explicitly labelled; imports never become generated scenarios. */
export function architectureScenarios(graph: ArchitectureGraph): FlowScenario[] {
  if (graph.flows !== undefined) return graph.flows;
  const narrative = graph.narrative;
  if (!narrative || narrative.edgeIds.some(id => graph.edges.find(edge => edge.id === id)?.kind !== "flow")) return [];
  const edges = narrative.edgeIds.map(id => graph.edges.find(edge => edge.id === id)!);
  const ids = [edges[0]!.from, ...edges.map(edge => edge.to)];
  return [{ id: "legacy-reading-path", label: narrative.title, summary: narrative.summary, trigger: "旧版已记录的阅读主线；尚未分析其他典型场景。", entryStepId: "legacy-step-1", legacy: true, sources: narrative.sources,
    steps: ids.map((id,index) => { const node = graph.nodes.find(node => node.id === id)!; return { id: "legacy-step-" + (index + 1), nodeId: id, label: node.label, kind: "action", input: index ? edges[index-1]?.transfer?.payload ?? "旧记录未细分" : "旧记录未细分", processing: node.detail, output: edges[index]?.transfer?.result ?? "旧记录未细分", sources: node.sources }; }),
    transitions: edges.map((edge,index) => ({ id: edge.id, from: "legacy-step-" + (index + 1), to: "legacy-step-" + (index + 2), kind: "next", condition: null, payload: edge.transfer?.payload ?? edge.label, mechanism: edge.transfer?.mechanism ?? "旧记录未细分", sources: edge.sources })) }];
}
export const flowTransitionName = { next: "继续", branch: "条件", parallel: "并行", join: "合流", retry: "重试", return: "返回" } as const;
export function scenarioParticipants(graph: ArchitectureGraph, flow?: ArchitectureFlow) {
  if (!flow) return new Set(graph.nodes.map(node => node.id));
  const active = new Set(flow.steps.map(step => step.nodeId));
  for (let i = 0; i < (graph.groups?.length ?? 0); i++) for (const group of graph.groups ?? []) {
    if (group.nodeIds.some(id => active.has(id)) || graph.groups?.some(child => child.parentId === group.id && active.has(child.id))) active.add(group.id);
  }
  return active;
}
