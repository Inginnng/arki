import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,95}$/u);
const path = z.string().min(1).max(1024).refine(value => !value.startsWith("/") && !value.includes("\\") && !/^[A-Za-z]:/u.test(value) && value.split("/").every(part => part && part !== "." && part !== ".."));
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const ArchitectureSourceSchema = z.object({ path, startLine: z.number().int().positive(), endLine: z.number().int().positive(), fileHash: hash }).strict().refine(value => value.endLine >= value.startLine && value.endLine - value.startLine < 120);
const sources = z.array(ArchitectureSourceSchema).min(1).max(4);
const flowStepFields = { id, nodeId: id, label: z.string().min(1).max(50), kind: z.enum(["action", "decision", "result"]), input: z.string().max(300), processing: z.string().min(1).max(600), output: z.string().max(300) };
const flowTransitionFields = { id, from: id, to: id, kind: z.enum(["next", "branch", "parallel", "join", "retry", "return"]), condition: z.string().max(200).nullable(), payload: z.string().min(1).max(300), mechanism: z.string().min(1).max(200) };
const flowFields = { id, label: z.string().min(1).max(60), summary: z.string().min(1).max(500), trigger: z.string().min(1).max(200), entryStepId: id };
export const ArchitectureFlowStepSchema = z.object({ ...flowStepFields, sources }).strict();
export const ArchitectureFlowTransitionSchema = z.object({ ...flowTransitionFields, sources }).strict();
export const ArchitectureFlowSchema = z.object({ ...flowFields, sources, steps: z.array(ArchitectureFlowStepSchema).min(1).max(18), transitions: z.array(ArchitectureFlowTransitionSchema).max(32), issues: z.array(z.string().max(500)).max(12).optional() }).strict();
export type ArchitectureFlow = z.infer<typeof ArchitectureFlowSchema>;
export type ArchitectureFlowStep = z.infer<typeof ArchitectureFlowStepSchema>;
export type ArchitectureFlowTransition = z.infer<typeof ArchitectureFlowTransitionSchema>;
export const ArchitectureKindSchema = z.enum(["frontend", "backend", "database", "cloud", "security", "messagebus", "external"]);
export const ArchitectureNodeSchema = z.object({ id, label: z.string().min(1).max(40), codeName: z.string().min(1).max(60).optional(), kind: ArchitectureKindSchema, summary: z.string().max(64), detail: z.string().max(3000), sources }).strict();
const transfer = z.object({ payload: z.string().min(1).max(300), mechanism: z.string().min(1).max(200), processing: z.string().min(1).max(500), result: z.string().min(1).max(300) }).strict();
const groupFields = { id, label: z.string().min(1).max(40), summary: z.string().max(100), detail: z.string().max(3000), parentId: id.nullable(), nodeIds: z.array(id).max(12) };
export const ArchitectureGroupSchema = z.object({ ...groupFields, sources }).strict();
const relationship = z.enum(["flow", "dependency"]);
export const ArchitectureEdgeSchema = z.object({ id, from: id, to: id, label: z.string().min(1).max(40), kind: relationship.optional(), transfer: transfer.optional(), detail: z.string().max(3000), sources }).strict();
const narrativeFields = { title: z.string().min(1).max(60), summary: z.string().min(1).max(800), edgeIds: z.array(id).min(1).max(6) };
export const ArchitectureNarrativeSchema = z.object({ ...narrativeFields, sources }).strict();
export const ArchitectureGraphSchema = z.object({
  id, version: z.number().int().positive().max(10000), title: z.string().min(1).max(120),
  nodes: z.array(ArchitectureNodeSchema).min(1).max(12), edges: z.array(ArchitectureEdgeSchema).max(24),
  notes: z.array(z.string().max(500)).max(8),
  narrative: ArchitectureNarrativeSchema.optional(),
  groups: z.array(ArchitectureGroupSchema).max(6).optional(),
  flows: z.array(ArchitectureFlowSchema).max(5).optional(),
  flowIssues: z.array(z.string().max(500)).max(12).optional(),
}).strict().superRefine((graph, ctx) => {
  const nodes = new Set(graph.nodes.map(node => node.id));
  if (nodes.size !== graph.nodes.length || new Set(graph.edges.map(edge => edge.id)).size !== graph.edges.length) ctx.addIssue({ code: "custom", message: "Duplicate diagram identity" });
  if (graph.edges.some(edge => !nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to)) ctx.addIssue({ code: "custom", message: "Invalid relationship endpoint" });
  const groups = graph.groups ?? [];
  const groupIds = new Set(groups.map(group => group.id));
  const members = groups.flatMap(group => group.nodeIds);
  if (groupIds.size !== groups.length || groups.some(group => nodes.has(group.id) || graph.edges.some(edge => edge.id === group.id)) || new Set(members).size !== members.length || members.some(member => !nodes.has(member))) ctx.addIssue({ code: "custom", message: "Invalid component membership or duplicate identity" });
  for (const group of groups) {
    const visited = new Set([group.id]); let parent = group.parentId;
    while (parent) { if (!groupIds.has(parent) || visited.has(parent)) { ctx.addIssue({ code: "custom", message: "Component containment must be an acyclic tree" }); break; } visited.add(parent); parent = groups.find(item => item.id === parent)!.parentId; }
  }
  if (graph.narrative) {
    const path = graph.narrative.edgeIds.map(id => graph.edges.find(edge => edge.id === id));
    if (new Set(graph.narrative.edgeIds).size !== path.length || path.some((edge, index) => !edge || (index > 0 && path[index - 1]?.to !== edge.from)) || new Set([path[0]?.from, ...path.map(edge => edge?.to)]).size !== path.length + 1) ctx.addIssue({ code: "custom", message: "Narrative must reference a continuous, non-cyclic path of existing relationships" });
  }
  if (new Set(graph.flows?.map(flow => flow.id)).size !== (graph.flows?.length ?? 0)) ctx.addIssue({ code: "custom", message: "Duplicate scenario identity" });
  for (const flow of graph.flows ?? []) {
    const steps = new Set(flow.steps.map(step => step.id));
    if (steps.size !== flow.steps.length || !steps.has(flow.entryStepId) || flow.steps.some(step => !nodes.has(step.nodeId)) || new Set(flow.transitions.map(edge => edge.id)).size !== flow.transitions.length || flow.transitions.some(edge => !steps.has(edge.from) || !steps.has(edge.to) || ((edge.kind === "branch" || edge.kind === "retry") && !edge.condition?.trim()))) ctx.addIssue({ code: "custom", message: "Invalid scenario steps, transitions or conditions" });
  }
});
export const ArchitectureTargetSchema = z.object({ kind: z.enum(["node", "edge", "group"]), id }).strict();
const evidenceIds = z.array(id).min(1).max(4);
export const ArchitectureFlowProposalSchema = z.object({ ...flowFields, evidenceIds, steps: z.array(z.object({ ...flowStepFields, evidenceIds }).strict()).min(1).max(18), transitions: z.array(z.object({ ...flowTransitionFields, evidenceIds }).strict()).max(32) }).strict();
const nodeUpdate = z.object({ id, label: z.string().min(1).max(40), summary: z.string().max(64), detail: z.string().min(1).max(3000), evidenceIds }).strict();
const edgeUpdate = z.object({ id, label: z.string().min(1).max(40), kind: relationship.nullable().optional(), transfer: transfer.nullable().optional(), detail: z.string().min(1).max(3000), evidenceIds }).strict();
const groupProposal = z.object({ ...groupFields, evidenceIds }).strict();
export const ArchitectureAnswerSchema = z.object({
  answer: z.string().min(1).max(6000),
  nodeUpdates: z.array(nodeUpdate).max(12), edgeUpdates: z.array(edgeUpdate).max(24),
  addedNodes: z.array(nodeUpdate.extend({ kind: ArchitectureKindSchema })).max(3),
  addedEdges: z.array(edgeUpdate.extend({ from: id, to: id })).max(4),
  limitations: z.array(z.string().max(500)).max(6),
  narrative: z.object({ ...narrativeFields, evidenceIds }).strict().nullable().optional(),
  groups: z.array(groupProposal).max(6).nullable().optional(),
  flows: z.array(ArchitectureFlowProposalSchema).max(5).nullable().optional(),
}).strict();
// Model Structured Outputs requires every property to be required; null means no update.
// The domain schema above remains compatible with older callers and saved answers.
export const ArchitectureModelAnswerSchema = ArchitectureAnswerSchema.extend({
  edgeUpdates: z.array(edgeUpdate.extend({ kind: relationship.nullable(), transfer: transfer.nullable() })).max(24),
  addedEdges: z.array(edgeUpdate.extend({ from: id, to: id, kind: relationship.nullable(), transfer: transfer.nullable() })).max(4),
  narrative: z.object({ ...narrativeFields, evidenceIds }).strict().nullable(),
  groups: z.array(groupProposal).max(6).nullable(),
  flows: z.array(ArchitectureFlowProposalSchema).max(5).nullable(),
});
export const ArchitectureAnalysisSchema = z.object({
  answer: z.string().min(1).max(6000), title: z.string().min(1).max(120),
  nodes: z.array(nodeUpdate.extend({ kind: ArchitectureKindSchema, codeName: z.string().min(1).max(60) })).min(1).max(12),
  edges: z.array(edgeUpdate.extend({ from: id, to: id, kind: relationship, transfer: transfer.nullable() })).max(24),
  groups: z.array(groupProposal).max(6),
  narrative: z.object({ ...narrativeFields, evidenceIds }).strict().nullable(),
  limitations: z.array(z.string().max(500)).max(6),
  flows: z.array(ArchitectureFlowProposalSchema).max(5).nullable().optional(),
}).strict();
export const ArchitectureModelAnalysisSchema = ArchitectureAnalysisSchema.extend({ flows: z.array(ArchitectureFlowProposalSchema).max(5).nullable() });
export const ArchitectureEvidenceSchema = ArchitectureSourceSchema.safeExtend({ id, excerpt: z.string().max(20000) });
export const ArchitectureRenderSchema = z.object({
  svg: z.string().min(1).max(500000), css: z.string().max(500000),
  displayedEdgeIds: z.array(id).max(24).optional(),
  readingOrder: z.array(id).max(12).optional(),
  receipt: z.object({ specificationHash: hash, artifactHash: hash, checksPassed: z.number().int().positive(), checkCount: z.number().int().positive(), errors: z.literal(0), warnings: z.number().int().nonnegative() }).strict(),
}).strict();
// Legacy Archify artifacts are optional: the workbench lays out the validated graph locally.
export const ArchitectureViewSchema = z.object({ graph: ArchitectureGraphSchema, rendering: ArchitectureRenderSchema.optional(), stale: z.boolean() }).strict();
export const ArchitectureResultSchema = ArchitectureViewSchema.extend({ answer: z.string().min(1).max(6000), limitations: z.array(z.string().max(500)).max(6), evidence: z.array(ArchitectureEvidenceSchema).max(24), changedIds: z.array(id).max(36) }).strict();
export type ArchitectureGraph = z.infer<typeof ArchitectureGraphSchema>;
export type ArchitectureNode = z.infer<typeof ArchitectureNodeSchema>;
export type ArchitectureEdge = z.infer<typeof ArchitectureEdgeSchema>;
export type ArchitectureSource = z.infer<typeof ArchitectureSourceSchema>;
export type ArchitectureTarget = z.infer<typeof ArchitectureTargetSchema>;
export type ArchitectureEvidence = z.infer<typeof ArchitectureEvidenceSchema>;
export type ArchitectureRendering = z.infer<typeof ArchitectureRenderSchema>;
export type ArchitectureView = z.infer<typeof ArchitectureViewSchema>;
export type ArchitectureResult = z.infer<typeof ArchitectureResultSchema>;
export const ArchitectureEditScopeSchema = z.enum(["related", "diagram"]);
export type ArchitectureEditScope = z.infer<typeof ArchitectureEditScopeSchema>;
export const ArchitectureIssueSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u), message: z.string().min(1).max(1000),
  objectId: id.optional(), field: z.string().max(200).optional(),
  expected: z.string().max(2500).optional(), actual: z.string().max(2500).optional(),
}).strict();
export const ArchitectureFailureSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u), message: z.string().min(1).max(1000),
  stage: z.enum(["request", "evidence", "model", "validation", "rendering", "internal"]),
  suggestion: z.string().max(1000), repairAttempts: z.number().int().min(0).max(1).default(0), issues: z.array(ArchitectureIssueSchema).max(12), requestId: z.uuid(),
}).strict();
export type ArchitectureIssue = z.infer<typeof ArchitectureIssueSchema>;
export type ArchitectureFailure = z.infer<typeof ArchitectureFailureSchema>;
