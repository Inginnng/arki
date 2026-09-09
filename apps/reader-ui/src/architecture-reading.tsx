import type { ArchitectureGraph, ArchitectureTarget } from "@aimd/contracts";

import "./architecture-reading.css";

export const isArchitectureDraft = (graph: ArchitectureGraph) => !graph.narrative && graph.nodes.every(node => /^(?:工作区模块|React 界面|源代码文件|职责待解读)$/u.test(node.summary));
export function ArchitectureReading({ graph, onSelect }: { graph: ArchitectureGraph; onSelect: (target: ArchitectureTarget) => void }) {
  const narrative = graph.narrative;
  if (!narrative) return null;
  const edges = narrative.edgeIds.map(id => graph.edges.find(edge => edge.id === id)!);
  return <section className="architecture-reading" aria-label="架构阅读主线"><span className="architecture-eyebrow">从一次操作看懂系统</span><h2>{narrative.title}</h2><p>{narrative.summary}</p><ol>{edges.map((edge, index) => <li key={edge.id}><button onClick={() => onSelect({ kind: "edge", id: edge.id })}><span className="architecture-step-number">{String(index + 1).padStart(2,"0")}</span><span><strong>{edge.label}</strong><small>{graph.nodes.find(node => node.id === edge.from)?.label} → {graph.nodes.find(node => node.id === edge.to)?.label}</small></span></button></li>)}</ol></section>;
}
export function ArchitectureRelations({ graph, displayedEdgeIds, onSelect }: { graph: ArchitectureGraph; displayedEdgeIds?: string[] | undefined; onSelect: (target: ArchitectureTarget) => void }) {
  return <details className="architecture-relations"><summary>全部关系 <span>{graph.edges.length}</span></summary><p>静态依赖与运行流程分别标明。选择关系查看具体实现和代码来源。</p><div>{graph.edges.map(edge => <button key={edge.id} onClick={() => onSelect({ kind: "edge", id: edge.id })}><span>{graph.nodes.find(node => node.id === edge.from)?.label}<b aria-hidden="true"> → </b>{graph.nodes.find(node => node.id === edge.to)?.label}</span><strong>{edge.label}</strong><small>{edge.kind === "dependency" || (!edge.kind && edge.label === "引用") ? "代码依赖" : edge.kind === "flow" ? "调用 / 数据传递" : "模块关系"}{displayedEdgeIds && !displayedEdgeIds.includes(edge.id) ? " · 当前视图未展开" : ""}</small></button>)}</div></details>;
}
