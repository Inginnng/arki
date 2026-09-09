import { expect,it } from "vitest";
import type { ArchitectureGraph } from "@aimd/contracts";
import { layoutArchitectureGraph } from "./architecture-graph-layout.js";
const source={path:"entry.c",startLine:1,endLine:1,fileHash:"a".repeat(64)};
const graph:ArchitectureGraph={id:"layout",title:"组件",version:1,notes:[],nodes:["entry","worker","other"].map(id=>({id,label:id,summary:"职责",detail:"代码",kind:"backend",sources:[source]})),edges:[{id:"send",from:"entry",to:"worker",label:"传入文本处理",kind:"flow",detail:"调用",sources:[source]},{id:"import",from:"entry",to:"other",label:"导入数据类型",kind:"dependency",detail:"静态",sources:[source]}],groups:[{id:"system",label:"服务端",summary:"处理请求",detail:"服务",parentId:null,nodeIds:["entry"],sources:[source]},{id:"core",label:"处理内核",summary:"实现处理",detail:"内部实现",parentId:"system",nodeIds:["worker"],sources:[source]}]};
it("preserves nested containment and one shared geometry regardless of diagram mode",async()=>{
 const structure=await layoutArchitectureGraph(graph,"structure");expect(structure.routes).toEqual([]);
 for(const node of structure.boxes.filter(box=>box.parentId)){const parent=structure.boxes.find(box=>box.id===node.parentId)!;expect(node.x).toBeGreaterThan(0);expect(node.y).toBeGreaterThan(0);expect(node.x+node.width).toBeLessThan(parent.width);expect(node.y+node.height).toBeLessThan(parent.height);expect(structure.boxes.indexOf(parent)).toBeLessThan(structure.boxes.indexOf(node));}
 const flow=await layoutArchitectureGraph(graph,"flow");expect(flow.boxes).toEqual(structure.boxes);expect(flow.routes).toEqual([]);
 const dependencyOnly=await layoutArchitectureGraph({...graph,edges:graph.edges.filter(edge=>edge.kind==="dependency")},"flow");expect(dependencyOnly.boxes).toEqual(structure.boxes);expect(dependencyOnly.routes).toEqual([]);
});
