import { createHash } from "node:crypto";
import { posix } from "node:path";
import { ArchitectureGraphSchema, type ArchitectureEdge, type ArchitectureGraph, type ArchitectureNode, type ArchitectureSource } from "@aimd/contracts";
import type { ReadOnlyWorkspace, WorkspaceExcerpt } from "./workspace.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const source = (file: WorkspaceExcerpt, line?: number): ArchitectureSource => ({ path: file.path, startLine: line ?? file.startLine, endLine: line ?? Math.min(file.endLine, file.startLine + 100), fileHash: file.fileHash });
const isCode = (path: string) => /\.(?:[cm]?[jt]sx?|py|rs|go|java|[ch](?:pp)?|cs|kt|swift|rb)$/u.test(path) && !/(?:^|\/)(?:third_party|vendor|docs|tests?|\.tmp|\.agents|\.codex)\//u.test(path) && !/(?:\.(?:test|spec)\.|\/mock[.-])/u.test(path);
type Module = { directory: string; name: string; node: ArchitectureNode; manifest?: Record<string, unknown>; file?: WorkspaceExcerpt };

export async function discoverArchitecture(workspace: ReadOnlyWorkspace): Promise<ArchitectureGraph> {
  const listing = await workspace.listProjectFiles(700);
  const paths = listing.paths.filter(path => !/(?:^|\/)(?:third_party|vendor|\.tmp|\.agents|\.codex|tests?)\//u.test(path));
  const modules: Module[] = [];
  const manifests = paths.filter(path => /(?:^|\/)package\.json$/u.test(path)).slice(0, 12);
  let incomplete = listing.truncated;
  for (const path of manifests) {
    const file = await workspace.readFile(path).catch(() => null);
    if (!file || !file.lines.length) { incomplete = true; continue; }
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(file.lines.map(line => line.text).join("\n")); }
    catch { incomplete = true; continue; }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) continue;
    const name = typeof manifest.name === "string" ? manifest.name : posix.dirname(path);
    const label = name.split("/").at(-1)!.slice(0, 40) || "项目入口";
    const dependencies = manifest.dependencies && typeof manifest.dependencies === "object" ? manifest.dependencies as Record<string, unknown> : {};
    modules.push({ directory: posix.dirname(path) === "." ? "" : posix.dirname(path), name, manifest, file,
      node: { id: `module-${digest(path)}`, label, codeName: label, kind: "react" in dependencies ? "frontend" : "backend", summary: "职责待解读", detail: `包 ${name}，定义于 ${path}。`, sources: [source(file)] } });
  }
  const codePaths = paths.filter(isCode).sort((a, b) => Number(!/(?:main|index|start-web|server|app)\./u.test(a)) - Number(!/(?:main|index|start-web|server|app)\./u.test(b)) || a.localeCompare(b)).slice(0, 100);
  if (!modules.length) {
    for (const path of codePaths.slice(0, 8)) {
      const file = await workspace.readFile(path).catch(() => null);
      if (!file || !file.lines.length) continue;
      modules.push({ directory: path, name: path, node: { id: `file-${digest(path)}`, label: posix.basename(path).slice(0, 40), kind: "backend", summary: "源代码文件", detail: `当前项目文件 ${path}。`, sources: [source(file)] } });
    }
  }
  if (!modules.length) throw new Error("ARCHITECTURE_NO_SOURCE");
  const withoutExtension = (path: string) => path.replace(/\.[cm]?[jt]sx?$/u, "");
  const owner = (path: string) => modules.filter(module => module.directory === "" || path === module.directory || path.startsWith(module.directory + "/") || (isCode(module.directory) && withoutExtension(path) === withoutExtension(module.directory))).sort((a, b) => b.directory.length - a.directory.length)[0];
  const edges = new Map<string, ArchitectureEdge>();
  const connect = (from: Module, to: Module, ref: ArchitectureSource, detail: string) => {
    if (from.node.id === to.node.id) return;
    const id = `relation-${digest(from.node.id + ":" + to.node.id)}`;
    const previous = edges.get(id);
    if (previous) {
      if (previous.sources.length < 4 && !previous.sources.some(item => item.path === ref.path && item.startLine === ref.startLine)) previous.sources.push(ref);
      return;
    }
    if (edges.size >= 24) { incomplete = true; return; }
    edges.set(id, { id, from: from.node.id, to: to.node.id, label: "代码依赖", kind: "dependency", detail, sources: [ref] });
  };
  for (const module of modules) {
    if (!module.manifest || !module.file) continue;
    const dependencies = { ...(module.manifest.dependencies as object ?? {}), ...(module.manifest.devDependencies as object ?? {}) };
    for (const name of Object.keys(dependencies)) {
      const target = modules.find(item => item.name === name);
      const line = module.file.lines.find(item => item.text.includes(JSON.stringify(name)));
      if (target && line) connect(module, target, source(module.file, line.line), `${module.node.label} 在 ${module.file.path} 声明了对 ${target.node.label} 的依赖。`);
    }
  }
  for (const path of codePaths) {
    const module = owner(path);
    if (!module) continue;
    const file = await workspace.readFile(path).catch(() => null);
    if (!file || !file.lines.length) { incomplete = true; continue; }
    if (module.node.sources.length < 2 && !module.node.sources.some(item => item.path === path)) module.node.sources.push(source(file));
    for (const line of file.lines) {
      for (const match of line.text.matchAll(/(?:from\s+|import\s*\(|require\s*\(|import\s*)["']([^"']+)["']/gu)) {
        const name = match[1]!;
        const target = modules.find(item => name === item.name || name.startsWith(item.name + "/")) ?? (name.startsWith(".") && !/\.(?:md|css|json|html)(?:\?|$)/u.test(name) ? owner(posix.normalize(posix.join(posix.dirname(path), name))) : undefined);
        if (target) connect(module, target, source(file, line.line), `${path} 从 ${name} 导入代码。此连线表示代码依赖，不代表每次请求都会执行。`);
      }
    }
  }
  const graph = ArchitectureGraphSchema.parse({
    id: `architecture-${digest(modules.map(module => module.name).join(":"))}`, version: 1, title: "项目架构",
    nodes: modules.map(module => module.node), edges: [...edges.values()],
    notes: ["草图根据包声明和代码导入生成；虚线只表示静态依赖，尚未解读职责与运行流程。", ...(incomplete || paths.filter(isCode).length > codePaths.length ? ["扫描范围有限，未覆盖全部源文件。"] : [])],
  });
  return graph;
}
