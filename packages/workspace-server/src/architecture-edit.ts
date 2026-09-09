import { ArchitectureAnswerSchema, ArchitectureGraphSchema, type ArchitectureGraph, type ArchitectureTarget, type ArchitectureEditScope, type ArchitectureEvidence, type ArchitectureIssue } from "@aimd/contracts";
import { ArchitectureError, schemaIssues } from "./architecture-errors.js";
import { applyArchitectureFlows } from "./architecture-flows.js";

export function architectureEditScope(graph: ArchitectureGraph, target: ArchitectureTarget, scope: ArchitectureEditScope = "related") {
  const edge = graph.edges.find(item => item.id === target.id);
  const groupNodes = new Set<string>();
  if (target.kind === "group") { const visit = (id: string) => { const group = graph.groups?.find(item => item.id === id); group?.nodeIds.forEach(id => groupNodes.add(id)); graph.groups?.filter(item => item.parentId === id).forEach(item => visit(item.id)); }; visit(target.id); }
  const anchors = new Set(target.kind === "group" ? [...groupNodes] : target.kind === "node" ? [target.id] : edge ? [edge.from, edge.to] : []);
  const incident = graph.edges.filter(item => anchors.has(item.from) || anchors.has(item.to));
  const nodeIds = scope === "diagram" ? graph.nodes.map(item => item.id) : [...new Set([...anchors, ...incident.flatMap(item => [item.from, item.to])])];
  const edgeIds = graph.edges.filter(item => scope === "diagram" || (nodeIds.includes(item.from) && nodeIds.includes(item.to))).map(item => item.id);
  return { mode: scope, nodeIds, edgeIds };
}

