import { expect,it } from "vitest";
import { ArchitectureGraphSchema } from "@aimd/contracts";
import { applyArchitectureFlows } from "./architecture-flows.js";
import { scenarioGraph,scenarios } from "../../../tests/fixtures/architecture-scenarios.mjs";
const evidence=[{...scenarioGraph.nodes[0]!.sources[0]!,id:"evidence-1",excerpt:"test fixture"}];
const raw=scenarios.map(flow=>{const {sources,steps,transitions,...fields}=flow;return{...fields,evidenceIds:["evidence-1"],steps:steps.map(({sources,...step})=>({...step,evidenceIds:["evidence-1"]})),transitions:transitions.map(({sources,...edge})=>({...edge,evidenceIds:["evidence-1"]}))};});
it("preserves repeated participants, branches, parallel joins and retry loops as independent steps",()=>{
 const result=applyArchitectureFlows(scenarioGraph,raw,evidence);expect(result.flows).toHaveLength(3);expect(result.flowIssues).toBeUndefined();
 expect(result.flows[0]!.steps.filter(step=>step.nodeId==="client")).toHaveLength(3);
 expect(result.flows[2]!.transitions.map(edge=>edge.kind)).toEqual(["parallel","parallel","join","join","next","retry"]);
 expect(ArchitectureGraphSchema.parse({...scenarioGraph,...result}).flows).toEqual(result.flows);
});
it("isolates bad references without discarding other valid flows or inventing nodes",()=>{
 const proposal=structuredClone(raw);proposal[0]!.transitions.push({...proposal[0]!.transitions[0]!,id:"broken",to:"missing"});
 proposal[1]!.steps[0]!.nodeId="unread-component";
 const result=applyArchitectureFlows(scenarioGraph,proposal,evidence);expect(result.flows).toHaveLength(2);expect(result.flows[0]!.transitions.some(edge=>edge.id==="broken")).toBe(false);expect(result.flows[0]!.issues?.join(" ")).toContain("missing");expect(result.flowIssues?.join(" ")).toContain("入口步骤不可用");
 expect(ArchitectureGraphSchema.parse({...scenarioGraph,...result}).nodes).toEqual(scenarioGraph.nodes);
});
it("does not launder invented citations or ambiguous identities into confirmed flows",()=>{
 const proposal=structuredClone(raw);proposal[0]!.evidenceIds=["invented"];proposal[1]!.transitions[0]!.condition=null;proposal[1]!.transitions[0]!.kind="branch";
 const result=applyArchitectureFlows(scenarioGraph,proposal,evidence);expect(result.flows.map(flow=>flow.id)).not.toContain("count-request");expect(result.flows[0]!.issues?.length).toBeGreaterThan(0);
 const duplicate=applyArchitectureFlows(scenarioGraph,[raw[0],raw[0],raw[2]],evidence);expect(duplicate.flows.map(flow=>flow.id)).toEqual(["parallel-check"]);
});
