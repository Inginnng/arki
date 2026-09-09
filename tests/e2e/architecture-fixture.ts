import { renderArchitecture } from "../../packages/workspace-server/src/archify-renderer.js";
import type { ArchitectureGraph, ArchitectureView } from "@aimd/contracts";
const ref = { path: "gateway.ts", startLine: 1, endLine: 1, fileHash: "a".repeat(64) };
export const graph: ArchitectureGraph = { id: "fixture", version: 1, title: "项目架构", nodes: [
  { id: "gateway", kind: "frontend", label: "Gateway", summary: "请求入口", detail: "接收入口请求。", sources: [ref] },
  { id: "worker", kind: "backend", label: "Worker", summary: "业务处理", detail: "处理请求。", sources: [ref] },
], edges: [{ id: "requests", from: "gateway", to: "worker", label: "引用", detail: "Gateway 引用 Worker。", sources: [ref] }], notes: ["根据项目代码生成依赖关系。"] };
export async function renderFixture(value = graph) { return { graph: value, rendering: (await renderArchitecture(value)).rendering, stale: false } satisfies ArchitectureView; }
