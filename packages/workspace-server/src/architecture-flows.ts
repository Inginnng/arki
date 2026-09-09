import { ArchitectureFlowProposalSchema, type ArchitectureEvidence, type ArchitectureFlow, type ArchitectureGraph } from "@aimd/contracts";

/** Keep evidenced scenario content independent of layout and isolate unusable references. */
export function applyArchitectureFlows(graph: ArchitectureGraph, raw: unknown[], evidence: ArchitectureEvidence[]) {
  const flows: ArchitectureFlow[] = [], flowIssues: string[] = [];
  const seen = new Set<string>();
  const duplicate = new Set(raw.map(item => (item as { id?: string })?.id).filter((id, index, ids) => ids.indexOf(id) !== index));
  const knownNodes = new Set(graph.nodes.map(node => node.id));
  const refs = new Map(evidence.map(ref => [ref.id, ref]));
  const backed = <T extends { evidenceIds: string[] }>(item: T) => {
    if (item.evidenceIds.some(id => !refs.has(id))) return null;
    const { evidenceIds, ...fields } = item;
    return { ...fields, sources: evidenceIds.map(id => { const { id: _id, excerpt: _excerpt, ...source } = refs.get(id)!; return source; }) };
  };
  for (const proposal of raw) {
    const parsed = ArchitectureFlowProposalSchema.safeParse(proposal);
    if (!parsed.success) { flowIssues.push("一份流程候选格式不完整，尚未作为已确认流程展示。"); continue; }
    const item = parsed.data;
    if (duplicate.has(item.id) || seen.has(item.id)) { flowIssues.push(item.label + "：流程标识重复，已隔离该场景。"); continue; }
    seen.add(item.id);
    const base = backed(item);
    if (!base) { flowIssues.push(item.label + "：场景引用了未提供的证据，需补读后确认。"); continue; }
    const issues: string[] = [];
    const conflictingSteps = new Set(item.steps.filter((step, index) => item.steps.findIndex(other => other.id === step.id) !== index).map(step => step.id));
    const steps = item.steps.flatMap(step => {
      const result = backed(step);
      if (!result || !knownNodes.has(step.nodeId) || conflictingSteps.has(step.id)) { issues.push("步骤「" + step.label + "」的组件、身份或证据未确认，已隔离。"); return []; }
      return [result];
    });
    if (!steps.some(step => step.id === item.entryStepId)) { flowIssues.push(item.label + "：入口步骤不可用，保留其他场景，不推断新的入口。"); continue; }
    const ids = new Set(steps.map(step => step.id));
    const conflicts = new Set(item.transitions.filter((edge, index) => item.transitions.findIndex(other => other.id === edge.id) !== index).map(edge => edge.id));
    const transitions = item.transitions.flatMap(edge => {
      const result = backed(edge);
      if (!result || !ids.has(edge.from) || !ids.has(edge.to) || conflicts.has(edge.id) || ((edge.kind === "branch" || edge.kind === "retry") && !edge.condition?.trim())) {
        issues.push("关系「" + edge.id + "」(" + edge.from + " → " + edge.to + ") 的端点、条件或证据未确认，已隔离。"); return [];
      }
      return [result];
    });
    const reachable = new Set([item.entryStepId]);
    for (let pass = 0; pass < steps.length; pass++) for (const edge of transitions) if (reachable.has(edge.from)) reachable.add(edge.to);
    if (steps.some(step => !reachable.has(step.id))) issues.push("有步骤尚未从入口连通；仍保留在步骤目录中，不补造连接。");
    if (!steps.some(step => step.kind === "result" && reachable.has(step.id))) issues.push("尚未确认可从入口到达的结束结果，当前流程不完整。");
    flows.push({ ...base, steps, transitions, ...(issues.length ? { issues: issues.slice(0, 12) } : {}) });
  }
  return { flows, ...(flowIssues.length ? { flowIssues: flowIssues.slice(0, 12) } : {}) };
}
