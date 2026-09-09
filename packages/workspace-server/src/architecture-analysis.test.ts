import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { ArchitectureAnalysisSchema, ArchitectureModelAnalysisSchema, ArchitectureGraphSchema, type ArchitectureGraph } from "@aimd/contracts";
import { applyArchitectureAnalysis, deepenArchitectureEvidence, bindArchitectureEvidenceSchema } from "./architecture-analysis.js";
import { openReadOnlyWorkspaceForTesting } from "./workspace.js";
import { createArchitectureService } from "./architecture-service.js";
const source = { path: "main.ts", startLine: 1, endLine: 1, fileHash: "a".repeat(64) };
const seed: ArchitectureGraph = { id: "test", version: 1, title: "扫描草图", notes: [], nodes: [{ id: "package", label: "package", kind: "backend", summary: "职责待解读", detail: "包索引", sources: [source] }], edges: [] };
const evidence = [{ ...source, id: "evidence-1", excerpt: "1: return count(input.text)" }];
const proposal = { title: "文本计数", answer: "入口将文本交给计数器。", nodes: ["input","counter"].map(id => ({ id, label: id === "input" ? "接收文本" : "统计词数", codeName: id, kind: "backend", summary: "处理文本", detail: "接收文本并统计", evidenceIds: ["evidence-1"] })), edges: [{ id: "count", from: "input", to: "counter", label: "提交待统计文本", kind: "flow", transfer: { payload: "input.text 字符串", mechanism: "count(text)", processing: "按空白分词后计算长度", result: "返回词数" }, detail: "调用 count", evidenceIds: ["evidence-1"] }], groups: [{ id: "service", label: "文本服务", summary: "接收并统计文本", detail: "服务包含计数处理", parentId: null, nodeIds: ["input"], evidenceIds: ["evidence-1"] }, { id: "engine", label: "统计引擎", summary: "封装计数规则", detail: "内部处理器", parentId: "service", nodeIds: ["counter"], evidenceIds: ["evidence-1"] }], narrative: { title: "提交文本", summary: "输入传给统计器并返回词数", edgeIds: ["count"], evidenceIds: ["evidence-1"] }, limitations: [] };
it("authors a fresh component hierarchy and concrete data transfer independently of package names", () => {
  const result = applyArchitectureAnalysis(seed,evidence,proposal);
  expect(result.next.nodes.map(node => node.id)).toEqual(["input","counter"]);
  expect(result.next.groups?.[1]).toMatchObject({ parentId: "service", sources: [source] });
  expect(result.next.edges[0]?.transfer?.payload).toBe("input.text 字符串");
  expect(seed.nodes[0]?.id).toBe("package");
  expect(ArchitectureGraphSchema.parse(seed)).toEqual(seed);
});
it("rejects cyclic containment, double membership, invented evidence and generic claimed flows", () => {
  expect(() => applyArchitectureAnalysis(seed,evidence,{...proposal,groups:proposal.groups.map(group => ({...group,parentId:group.id}))})).toThrow("ARCHITECTURE_OUTPUT_INVALID");
  expect(() => applyArchitectureAnalysis(seed,evidence,{...proposal,groups:proposal.groups.map(group => ({...group,nodeIds:["input"]}))})).toThrow("ARCHITECTURE_OUTPUT_INVALID");
  expect(() => applyArchitectureAnalysis(seed,evidence,{...proposal,groups:[{...proposal.groups[0],evidenceIds:["invented"]}]})).toThrow("ARCHITECTURE_UNKNOWN_EVIDENCE");
  expect(() => applyArchitectureAnalysis(seed,evidence,{...proposal,edges:[{...proposal.edges[0],label:"引用",transfer:null}]})).toThrow("ARCHITECTURE_OUTPUT_INVALID");
});
it("accepts a request-return scenario without letting the legacy acyclic narrative veto it",()=>{
 const back={...proposal.edges[0]!,id:"back",from:"counter",to:"input",label:"返回词数"};
 const flow={id:"request-return",label:"计数并返回",summary:"输入交给计数器，再返回调用方。",trigger:"提交文本",entryStepId:"submit",evidenceIds:["evidence-1"],steps:[{id:"submit",nodeId:"input",label:"提交文本",kind:"action",input:"text",processing:"提交文本",output:"text",evidenceIds:["evidence-1"]},{id:"counting",nodeId:"counter",label:"计算词数",kind:"action",input:"text",processing:"分词计数",output:"words",evidenceIds:["evidence-1"]},{id:"result",nodeId:"input",label:"接收结果",kind:"result",input:"words",processing:"显示词数",output:"结果",evidenceIds:["evidence-1"]}],transitions:[{id:"send",from:"submit",to:"counting",kind:"next",condition:null,payload:"text",mechanism:"count(text)",evidenceIds:["evidence-1"]},{id:"receive",from:"counting",to:"result",kind:"return",condition:null,payload:"words",mechanism:"函数返回",evidenceIds:["evidence-1"]}]};
 const withCycle={...proposal,edges:[...proposal.edges,back],narrative:{...proposal.narrative,edgeIds:["count","back"]}};
 expect(()=>applyArchitectureAnalysis(seed,evidence,withCycle)).toThrow("ARCHITECTURE_OUTPUT_INVALID");
 const result=applyArchitectureAnalysis(seed,evidence,{...withCycle,flows:[flow]});expect(result.next.flows?.[0]?.steps.map(step=>step.nodeId)).toEqual(["input","counter","input"]);expect(result.next.narrative).toBeUndefined();
});
it("binds every generation citation to the current evidence set",()=>{
 const schema=bindArchitectureEvidenceSchema(z.toJSONSchema(ArchitectureAnalysisSchema),evidence) as any;
 expect(schema.properties.nodes.items.properties.evidenceIds.items.enum).toEqual(["evidence-1"]);
 expect(schema.properties.edges.items.properties.evidenceIds.items.enum).toEqual(["evidence-1"]);
 expect(schema.properties.groups.items.properties.evidenceIds.items.enum).toEqual(["evidence-1"]);
});
it("keeps every Structured Outputs object property required", () => {
  const inspect = (schema: any) => { if (!schema || typeof schema !== "object") return; if (schema.type === "object") expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties))); for (const child of Object.values(schema)) if (Array.isArray(child)) child.forEach(inspect); else inspect(child); }; inspect(z.toJSONSchema(ArchitectureModelAnalysisSchema));
});
it("lets AI trace a handler beyond the initial excerpt while rejecting unlisted read paths", async () => {
  const root=await mkdtemp(join(tmpdir(),"arki-reading-"));
  try {
    await writeFile(join(root,"main.ts"), Array.from({length:400},(_,i)=>i===320?"export function countWords(text: string) { return text.trim().split(/\\s+/).length; }":"// context " + i).join("\n"));
    const workspace=await openReadOnlyWorkspaceForTesting(root);
    const head=await workspace.readFile("main.ts",{startLine:1,endLine:10});
    const initial=[{...source,fileHash:head.fileHash,endLine:10,id:"evidence-1",excerpt:head.excerpt}];
    const runner={name:"reader",runStructured:async()=>({understanding:"需要查看计数实现",reads:[{path:"main.ts",symbol:"countWords",startLine:null,reason:"核实接收处理"}]})};
    const refs=await deepenArchitectureEvidence(workspace,runner,initial,"解释计数");
    expect(refs.some(ref=>ref.startLine>200 && ref.excerpt.includes("export function countWords"))).toBe(true);
    expect(refs.every(ref=>ref.endLine-ref.startLine<120)).toBe(true);
    await expect(deepenArchitectureEvidence(workspace,{...runner,runStructured:async()=>({understanding:"",reads:[{path:"../secret.ts",symbol:null,startLine:1,reason:""}]})},initial,"问题")).rejects.toThrow("ARCHITECTURE_OUTPUT_INVALID");
    let calls=0;
    const service=createArchitectureService({workspace,runner:{name:"two-pass",runStructured:async()=>++calls===1?{understanding:"读取文本计数",reads:[]} : proposal},render:async()=>{throw new Error("ARCHITECTURE_LAYOUT_INVALID");}});
    const graph={...seed,nodes:seed.nodes.map(node=>({...node,sources:[{...source,fileHash:head.fileHash}]}))};
    const result=await service.ask({graph,target:{kind:"node",id:"package"},scope:"diagram",intent:"analyze",question:"分析文本服务"});
    expect(calls).toBe(2);expect(result.graph.groups).toHaveLength(2);expect(result.graph.nodes[0]?.id).toBe("input");
  } finally { await rm(root,{recursive:true,force:true}); }
});
