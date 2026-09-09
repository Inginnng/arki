import {expect,it} from "vitest";
import {scenarioGraph,scenarios} from "../../../tests/fixtures/architecture-scenarios.mjs";
import {layoutArchitectureGraph} from "./architecture-graph-layout.js";
import {absoluteBoxes,routeArchitectureScenario} from "./architecture-scenario-routing.js";
import {architectureScenarios,scenarioParticipants} from "./architecture-flows.js";
import {architectureMarkdown} from "./architecture-document.js";
import {exportArchitectureHtml} from "./architecture-export.js";
it("keeps all positions identical across architecture and all scenario overlays",async()=>{
 const layout=await layoutArchitectureGraph(scenarioGraph,"structure"),other=await layoutArchitectureGraph(scenarioGraph,"flow");expect(other.boxes).toEqual(layout.boxes);
 const before=JSON.stringify(layout),boxes=absoluteBoxes(layout.boxes);
 for(const flow of scenarios){const overlay=routeArchitectureScenario(layout,flow);expect(overlay.routes.length).toBeGreaterThan(0);expect(overlay.unrouted).toEqual([]);for(const route of overlay.routes){expect(route.path).toMatch(/^M/);const points=[...route.path.matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map(match=>({x:Number(match[1]),y:Number(match[2])}));for(let i=2;i<points.length-1;i++){const a=points[i-1]!,b=points[i]!;for(const box of layout.boxes.filter(box=>!box.group)){const p=boxes.get(box.id)!;expect(a.x===b.x?a.x>p.x&&a.x<p.x+p.width&&Math.max(a.y,b.y)>p.y&&Math.min(a.y,b.y)<p.y+p.height:a.y>p.y&&a.y<p.y+p.height&&Math.max(a.x,b.x)>p.x&&Math.min(a.x,b.x)<p.x+p.width).toBe(false);}}}expect(JSON.stringify(layout)).toBe(before);}
 expect(scenarioParticipants(scenarioGraph,scenarios[0]).has("archive")).toBe(false);
});
it("does not fabricate scenarios from unconfirmed dependency graphs",()=>{expect(architectureScenarios({...scenarioGraph,flows:undefined})).toEqual([]);expect(architectureScenarios(scenarioGraph)).toHaveLength(3);});
it("preserves every scenario and branch in Markdown and offline HTML",async()=>{const markdown=architectureMarkdown(scenarioGraph),html=await exportArchitectureHtml(scenarioGraph,markdown);for(const flow of scenarios){expect(markdown).toContain(flow.label);expect(html).toContain('id="scenario-'+flow.id+'"');for(const edge of flow.transitions){expect(html).toContain(edge.payload);if(edge.condition)expect(html).toContain(edge.condition);}}expect(html).not.toContain('<script');});