export function applyArchitectureAnswer(graph: ArchitectureGraph, target: ArchitectureTarget, scope: ArchitectureEditScope, evidence: ArchitectureEvidence[], raw: unknown) {
  const parsed = ArchitectureAnswerSchema.safeParse(raw);
  if (!parsed.success) throw new ArchitectureError("ARCHITECTURE_OUTPUT_INVALID", schemaIssues(parsed.error));
  const answer = parsed.data;
  const editable = architectureEditScope(graph, target, scope);
  // A model may echo the unchanged context; such entries are not edits.
  const nodeUpdates = answer.nodeUpdates.filter(update => { const node = graph.nodes.find(item => item.id === update.id); return !node || node.label !== update.label || node.summary !== update.summary || node.detail !== update.detail; });
  const edgeUpdates = answer.edgeUpdates.filter(update => { const edge = graph.edges.find(item => item.id === update.id); return !edge || edge.label !== update.label || edge.detail !== update.detail || (update.kind != null && edge.kind !== update.kind) || (update.transfer != null && JSON.stringify(update.transfer) !== JSON.stringify(edge.transfer)); });
  const issues: ArchitectureIssue[] = [];
  if (answer.flows && scope !== "diagram") issues.push({ code: "ARCHITECTURE_OUT_OF_SCOPE", field: "flows", message: "典型流程只能在整图编辑时更新。" });
  if (answer.narrative && scope !== "diagram") issues.push({ code: "ARCHITECTURE_OUT_OF_SCOPE", field: "narrative", message: "整图阅读主线只能在整图分析时更新。" });
  if (answer.narrative?.evidenceIds.some(id => !evidence.some(ref => ref.id === id))) issues.push({ code: "ARCHITECTURE_UNKNOWN_EVIDENCE", field: "narrative.evidenceIds", message: "阅读主线引用了本次未提供的证据。" });
  if (answer.groups && scope !== "diagram") issues.push({ code: "ARCHITECTURE_OUT_OF_SCOPE", field: "groups", message: "组件归属只能在整图编辑时更新。" });
  if (answer.groups?.some(group => group.evidenceIds.some(id => !evidence.some(ref => ref.id === id)))) issues.push({ code: "ARCHITECTURE_UNKNOWN_EVIDENCE", field: "groups", message: "组件归属引用了未读取的证据。" });
  const existing = new Set([...graph.nodes, ...graph.edges].map(item => item.id));
  const seen = new Set<string>();
  for (const [updates, objects, allowed, field] of [[nodeUpdates, graph.nodes, editable.nodeIds, "nodeUpdates"], [edgeUpdates, graph.edges, editable.edgeIds, "edgeUpdates"]] as const) {
    for (const update of updates) {
      if (seen.has(update.id)) issues.push({ code: "ARCHITECTURE_DUPLICATE_ID", objectId: update.id, field, message: "同一个对象在修改列表中出现多次。" });
      seen.add(update.id);
      if (!objects.some(item => item.id === update.id)) issues.push({ code: "ARCHITECTURE_UNKNOWN_OBJECT", objectId: update.id, field, message: "要修改的对象不在当前图中。" });
      else if (!allowed.includes(update.id)) issues.push({ code: "ARCHITECTURE_OUT_OF_SCOPE", objectId: update.id, field, message: "这个对象超出当前关联编辑区域。", expected: allowed.join(", "), actual: update.id });
    }
  }
  for (const [additions, field] of [[answer.addedNodes, "addedNodes"], [answer.addedEdges, "addedEdges"]] as const) for (const item of additions) {
    if (existing.has(item.id)) issues.push({ code: "ARCHITECTURE_DUPLICATE_ID", objectId: item.id, field, message: "新增对象的标识已被其他对象使用。", actual: item.id });
    existing.add(item.id);
  }
  const nodeIds = new Set([...graph.nodes, ...answer.addedNodes].map(item => item.id));
  for (const edge of answer.addedEdges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) issues.push({ code: "ARCHITECTURE_INVALID_ENDPOINT", objectId: edge.id, field: "addedEdges", message: "连线端点不存在，或两端指向同一个模块。", expected: [...nodeIds].join(", "), actual: `${edge.from} → ${edge.to}` });
  }
  for (const [changes, field] of [[nodeUpdates, "nodeUpdates"], [edgeUpdates, "edgeUpdates"], [answer.addedNodes, "addedNodes"], [answer.addedEdges, "addedEdges"]] as const) for (const item of changes) {
    const missing = item.evidenceIds.filter(id => !evidence.some(ref => ref.id === id));
    if (missing.length) issues.push({ code: "ARCHITECTURE_UNKNOWN_EVIDENCE", objectId: item.id, field: `${field}.evidenceIds`, message: "本次没有提供这些证据编号，无法核验该修改。", expected: evidence.map(ref => ref.id).join(", "), actual: missing.join(", ") });
  }
  const reachable = new Set(editable.nodeIds);
  for (let i = 0; i < nodeIds.size; i++) for (const edge of answer.addedEdges) {
    if (reachable.has(edge.from)) reachable.add(edge.to);
    if (reachable.has(edge.to)) reachable.add(edge.from);
  }
  for (const node of answer.addedNodes) if (!reachable.has(node.id)) issues.push({ code: "ARCHITECTURE_DISCONNECTED", objectId: node.id, field: "addedNodes", message: "新增模块未通过新增连线连接到编辑区域。" });
  for (const edge of answer.addedEdges) if (!reachable.has(edge.from) || !reachable.has(edge.to)) issues.push({ code: "ARCHITECTURE_DISCONNECTED", objectId: edge.id, field: "addedEdges", message: "新增关系位于编辑区域之外。" });
  if (graph.nodes.length + answer.addedNodes.length > 12 || graph.edges.length + answer.addedEdges.length > 24) issues.push({ code: "ARCHITECTURE_GRAPH_LIMIT", message: "修改后超过画布容量。", expected: "模块 ≤ 12，关系 ≤ 24", actual: `模块 ${graph.nodes.length + answer.addedNodes.length}，关系 ${graph.edges.length + answer.addedEdges.length}` });
  if (issues.length) throw new ArchitectureError(issues[0]!.code as ConstructorParameters<typeof ArchitectureError>[0], issues);
  const sources = (ids: string[]) => ids.map(id => { const { id: _id, excerpt: _excerpt, ...ref } = evidence.find(item => item.id === id)!; return ref; });
  const next = structuredClone(graph);
  for (const update of nodeUpdates) { const { evidenceIds, ...fields } = update; Object.assign(next.nodes.find(item => item.id === update.id)!, fields, { sources: sources(evidenceIds) }); }
  for (const update of edgeUpdates) { const { evidenceIds, kind, transfer, ...fields } = update; Object.assign(next.edges.find(item => item.id === update.id)!, fields, ...(kind ? [{ kind }] : []), ...(transfer ? [{ transfer }] : []), { sources: sources(evidenceIds) }); }
  for (const node of answer.addedNodes) { const { evidenceIds, ...fields } = node; next.nodes.push({ ...fields, sources: sources(evidenceIds) }); }
  for (const edge of answer.addedEdges) { const { evidenceIds, kind, transfer, ...fields } = edge; next.edges.push({ ...fields, ...(kind ? { kind } : {}), ...(transfer ? { transfer } : {}), sources: sources(evidenceIds) }); }
  if (!answer.flows && answer.narrative) { const { evidenceIds, ...fields } = answer.narrative; next.narrative = { ...fields, sources: sources(evidenceIds) }; }
  if (answer.groups) next.groups = answer.groups.map(group => { const { evidenceIds, ...fields } = group; return { ...fields, sources: sources(evidenceIds) }; });
  const changedIds = [...nodeUpdates, ...edgeUpdates, ...answer.addedNodes, ...answer.addedEdges].map(item => item.id);
  if (answer.flows) {
    delete next.narrative;
    const flowResult = applyArchitectureFlows(next, answer.flows, evidence);
    delete next.flowIssues;
    Object.assign(next, flowResult);
    if (JSON.stringify(next.flows) !== JSON.stringify(graph.flows) || JSON.stringify(next.flowIssues) !== JSON.stringify(graph.flowIssues)) for (const node of next.nodes) if (!changedIds.includes(node.id)) changedIds.push(node.id);
  }
  if (answer.narrative && JSON.stringify(next.narrative) !== JSON.stringify(graph.narrative)) for (const id of answer.narrative.edgeIds) if (!changedIds.includes(id)) changedIds.push(id);
  if (answer.groups && JSON.stringify(next.groups) !== JSON.stringify(graph.groups)) for (const node of next.nodes) if (!changedIds.includes(node.id)) changedIds.push(node.id);
  next.version += changedIds.length ? 1 : 0;
  const valid = ArchitectureGraphSchema.safeParse(next);
  if (!valid.success) throw new ArchitectureError("ARCHITECTURE_OUTPUT_INVALID", schemaIssues(valid.error));
  return { next: valid.data, answer, changedIds };
}
