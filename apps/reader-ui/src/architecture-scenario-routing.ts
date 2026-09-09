import type { ArchitectureFlow } from "@aimd/contracts";
import type { DiagramBox, DiagramLayout, DiagramRoute } from "./architecture-graph-layout.js";

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
export type ScenarioRoute = DiagramRoute & { from: string; to: string; transitionIds: string[]; label: string; bidirectional: boolean };
const GAP = 18;
export function absoluteBoxes(boxes: DiagramBox[]) {
  const positions = new Map<string, Rect>();
  for (const box of boxes) { const parent = box.parentId ? positions.get(box.parentId) : undefined; positions.set(box.id, { x: box.x + (parent?.x ?? 0), y: box.y + (parent?.y ?? 0), width: box.width, height: box.height }); }
  return positions;
}
const intersects = (a: Point, b: Point, box: Rect) => a.x === b.x ? a.x > box.x && a.x < box.x + box.width && Math.max(a.y,b.y) > box.y && Math.min(a.y,b.y) < box.y + box.height : a.y > box.y && a.y < box.y + box.height && Math.max(a.x,b.x) > box.x && Math.min(a.x,b.x) < box.x + box.width;
function ports(box: Rect) {
  return [{ x: box.x + box.width / 2, y: box.y - GAP, boundary: { x: box.x + box.width / 2, y: box.y } }, { x: box.x + box.width / 2, y: box.y + box.height + GAP, boundary: { x: box.x + box.width / 2, y: box.y + box.height } }, { x: box.x - GAP, y: box.y + box.height / 2, boundary: { x: box.x, y: box.y + box.height / 2 } }, { x: box.x + box.width + GAP, y: box.y + box.height / 2, boundary: { x: box.x + box.width, y: box.y + box.height / 2 } }];
}
/** Visibility-grid routing around fixed component boxes. Never moves architecture geometry. */
function routeBetween(from: Rect, to: Rect, obstacles: Rect[], width: number, height: number): Point[] | null {
  const candidates = ports(from).flatMap(start => ports(to).map(end => ({ start, end, score: Math.abs(start.x-end.x) + Math.abs(start.y-end.y) }))).sort((a,b) => a.score-b.score);
  for (const { start,end } of candidates) {
    if (obstacles.some(box => intersects(start.boundary,start,box) && !(start.boundary.x >= box.x && start.boundary.x <= box.x+box.width && start.boundary.y >= box.y && start.boundary.y <= box.y+box.height))) continue;
    const xs = [...new Set([0,width,start.x,end.x,...obstacles.flatMap(box => [box.x,box.x+box.width])])].sort((a,b)=>a-b);
    const ys = [...new Set([0,height,start.y,end.y,...obstacles.flatMap(box => [box.y,box.y+box.height])])].sort((a,b)=>a-b);
    const point = (index: number): Point => ({ x: xs[index % xs.length]!, y: ys[Math.floor(index / xs.length)]! });
    const source = ys.indexOf(start.y) * xs.length + xs.indexOf(start.x), target = ys.indexOf(end.y) * xs.length + xs.indexOf(end.x);
    const dist = new Map<number,number>([[source,0]]), prior = new Map<number,number>(); const open = new Set([source]);
    let budget = xs.length * ys.length;
    while (open.size && budget-- > 0) {
      let current = -1, best = Infinity;
      for (const index of open) { const p=point(index); const score=dist.get(index)!+Math.abs(p.x-end.x)+Math.abs(p.y-end.y); if(score<best){best=score;current=index;} }
      if (current === target) { const path: Point[] = [end.boundary,point(current)]; while (prior.has(current)) { current=prior.get(current)!;path.push(point(current)); } path.push(start.boundary); return path.reverse().filter((p,index,all)=>index===0 || p.x!==all[index-1]!.x || p.y!==all[index-1]!.y); }
      open.delete(current);const a=point(current),col=current%xs.length,row=Math.floor(current/xs.length);
      const neighbors = [col>0?current-1:-1,col<xs.length-1?current+1:-1,row>0?current-xs.length:-1,row<ys.length-1?current+xs.length:-1];
      for (const neighbor of neighbors) {
        if(neighbor<0)continue;const b=point(neighbor);if(obstacles.some(box=>intersects(a,b,box)))continue;
        const cost=dist.get(current)!+Math.abs(a.x-b.x)+Math.abs(a.y-b.y)+.01;
        if(cost<(dist.get(neighbor)??Infinity)){dist.set(neighbor,cost);prior.set(neighbor,current);open.add(neighbor);}
      }
    }
  }
  return null;
}
export function routeArchitectureScenario(layout: DiagramLayout, flow: ArchitectureFlow): { routes: ScenarioRoute[]; unrouted: string[] } {
  const positions=absoluteBoxes(layout.boxes);
  const obstacles=layout.boxes.filter(box=>!box.group).map(box=>{const p=positions.get(box.id)!;return{x:p.x-GAP,y:p.y-GAP,width:p.width+2*GAP,height:p.height+2*GAP};});
  for(const box of layout.boxes.filter(box=>box.group)){const p=positions.get(box.id)!;obstacles.push({x:p.x+12,y:p.y+10,width:p.width-24,height:68});}
  const bundles = new Map<string, { from: string; to: string; ids: string[]; labels: string[]; bidirectional: boolean }>();
  for(const edge of flow.transitions){const from=flow.steps.find(step=>step.id===edge.from)?.nodeId,to=flow.steps.find(step=>step.id===edge.to)?.nodeId;if(!from||!to||from===to)continue;const key=[from,to].sort().join(":");const bundle=bundles.get(key)??{from,to,ids:[],labels:[],bidirectional:false};if(bundle.from!==from)bundle.bidirectional=true;bundle.ids.push(edge.id);bundle.labels.push(String(flow.transitions.indexOf(edge)+1));bundles.set(key,bundle);}
  const routes:ScenarioRoute[]=[],unrouted:string[]=[];
  for(const bundle of bundles.values()){
    const start=positions.get(bundle.from),end=positions.get(bundle.to);if(!start||!end){unrouted.push(...bundle.ids);continue;}
    const points=routeBetween(start,end,obstacles,layout.width,layout.height);if(!points){unrouted.push(...bundle.ids);continue;}
    // Tiny numbered pins avoid hiding meaning behind overflowing geometry; full transfers remain in the flow reader.
    let longest=0,labelX=points[0]!.x,labelY=points[0]!.y;
    for(let i=1;i<points.length;i++){const a=points[i-1]!,b=points[i]!,length=Math.abs(a.x-b.x)+Math.abs(a.y-b.y);if(length>longest){longest=length;labelX=(a.x+b.x)/2;labelY=(a.y+b.y)/2;}}
    routes.push({id:"scenario-"+bundle.from+"-"+bundle.to,from:bundle.from,to:bundle.to,transitionIds:bundle.ids,bidirectional:bundle.bidirectional,label:bundle.labels.slice(0,3).join(" / ")+(bundle.labels.length>3?" +"+(bundle.labels.length-3):""),path:points.map((p,i)=>(i?"L":"M")+p.x+" "+p.y).join(" "),labelX,labelY});
  }
  return {routes,unrouted};
}
