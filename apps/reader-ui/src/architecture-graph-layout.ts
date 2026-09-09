import ELK from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkInstance, ElkNode } from "elkjs/lib/elk-api.js";
import type { ArchitectureGraph } from "@aimd/contracts";
export type ArchitectureDiagramMode = "structure" | "flow";
export type DiagramBox = { id: string; parentId?: string; x: number; y: number; width: number; height: number; group: boolean };
export type DiagramRoute = { id: string; path: string; labelX: number; labelY: number };
export type DiagramLayout = { boxes: DiagramBox[]; routes: DiagramRoute[]; width: number; height: number };
const ElkConstructor = ELK as unknown as new () => ElkInstance;
const elk = new ElkConstructor();
/** Both modes share this one geometry; scenarios only overlay evidenced transitions. */
export async function layoutArchitectureGraph(graph: ArchitectureGraph, _mode: ArchitectureDiagramMode = "structure"): Promise<DiagramLayout> {
  const nodes=graph.nodes,groups=graph.groups??[];
  const leaf=(id:string):ElkNode=>{const node=nodes.find(node=>node.id===id)!;return{id,width:268,height:Math.max(145,70+Math.ceil(node.label.length/12)*27+Math.ceil(node.summary.length/18)*20+(node.codeName?Math.ceil(node.codeName.length/30)*17:0))};};
  const options={"elk.algorithm":"box","elk.spacing.nodeNode":"48","elk.aspectRatio":"1.5","elk.padding":"[top=90,left=36,bottom=36,right=36]"};
  const groupNode=(id:string):ElkNode=>({id,layoutOptions:{...options,"elk.padding":"[top="+(75+Math.ceil((groups.find(group=>group.id===id)?.summary.length??0)/22)*19)+",left=36,bottom=36,right=36]"},children:[...groups.filter(group=>group.parentId===id).map(group=>groupNode(group.id)),...nodes.filter(node=>groups.find(group=>group.nodeIds.includes(node.id))?.id===id).map(node=>leaf(node.id))]});
  const children=[...groups.filter(group=>!group.parentId).map(group=>groupNode(group.id)),...nodes.filter(node=>!groups.some(group=>group.nodeIds.includes(node.id))).map(node=>leaf(node.id))];
  const result:ElkNode=await elk.layout({id:"arki-layout-root",layoutOptions:{...options,"elk.padding":"[top=36,left=36,bottom=36,right=36]"},children});
  const boxes:DiagramBox[]=[];
  const flatten=(node:ElkNode,parentId?:string)=>{if(node.id!==result.id)boxes.push({id:node.id,...(parentId?{parentId}:{}),x:node.x??0,y:node.y??0,width:Math.max(268,node.width??268),height:node.height??145,group:groups.some(group=>group.id===node.id)});for(const child of node.children??[])flatten(child,node.id===result.id?undefined:node.id);};
  flatten(result);return{boxes,routes:[],width:result.width??600,height:result.height??400};
}
