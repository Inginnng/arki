import { posix } from "node:path";
import type { ArchitectureGraph, ArchitectureEvidence, ArchitectureSource } from "@aimd/contracts";
import type { ReadOnlyWorkspace } from "./workspace.js";

const code = (path: string) => /\.(?:[cm]?[jt]sx?|py|rs|go|java|[ch](?:pp)?|cs|kt|swift|rb)$/u.test(path) && !/(?:^|\/)(?:third_party|vendor|dist|generated|tests?|docs|\.tmp|\.codex|\.agents)\//u.test(path) && !/\.(?:test|spec)\./u.test(path);
const directory = (sources: ArchitectureSource[]) => {
  const manifest = sources.find(ref => /(?:^|\/)package\.json$/u.test(ref.path));
  if (manifest) return posix.dirname(manifest.path) === "." ? "" : posix.dirname(manifest.path) + "/";
  const implementation = sources.find(ref => code(ref.path));
  if (implementation?.path.includes("/src/")) return implementation.path.split("/src/", 1)[0] + "/";
  return null;
};

/** Spend the evidence budget across modules and implementations, not just manifests/import lines. */
export async function collectArchitectureEvidence(workspace: ReadOnlyWorkspace, graph: ArchitectureGraph, nodeIds: string[], edgeIds: string[], question: string, signal?: AbortSignal) {
  const evidence: ArchitectureEvidence[] = [];
  const check = () => { if (signal?.aborted) throw new Error("ARCHITECTURE_CANCELLED"); };
  const add = async (ref: ArchitectureSource) => {
    check();
    if (evidence.length >= 24 || evidence.some(item => item.path === ref.path && item.startLine <= ref.startLine && item.endLine >= ref.endLine)) return;
    const file = await workspace.readFile(ref.path, { startLine: ref.startLine, endLine: ref.endLine });
    if (file.fileHash !== ref.fileHash || file.endLine < ref.endLine) throw new Error("ARCHITECTURE_SOURCE_CHANGED");
    evidence.push({ ...ref, id: `evidence-${evidence.length + 1}`, excerpt: file.lines.map(line => `${line.line}: ${line.text}`).join("\n") });
  };
  const addImplementation = async (path: string) => {
    check();
    const file = await workspace.readFile(path).catch(() => null);
    if (!file?.lines.length) return;
    // Start where implementation begins, rather than spending a whole excerpt on imports.
    const first = file.lines.find(line => /(?:export\s+)?(?:async\s+)?function\s|(?:export\s+)?class\s|createServer\(|def\s|impl\s|func\s|export\s+const\s/u.test(line.text))?.line ?? 1;
    const startLine = Math.max(1, first - 3);
    await add({ path, startLine, endLine: Math.min(file.totalLines, startLine + 99), fileHash: file.fileHash });
    return file;
  };
  const nodes = graph.nodes.filter(node => nodeIds.includes(node.id));
  const listing = await workspace.listProjectFiles(700);
  const paths = listing.paths.filter(code);
  const modules = graph.nodes.map(node => ({ node, directory: directory(node.sources) }));
  const owner = (path: string) => modules.filter(module => module.directory !== null && path.startsWith(module.directory)).sort((a,b) => b.directory!.length - a.directory!.length)[0]?.node.id;
  const words = new Set((question.match(/[A-Za-z_][A-Za-z0-9_-]{2,40}/gu) ?? []).map(word => word.toLowerCase()));
  const score = (path: string) => {
    const name = posix.basename(path).toLowerCase();
    return (/(?:service|runtime|workbench|server|api|router|controller|engine)/u.test(name) ? 20 : 0) + [...words].filter(word => name.includes(word)).length * 30 - (/^(?:index|main)\./u.test(name) ? 25 : 0);
  };
  const candidates = nodes.map(node => {
    const owned = paths.filter(path => owner(path) === node.id).sort((a,b) => score(b) - score(a) || a.localeCompare(b));
    const originals = node.sources.filter(ref => code(ref.path)).map(ref => ref.path);
    return { node, paths: [...new Set([...owned.slice(0, 3), ...originals])], originals };
  });
  // One current source per module first; all modules retain a foothold even at the cap.
  for (const { node, originals } of candidates) {
    if (originals[0]) await addImplementation(originals[0]);
    else await add(node.sources[0]!);
  }
  for (let round = 0; round < 2; round++) for (const item of candidates) {
    if (evidence.length >= 21) break;
    const path = item.paths.filter(path => path !== item.originals[0])[round];
    if (path) await addImplementation(path);
  }
  // Import evidence alone must never become an asserted request/call flow.
  for (const edge of graph.edges.filter(edge => edgeIds.includes(edge.id))) {
    const ref = edge.sources.find(ref => code(ref.path)) ?? edge.sources[0]!;
    await add(ref);
  }
  return evidence;
}
