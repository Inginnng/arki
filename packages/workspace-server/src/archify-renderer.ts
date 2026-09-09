import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ArchitectureGraphSchema, ArchitectureRenderSchema, type ArchitectureGraph, type ArchitectureRendering } from "@aimd/contracts";

import { ArchitectureError } from "./architecture-errors.js";
import { architectureOverview } from "./architecture-layout.js";

const execute = promisify(execFile);
declare const ARKI_PACKAGED: boolean;
const cli = fileURLToPath(new URL(typeof ARKI_PACKAGED !== "undefined" && ARKI_PACKAGED ? "./archify/bin/archify.mjs" : "../../../third_party/archify/bin/archify.mjs", import.meta.url));
export type ArchifyArtifact = { rendering: ArchitectureRendering; html: string; specification: unknown };

export function architectureSpecification(raw: ArchitectureGraph) {
  const graph = ArchitectureGraphSchema.parse(raw);
  const { components, connections, width, height, primaryIds } = architectureOverview(graph);
  return {
    schema_version: 1, diagram_type: "architecture", meta: { title: graph.title, locale: "zh-CN", quality_profile: "showcase", viewBox: [width, height], legend: { mode: "hidden" } },
    components,
    cards: [...(graph.narrative ? [{ dot: "cyan", title: graph.narrative.title, items: [graph.narrative.summary] }] : []), ...graph.nodes.map(node => ({ dot: "emerald", title: node.label, items: [node.detail, ...node.sources.map(ref => `${ref.path}:${ref.startLine}-${ref.endLine}`)] })), ...graph.edges.map(edge => ({ dot: "slate", title: `${graph.nodes.find(node => node.id === edge.from)!.label} → ${graph.nodes.find(node => node.id === edge.to)!.label}`, items: [edge.label, edge.detail, ...edge.sources.map(ref => `${ref.path}:${ref.startLine}-${ref.endLine}`)] }))],
    connections: connections.map(edge => {
      const from = components.find(node => node.id === edge.from)!;
      const to = components.find(node => node.id === edge.to)!;
      const down = to.pos[1]! > from.pos[1]!;
      const across = to.pos[0]! > from.pos[0]!;
      const vertical = to.pos[1] !== from.pos[1];
      const branches = connections.filter(other => other.from === edge.from).length;
      // A straight branch label belongs beyond the fanout corridor, near its child.
      const labelDy = vertical && from.pos[0] === to.pos[0] && branches > 1 ? (down ? 1 : -1) * (Math.abs(to.pos[1]! - from.pos[1]!) - 104) / 4 : undefined;
      return { id: edge.id, from: edge.from, to: edge.to, label: edge.label, variant: edge.kind === "dependency" || (!edge.kind && edge.label === "引用") ? "dashed" : primaryIds.has(edge.id) ? "emphasis" : "default", fromSide: vertical ? down ? "bottom" : "top" : across ? "right" : "left", toSide: vertical ? down ? "top" : "bottom" : across ? "left" : "right", ...(labelDy === undefined ? {} : { labelDy }) };
    }),
  };
}

export async function renderArchitecture(graph: ArchitectureGraph, signal?: AbortSignal): Promise<ArchifyArtifact> {
  const directory = await mkdtemp(join(tmpdir(), "aimd-archify-"));
  try {
    const specification = architectureSpecification(graph);
    const input = join(directory, "diagram.json");
    const output = join(directory, "diagram.html");
    await writeFile(input, JSON.stringify(specification), "utf8");
    let stdout: string;
    try {
      ({ stdout } = await execute(process.execPath, [cli, "deliver", "architecture", input, output, "--quality", "showcase", "--json"], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) }));
    } catch (error) {
      if (signal?.aborted) throw new Error("ARCHITECTURE_CANCELLED");
      throw new ArchitectureError("ARCHITECTURE_LAYOUT_INVALID", layoutIssues((error as { stdout?: string }).stdout, graph));
    }
    const receipt = JSON.parse(stdout);
    if (receipt.ok !== true || receipt.validation.errors !== 0 || receipt.validation.ambiguousCorridors !== 0) throw new ArchitectureError("ARCHITECTURE_LAYOUT_INVALID", [{ code: "ARCHIFY_COMPOSITION", message: "图形检查未通过，或存在难以区分的共线走廊。", expected: "错误 0，共线走廊 0", actual: `错误 ${Number(receipt.validation.errors)}, 共线走廊 ${Number(receipt.validation.ambiguousCorridors)}` }]);
    const html = await readFile(output, "utf8");
    const svg = html.match(/<svg\b[^>]*aria-labelledby="archify-diagram-title archify-diagram-description"[^>]*>[\s\S]*?<\/svg>/u)?.[0];
    const css = html.match(/<style>([\s\S]*?)<\/style>/u)?.[1];
    if (!svg || !css || /<script|\son\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|javascript:)/iu.test(svg)) throw new Error("ARCHITECTURE_LAYOUT_INVALID");
    const rendering = ArchitectureRenderSchema.parse({ svg, css, displayedEdgeIds: specification.connections.map(edge => edge.id), readingOrder: specification.components.map(node => node.id), receipt: { specificationHash: receipt.specification.sha256, artifactHash: receipt.artifact.sha256, checksPassed: receipt.validation.checksPassed, checkCount: receipt.validation.checkCount, errors: receipt.validation.errors, warnings: receipt.validation.warnings } });
    return { rendering, html, specification };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function layoutIssues(stdout: string | undefined, graph: ArchitectureGraph) {
  try {
    const report = JSON.parse(stdout ?? "{}");
    const ids = new Set([...graph.nodes, ...graph.edges].map(item => item.id));
    const descriptions: Record<string, string> = {
      "clean-flow/endpoint-side-direction": "连线进入或离开模块的方向不正确。",
      "clean-flow/component-crossing": "连线穿过了不相关的模块。",
      "composition/ambiguous-corridor": "多条连线共用走廊，难以区分关系。",
      "clean-flow/route-rhythm": "连线转折过短或布局过于拥挤。",
      "composition/label-route-clearance": "连线与文字标签间距不足。",
    };
    if (!Array.isArray(report.diagnostics)) return [{ code: "ARCHIFY_RENDER_FAILED", message: "Archify 未能生成通过检查的图形。" }];
    return report.diagnostics.slice(0, 12).map((item: { code?: unknown; subject?: { id?: unknown; index?: unknown } }) => ({
      code: typeof item.code === "string" && /^[a-zA-Z0-9_/-]+$/u.test(item.code) ? ("ARCHIFY_" + item.code.replace(/[^a-zA-Z0-9_]/gu, "_").toUpperCase()).slice(0, 80) : "ARCHIFY_LAYOUT_CHECK",
      message: descriptions[String(item.code)] ?? "该对象未通过 Archify 的几何或布局约束。",
      ...(typeof item.subject?.id === "string" && ids.has(item.subject.id) ? { objectId: item.subject.id } : {}),
      ...(typeof item.subject?.index === "number" && Number.isSafeInteger(item.subject.index) ? { field: "diagram.objects." + item.subject.index } : {}),
    }));
  } catch { return [{ code: "ARCHIFY_RENDER_FAILED", message: "Archify 未返回可读取的布局诊断。" }]; }
}
