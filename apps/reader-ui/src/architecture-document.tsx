import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ArchitectureGraph, ArchitectureTarget, ArchitectureSource } from "@aimd/contracts";
import { ArchitectureReading } from "./architecture-reading.js";
import { architectureScenarios, flowTransitionName } from "./architecture-flows.js";

const plain = (text: string) => text.replace(/[\\`*_{}\[\]<>#|]/gu, value => "\\" + value);
const refs = (sources: ArchitectureSource[]) => sources.map(source => `- ${plain(source.path)}:${source.startLine}–${source.endLine}`).join("\n");
export function architectureMarkdown(graph: ArchitectureGraph): string {
  const narrative = graph.narrative;
  return [`# ${plain(graph.title)} · 架构说明`, ...(narrative ? [`## ${plain(narrative.title)}`, plain(narrative.summary), ...narrative.edgeIds.map((id, index) => { const edge = graph.edges.find(edge => edge.id === id)!; return `${index + 1}. **${plain(edge.label)}**：${plain(graph.nodes.find(node => node.id === edge.from)!.label)} → ${plain(graph.nodes.find(node => node.id === edge.to)!.label)}。${plain(edge.detail)}`; }), "代码证据：", refs(narrative.sources)] : ["## 分析范围", ...graph.notes.map(note => `> ${plain(note)}`)]), ...(graph.groups?.length ? ["## 组件归属", ...graph.groups.flatMap(group => ["### " + plain(group.label), plain(group.summary), plain(group.detail), "上级：" + plain(graph.groups?.find(item => item.id === group.parentId)?.label ?? "项目"), "包含：" + group.nodeIds.map(id => plain(graph.nodes.find(node => node.id === id)!.label)).join("、"), refs(group.sources)])] : []), "## 模块职责", ...graph.nodes.flatMap(node => [`### ${plain(node.label)}${node.codeName && node.codeName !== node.label ? ` · ${plain(node.codeName)}` : ""}`, plain(node.summary), plain(node.detail), "代码证据：", refs(node.sources)]), "## 全部模块关系", "> 图中突出主线和支路，以下保留全部关系。代码依赖不等同于运行时调用。", ...(graph.edges.length ? graph.edges.flatMap(edge => [`### ${plain(graph.nodes.find(node => node.id === edge.from)!.label)} → ${plain(graph.nodes.find(node => node.id === edge.to)!.label)}`, `**${plain(edge.label)}**${edge.kind === "dependency" ? " · 静态依赖" : ""}`, plain(edge.detail), ...(edge.transfer ? ["传输数据：" + plain(edge.transfer.payload), "调用方式：" + plain(edge.transfer.mechanism), "接收方处理：" + plain(edge.transfer.processing), "返回 / 结果：" + plain(edge.transfer.result)] : []), "代码证据：", refs(edge.sources)]) : ["当前扫描尚未确认模块间的关系。"])].join("\n\n") + "\n" + architectureFlowMarkdown(graph);
}
export function ArchitectureDocument({ graph, onSelect, onSource }: { graph: ArchitectureGraph; onSelect: (target: ArchitectureTarget) => void; onSource: (path: string, line: number) => void }) {
  return <article className="architecture-document" aria-label="架构说明文档">
    <header><span className="architecture-eyebrow">ARKI / ARCHITECTURE NOTES</span><h2>{graph.title} · 架构说明</h2><p>文档与架构图使用同一份分析。选择章节继续提问，点击来源阅读实现。</p></header>
    {graph.narrative ? <ArchitectureReading graph={graph} onSelect={onSelect} /> : <><h3>分析范围</h3>{graph.notes.map((note, index) => <p className="architecture-note" key={index}>{note}</p>)}</>}
    {graph.groups?.length ? <><h3>组件归属</h3>{graph.groups.map(group => <section key={group.id}><div className="architecture-document-heading"><h4>{group.label}</h4><button onClick={() => onSelect({ kind: "group", id: group.id })}>提问此子系统</button></div><strong>{group.summary}</strong><p>{group.detail}</p><p>上级：{graph.groups?.find(item => item.id === group.parentId)?.label ?? "项目"} · 包含：{group.nodeIds.map(id => graph.nodes.find(node => node.id === id)!.label).join("、")}</p><SourceLinks sources={group.sources} onSource={onSource} /></section>)}</> : null}
    <ArchitectureFlowDocument graph={graph} onSource={onSource} />
    <h3>模块职责</h3>
    {graph.nodes.map(node => <section key={node.id}><div className="architecture-document-heading"><div><h4>{node.label}</h4>{node.codeName && node.codeName !== node.label ? <p className="architecture-document-code">{node.codeName}</p> : null}</div><button onClick={() => onSelect({ kind: "node", id: node.id })}>提问此模块</button></div><strong>{node.summary}</strong><p>{node.detail}</p><SourceLinks sources={node.sources} onSource={onSource} /></section>)}
    <h3>全部模块关系</h3>
    {graph.edges.map(edge => <section key={edge.id}><div className="architecture-document-heading"><h4>{graph.nodes.find(node => node.id === edge.from)?.label} → {graph.nodes.find(node => node.id === edge.to)?.label}</h4><button onClick={() => onSelect({ kind: "edge", id: edge.id })}>提问此关系</button></div><strong>{edge.label}</strong><p>{edge.detail}</p>{edge.transfer ? <dl className="arki-transfer-facts"><dt>传输数据</dt><dd>{edge.transfer.payload}</dd><dt>调用方式</dt><dd>{edge.transfer.mechanism}</dd><dt>接收方处理</dt><dd>{edge.transfer.processing}</dd><dt>返回 / 结果</dt><dd>{edge.transfer.result}</dd></dl> : null}<SourceLinks sources={edge.sources} onSource={onSource} /></section>)}
    {!graph.edges.length ? <p>当前扫描尚未确认模块间的关系。</p> : null}
  </article>;
}
function SourceLinks({ sources, onSource }: { sources: ArchitectureSource[]; onSource: (path: string, line: number) => void }) {
  return <div className="architecture-sources">{sources.map((source, index) => <button key={index} onClick={() => onSource(source.path, source.startLine)}>{source.path}:{source.startLine}–{source.endLine}</button>)}</div>;
}
export function architectureFlowMarkdown(graph: ArchitectureGraph): string {
  return ["\n## 典型流程",...(graph.flowIssues??[]).map(issue=>"> 待核对："+plain(issue)),...architectureScenarios(graph).flatMap(flow=>["### "+plain(flow.label)+(flow.legacy?"（旧版主线）":""),plain(flow.summary),"触发："+plain(flow.trigger),"入口步骤："+plain(flow.steps.find(step=>step.id===flow.entryStepId)!.label),...(flow.issues??[]).map(issue=>"> 待核对："+plain(issue)),"步骤编号用于定位，不表示所有分支串行执行。",...flow.steps.flatMap((step,index)=>["#### "+(index+1)+". "+plain(step.label),"执行组件："+plain(graph.nodes.find(node=>node.id===step.nodeId)!.label),"输入："+plain(step.input),"处理："+plain(step.processing),"输出："+plain(step.output),refs(step.sources)]),"#### 数据传递与条件",...flow.transitions.flatMap((edge,index)=>[(index+1)+". "+plain(flow.steps.find(step=>step.id===edge.from)!.label)+" → "+plain(flow.steps.find(step=>step.id===edge.to)!.label)+"（"+flowTransitionName[edge.kind]+"）",...(edge.condition?["条件："+plain(edge.condition)]:[]),"数据："+plain(edge.payload),"机制："+plain(edge.mechanism),refs(edge.sources)])])].join("\n\n")+"\n";
}
function ArchitectureFlowDocument({graph,onSource}:{graph:ArchitectureGraph;onSource:(path:string,line:number)=>void}) {
  return <><h3>典型流程</h3>{graph.flowIssues?.map((issue,index)=><p className="architecture-note" key={index}>{issue}</p>)}{architectureScenarios(graph).map(flow=><section key={flow.id}><h4>{flow.label}{flow.legacy?" · 旧版主线":""}</h4><p>{flow.summary}</p><p>触发：{flow.trigger}</p>{flow.issues?.map((issue,index)=><p className="architecture-note" key={index}>{issue}</p>)}<p>步骤编号用于定位，不代表所有分支串行执行。</p>{flow.steps.map((step,index)=><details key={step.id}><summary>{index+1}. {step.label} · {graph.nodes.find(node=>node.id===step.nodeId)?.label}</summary><p>输入：{step.input}</p><p>处理：{step.processing}</p><p>输出：{step.output}</p><SourceLinks sources={step.sources} onSource={onSource}/></details>)}<h4>数据传递与条件</h4>{flow.transitions.map((edge,index)=><div key={edge.id}><p>{index+1}. {flow.steps.find(step=>step.id===edge.from)?.label} → {flow.steps.find(step=>step.id===edge.to)?.label} · {flowTransitionName[edge.kind]}{edge.condition?" · "+edge.condition:""}</p><p>{edge.payload} · {edge.mechanism}</p><SourceLinks sources={edge.sources} onSource={onSource}/></div>)}</section>)}{!architectureScenarios(graph).length?<p>当前分析尚未确认典型流程。</p>:null}</>;
}
export function AnswerMarkdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>{children}</ReactMarkdown>;
}
export function downloadText(text: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type })); const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
