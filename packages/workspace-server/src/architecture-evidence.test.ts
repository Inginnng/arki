import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openReadOnlyWorkspaceForTesting } from "./workspace.js";
import { discoverArchitecture } from "./architecture-discovery.js";
import { collectArchitectureEvidence } from "./architecture-evidence.js";

it("gives each package implementation evidence instead of exhausting the budget on manifests and barrels", async () => {
  const root = await mkdtemp(join(tmpdir(),"arki-evidence-"));
  try {
    for (let index=0;index<8;index++) {
      const directory=join(root,`packages/module-${index}`);await mkdir(join(directory,"src"),{recursive:true});
      await writeFile(join(directory,"package.json"),JSON.stringify({name:`module-${index}`}));
      await writeFile(join(directory,"src/index.ts"),'export * from "./service.js";\n');
      await writeFile(join(directory,"src/service.ts"),`export function process${index}(input: string) { return input.trim(); }\n`);
    }
    const workspace=await openReadOnlyWorkspaceForTesting(root);const graph=await discoverArchitecture(workspace);
    const evidence=await collectArchitectureEvidence(workspace,graph,graph.nodes.map(node=>node.id),graph.edges.map(edge=>edge.id),"解释职责和流程");
    expect(evidence.length).toBeLessThanOrEqual(24);
    for(let index=0;index<8;index++) expect(evidence.some(ref=>ref.path===`packages/module-${index}/src/service.ts` && ref.excerpt.includes(`process${index}`))).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain(root);
    // AI-updated nodes may cite only implementation. Later questions must still find sibling code.
    for(const node of graph.nodes) node.sources=node.sources.filter(ref=>!ref.path.endsWith("package.json"));
    const next=await collectArchitectureEvidence(workspace,graph,graph.nodes.map(node=>node.id),[],"继续解释");
    expect(next.filter(ref=>ref.path.endsWith("/service.ts"))).toHaveLength(8);
    const controller=new AbortController();controller.abort();
    await expect(collectArchitectureEvidence(workspace,graph,graph.nodes.map(node=>node.id),[],"取消",controller.signal)).rejects.toThrow("ARCHITECTURE_CANCELLED");
  } finally { await rm(root,{recursive:true,force:true}); }
});
