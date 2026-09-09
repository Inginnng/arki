import { expect, it } from "vitest";
import { z } from "zod";
import { ArchitectureModelAnswerSchema, ArchitectureGraphSchema, type ArchitectureGraph } from "@aimd/contracts";
import { applyArchitectureAnswer } from "./architecture-edit.js";
const source={path:"service.ts",startLine:1,endLine:2,fileHash:"a".repeat(64)};
const graph:ArchitectureGraph={id:"example",version:1,title:"请求处理",notes:[],nodes:["ui","server","worker"].map(id=>({id,kind:"backend",label:id,summary:"职责待解读",detail:"源代码",sources:[source]})),edges:[{id:"request",from:"ui",to:"server",label:"请求",detail:"发送请求",sources:[source]},{id:"dispatch",from:"server",to:"worker",label:"处理",detail:"分派处理",sources:[source]}]};
const narrative={title:"提交问题",summary:"界面提交问题，服务分派到处理器。",edgeIds:["request","dispatch"],evidenceIds:["evidence-1"]};
const evidence=[{...source,id:"evidence-1",excerpt:"1: handle(request);"}];
const proposal={answer:"见代码证据",nodeUpdates:[],edgeUpdates:[],addedNodes:[],addedEdges:[],limitations:[],narrative};
it("accepts a source-backed continuous narrative without losing relationship history",()=>{
 const result=applyArchitectureAnswer(graph,{kind:"node",id:"ui"},"diagram",evidence,proposal);
 expect(result.next.narrative?.sources).toEqual([source]);expect(result.next.version).toBe(2);expect(result.changedIds).toEqual(["request","dispatch"]);expect(graph.narrative).toBeUndefined();
});
it("rejects disconnected narrative steps, invented evidence, and narrative edits from a local scope",()=>{
 expect(()=>applyArchitectureAnswer(graph,{kind:"node",id:"ui"},"related",evidence,proposal)).toThrow("ARCHITECTURE_OUT_OF_SCOPE");
 expect(()=>applyArchitectureAnswer(graph,{kind:"node",id:"ui"},"diagram",evidence,{...proposal,narrative:{...narrative,evidenceIds:["invented"]}})).toThrow("ARCHITECTURE_UNKNOWN_EVIDENCE");
 expect(()=>applyArchitectureAnswer(graph,{kind:"node",id:"ui"},"diagram",evidence,{...proposal,narrative:{...narrative,edgeIds:["dispatch","request"]}})).toThrow("ARCHITECTURE_OUTPUT_INVALID");
 expect(ArchitectureGraphSchema.safeParse(graph).success).toBe(true);
});
it("records an evidence-backed dependency/flow change even when its wording stays identical",()=>{
 const edge=graph.edges[0]!;
 const result=applyArchitectureAnswer(graph,{kind:"node",id:"ui"},"diagram",evidence,{...proposal,narrative:undefined,edgeUpdates:[{id:edge.id,label:edge.label,detail:edge.detail,kind:"flow",evidenceIds:["evidence-1"]}]});
 expect(result.next.edges[0]?.kind).toBe("flow");expect(result.next.version).toBe(2);
});
it("uses a model schema whose every object property is required, while null leaves domain values unchanged",()=>{
 const inspect=(schema:any)=>{if(!schema||typeof schema!=="object")return;if(schema.type==="object")expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties)));for(const child of Object.values(schema))if(Array.isArray(child))child.forEach(inspect);else if(child&&typeof child==="object")inspect(child)};
 inspect(z.toJSONSchema(ArchitectureModelAnswerSchema));
 const edge=graph.edges[0]!;
 const result=applyArchitectureAnswer(graph,{kind:"node",id:"ui"},"diagram",evidence,{...proposal,narrative:null,edgeUpdates:[{id:edge.id,label:edge.label,detail:edge.detail,kind:null,evidenceIds:["evidence-1"]}]});
 expect(result.next).toEqual(graph);expect(result.changedIds).toEqual([]);
});
