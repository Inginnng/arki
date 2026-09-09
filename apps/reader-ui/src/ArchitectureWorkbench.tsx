import { useEffect, useRef, useState } from "react";
import { ArchitectureResultSchema, ArchitectureFailureSchema, type ArchitectureFailure, type ArchitectureEditScope, ArchitectureViewSchema, type ArchitectureGraph, type ArchitectureTarget, type ArchitectureView, type ArchitectureResult } from "@aimd/contracts";
import { ArchitectureFailurePanel, ArchitectureRequestError } from "./ArchitectureFailurePanel.js";
import { exportArchitectureHtml } from "./architecture-export.js";
import { ArchitectureDiagram } from "./ArchitectureDiagram.js";
import { ArchitectureFlowPicker, ArchitectureFlowReader } from "./ArchitectureFlowReader.js";
import { architectureScenarios } from "./architecture-flows.js";
import type { ArchitectureDiagramMode } from "./architecture-graph-layout.js";
import { loadGraphHistory, saveGraphHistory, type GraphHistory } from "./architecture-store.js";
import { ArchitectureDocument, AnswerMarkdown, architectureMarkdown, downloadText } from "./architecture-document.js";
import { ArchitectureReading, ArchitectureRelations, isArchitectureDraft } from "./architecture-reading.js";
import "./architecture-workbench.css";
const analysisPrompt = "请阅读实际实现，组织组件职责与嵌套边界，并识别有证据支持的典型操作或异常场景 flows。每个场景独立定义步骤、触发条件、数据传递、分支与结果；允许同一组件参与多个步骤。区分静态依赖与实际调用。没有证据的场景不编造，明确记录未确认环节。";
const failures: Record<string, string> = {
  ARCHITECTURE_SOURCE_CHANGED: "项目代码已变化，请重新生成架构后提问。原有版本仍可查看。",
  ARCHITECTURE_LAYOUT_INVALID: "这次调整未通过图形布局检查，已保留原图。请缩小修改范围后重试。",
  ARCHITECTURE_OUTPUT_INVALID: "AI 返回的修改不符合选区或证据要求，已保留原图。",
  ARCHITECTURE_NO_SOURCE: "未找到可用于生成架构的源文件。",
  ARCHITECTURE_BUSY: "另一个架构问题正在处理，请稍后重试。",
  ARCHITECTURE_MODEL_FAILED: "AI 本次未能完成，请检查 Codex 连接后重试。原图已保留。",
};
async function call(body: unknown, signal: AbortSignal, projectKey: string) {
  const response = await fetch("/api/architecture", { method: "POST", headers: { "content-type": "application/json", "x-arki-project": projectKey }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(250000)]) }).catch(() => { throw new Error("本地架构服务暂未连接。当前分析已保留，后台恢复后可重新提交。"); });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    const parsed = ArchitectureFailureSchema.safeParse(result.error);
    if (parsed.success) throw new ArchitectureRequestError(parsed.data);
    throw new Error(failures[result.error?.code] ?? "架构服务暂时不可用，请重试。");
  }
  return result.data;
}
export function ArchitectureWorkbench({ storageKey, onSource, connected = true, connectionRevision = 0, analyzeRequest = 0 }: { storageKey: string; onSource: (path: string, line: number) => void; connected?: boolean; connectionRevision?: number; analyzeRequest?: number }) {
  const request = (body: unknown, signal: AbortSignal) => call(body, signal, storageKey);
  const conversation = () => (historyRef.current?.conversations ?? []).slice(-6).map(({ question, answer }) => ({ question, answer }));
  const [diagramMode, setDiagramMode] = useState<ArchitectureDiagramMode>("structure");
  const documentDialog = useRef<HTMLDialogElement>(null);
  const [flowId,setFlowId] = useState("");
  const [flowStepId,setFlowStepId] = useState("");
  const [flowTransitionId,setFlowTransitionId] = useState<string>();
  const [flowTrail,setFlowTrail] = useState<string[]>([]);
  const [verified, setVerified] = useState(false);
  const [wholeQuestion, setWholeQuestion] = useState("");
  const consumedAnalyze = useRef(0);
  const automaticAnalysis = useRef(false);
  const historyRef = useRef<GraphHistory | null>(null);
  const [view, setView] = useState<ArchitectureView | null>(null);
  const [history, setHistory] = useState<GraphHistory | null>(null);
  const [target, setTarget] = useState<ArchitectureTarget | null>(null);
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<ArchitectureEditScope>("related");
  const [diagnostic, setDiagnostic] = useState<ArchitectureFailure | null>(null);
  const [result, setResult] = useState<ArchitectureResult | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [dark, setDark] = useState(false);
  const [persistence, setPersistence] = useState<"saving" | "saved" | "memory">("saving");
  const pending = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const saveEpoch = useRef(0);
  const selected = target && view ? (target.kind === "group" ? view.graph.groups ?? [] : target.kind === "node" ? view.graph.nodes : view.graph.edges).find(item => item.id === target.id) : null;
  const scenarios = view ? architectureScenarios(view.graph) : [];
  const flow = scenarios.find(item=>item.id===flowId) ?? scenarios[0];
  const flowStep = flow?.steps.find(step=>step.id===flowStepId) ?? flow?.steps.find(step=>step.id===flow.entryStepId);
  const readingFlow = diagramMode === "flow" && flow && flowStep && (!target || target.kind === "node" && target.id === flowStep.nodeId);
  useEffect(()=>{if(diagramMode!=="flow")return;const frame=requestAnimationFrame(()=>document.querySelector(".architecture-inspector")?.scrollTo({top:0}));return()=>cancelAnimationFrame(frame);},[flow?.id,flowStep?.id,diagramMode]);
  useEffect(()=>{setFlowTrail([]);setFlowTransitionId(undefined);if(diagramMode === "flow" && flow){const step=flow.steps.find(step=>step.id===flow.entryStepId)!;setFlowStepId(step.id);setTarget({kind:"node",id:step.nodeId});}},[storageKey,flow?.id,view?.graph.version,diagramMode]);
  const store = async (next: GraphHistory, current: () => boolean) => {
    if (!current()) return;
    const saveTicket = ++saveEpoch.current;
    historyRef.current = next; setHistory(next); setPersistence("saving");
    try { await saveGraphHistory(storageKey, next); if (saveEpoch.current === saveTicket) setPersistence("saved"); }
    catch { if (saveEpoch.current === saveTicket) { setPersistence("memory"); setError("浏览器保存失败，当前图仍可使用。请导出保留成果。"); } }
  };
  const run = async (label: string, action: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    const ticket = ++epoch.current; setBusy(label); setError(""); setDiagnostic(null);
    const current = () => epoch.current === ticket && !controller.signal.aborted;
    try { await action(controller.signal, current); } catch (failure) { if (current()) { setError(failure instanceof Error ? failure.message : "操作失败，请重试。"); setDiagnostic(failure instanceof ArchitectureRequestError ? failure.failure : null); } }
    finally { if (epoch.current === ticket) { setBusy(""); pending.current = null; } }
  };
  useEffect(() => {
    setView(null); setHistory(null); historyRef.current = null; setTarget(null); setResult(null); setQuestion(""); setWholeQuestion(""); setPersistence("saving");
  }, [storageKey]);
  useEffect(() => {
    setVerified(false);
    void run("正在恢复项目分析…", async (signal, current) => {
      let saved: GraphHistory | null = null; let readable = true;
      try { saved = await loadGraphHistory(storageKey); } catch { readable = false; if (current()) setError("保存的架构无法恢复，原存档已保留。当前图仅在内存中，请导出保留成果。"); }
      if (!current()) return;
      if (saved) { historyRef.current = saved; setHistory(saved); setPersistence("saved"); if (saved.view) setView(saved.view); }
      if (!connected) return;
      const analyze = analyzeRequest > consumedAnalyze.current || (!saved && !automaticAnalysis.current);
      if (analyze) automaticAnalysis.current = true;
      const next = ArchitectureViewSchema.parse(await request({ operation: "open", ...(!analyze && saved ? { graph: saved.graphs[saved.cursor] } : {}) }, signal));
      if (!current()) return;
      if (!analyze || !saved?.view) setView(next); setVerified(true);
      const restored: GraphHistory = !saved ? { graphs: [next.graph], cursor: 0, view: next, conversations: [] } : analyze ? saved : { ...saved, view: next };
      if (readable) await store(restored, current); else { historyRef.current = restored; setHistory(restored); setPersistence("memory"); }
      if (analyze && current()) {
        consumedAnalyze.current = analyzeRequest;
        setBusy("AI 正在解读模块职责与架构关系…");
        const prompt = analysisPrompt;
        const result = ArchitectureResultSchema.parse(await request({ operation: "ask", graph: next.graph, target: { kind: "node", id: next.graph.nodes[0]!.id }, scope: "diagram", intent: "analyze", question: prompt }, signal));
        if (current()) await acceptResult(result, prompt, current, readable);
      }
    });
    return () => { epoch.current++; saveEpoch.current++; pending.current?.abort(); };
  }, [storageKey, connected, connectionRevision, analyzeRequest]);
  const acceptResult = async (next: ArchitectureResult, prompt: string, current: () => boolean, persist = true) => {
    if (!current()) return;
    const nextView = { graph: next.graph, rendering: next.rendering, stale: next.stale };
    setView(nextView); setResult(next);
    const previous = historyRef.current;
    const graphs = next.changedIds.length || !previous ? [...(previous?.graphs.slice(0, previous.cursor + 1) ?? []), next.graph].slice(-20) : previous.graphs;
    const conversations = [...(previous?.conversations ?? []), { question: prompt, answer: next.answer, limitations: next.limitations, evidence: next.evidence, version: next.graph.version, createdAt: new Date().toISOString() }].slice(-20);
    const record = { graphs, cursor: next.changedIds.length || !previous ? graphs.length - 1 : previous.cursor, view: nextView, conversations };
    if (persist) await store(record, current); else { historyRef.current = record; setHistory(record); setPersistence("memory"); }
  };
  const regenerate = () => void run("正在重新扫描项目…", async (signal, current) => {
    const next = ArchitectureViewSchema.parse(await request({ operation: "open" }, signal));
    if (!current()) return;
    setBusy("AI 正在解读模块职责与架构关系…");
    const analyzed = ArchitectureResultSchema.parse(await request({ operation: "ask", graph: next.graph, target: { kind: "node", id: next.graph.nodes[0]!.id }, scope: "diagram", intent: "analyze", question: analysisPrompt }, signal));
    if (!current()) return; setTarget(null); setResult(null); setVerified(true); await acceptResult(analyzed, analysisPrompt, current);
  });
  const travel = (cursor: number) => void run("正在恢复架构…", async (signal, current) => {
    if (!history?.graphs[cursor]) return;
    const next = ArchitectureViewSchema.parse(await request({ operation: "open", graph: history.graphs[cursor] }, signal));
    if (!current()) return; setView(next); setTarget(null); setResult(null); setVerified(true); await store({ ...history, cursor, view: next }, current);
  });
  const ask = () => void run("AI 正在查阅代码并完善选区…", async (signal, current) => {
    if (!view || !target) return;
    const prompt = readingFlow && flow && flowStep ? "针对典型流程「" + flow.label + "」中的步骤「" + flowStep.label + "」（" + flowStep.id + "）：\n" + question : question;
    const next = ArchitectureResultSchema.parse(await request({ operation: "ask", graph: view.graph, target, question: prompt, scope: readingFlow ? "diagram" : scope, conversation: conversation() }, signal));
    if (!current()) return; await acceptResult(next, prompt, current);
  });
  const explain = () => void run("AI 正在查阅整个架构的代码证据…", async (signal, current) => {
    if (!view || !wholeQuestion.trim() || !connected || !verified) return;
    const next = ArchitectureResultSchema.parse(await request({ operation: "ask", graph: view.graph, target: { kind: "node", id: view.graph.nodes[0]!.id }, scope: "diagram", intent: "explain", question: wholeQuestion, conversation: conversation() }, signal));
    if (current()) { await acceptResult(next, wholeQuestion, current); setWholeQuestion(""); }
  });
  const markdown = () => view ? architectureMarkdown(view.graph) + (history?.conversations?.length ? "\n## 架构问答记录\n\n" + history.conversations.map(item => "### " + item.question.replace(/\n/g, " ") + "\n\n" + "记录基于架构 v" + item.version + "（" + item.createdAt + "），不代表当前代码已经重新核验。\n\n" + item.answer + "\n\n" + item.limitations.join("\n") + "\n\n" + item.evidence.map(ref => "- " + ref.path + ":" + ref.startLine + "–" + ref.endLine).join("\n")).join("\n\n") : "") : "";
  const download = () => void run("正在导出架构…", async (signal, current) => {
    if (!view) return;
    const html = await exportArchitectureHtml(view.graph, markdown());
    if (current()) downloadText(html, "project-architecture.html", "text/html;charset=utf-8");
  });
  const selectChapter = (next: ArchitectureTarget) => { if (busy && busy !== "正在恢复项目分析…") return; setTarget(next); setResult(null); setQuestion(""); if (next.kind === "group") setScope("diagram"); setTimeout(() => { document.querySelector(".architecture-inspector")?.scrollTo({ top: 0 }); document.getElementById("diagram-question")?.focus({ preventScroll: true }); }, 0); };
  const selectFlowStep = (id: string) => { const step=flow?.steps.find(step=>step.id===id);if(!step)return;setFlowStepId(id);setFlowTransitionId(undefined);setFlowTrail([]);setTarget({kind:"node",id:step.nodeId});setResult(null);setScope("diagram"); };
  const followFlowTransition = (id: string) => { const edge=flow?.transitions.find(edge=>edge.id===id);const step=flow?.steps.find(step=>step.id===edge?.to);if(!edge||!step)return;setFlowTrail(previous=>[...previous,edge.from].slice(-80));setFlowStepId(step.id);setFlowTransitionId(edge.id);setTarget({kind:"node",id:step.nodeId});setResult(null);setScope("diagram"); };
  const previousFlowStep = () => { const id=flowTrail.at(-1);const step=flow?.steps.find(step=>step.id===id);if(!step)return;setFlowTrail(previous=>previous.slice(0,-1));setFlowStepId(id!);setFlowTransitionId(undefined);setTarget({kind:"node",id:step.nodeId}); };
  const selectDiagram = (next: ArchitectureTarget) => {if(diagramMode==="flow"&&next.kind==="node"){const step=flow?.steps.find(step=>step.nodeId===next.id);if(step){selectFlowStep(step.id);return;}}selectChapter(next);};
  return <section className={`architecture-workbench${dark ? " is-dark" : ""}`} aria-label="架构图工作台">
    <header className="architecture-toolbar"><div><span className="architecture-eyebrow">ARKI / PROJECT ARCHITECTURE</span><h1>项目架构</h1></div><div className="architecture-tools">
      <button disabled={!!busy || !connected || !history || history.cursor === 0} onClick={() => travel(history!.cursor - 1)}>撤销</button><button disabled={!!busy || !connected || !history || history.cursor >= history.graphs.length - 1} onClick={() => travel(history!.cursor + 1)}>重做</button>
      <button disabled={!!busy || !connected} onClick={regenerate}>重新生成</button><button disabled={!!busy || !view} onClick={() => downloadText(markdown(), "project-architecture.md", "text/markdown;charset=utf-8")}>导出 MD</button><button disabled={!!busy || !view} onClick={download}>导出 HTML</button>
    </div></header>
    {!connected ? <p className="architecture-error" role="status">正在查看本地保存的分析。后台恢复后会自动连接；文档、图形和问答记录仍可阅读与导出。</p> : view && !verified ? <p className="architecture-error" role="status">已恢复保存的分析，正在核验当前项目证据…</p> : null}
    {error ? diagnostic ? <ArchitectureFailurePanel key={diagnostic.requestId} failure={diagnostic} graphPreserved={!!view} /> : <p className="architecture-error" role="alert">{error}</p> : null}
    {view?.stale ? <p className="architecture-error" role="alert">项目代码已变化。当前是保存的架构版本，重新生成后可继续提问。</p> : null}
    {view && ((view.graph.flowIssues?.length??0) + (view.graph.flows??[]).reduce((sum,item)=>sum+(item.issues?.length??0),0)) > 0 ? <p className="arki-flow-issues" role="status">典型流程有待核对的部分；组件结构和可核验的流程内容已保留。切换到流程图查看具体说明。</p> : null}
    {view && isArchitectureDraft(view.graph) && !busy ? <div className="architecture-draft"><div><strong>这还是代码依赖草图</strong><span>模块职责和实际流程尚未解读。</span></div><button disabled={!connected} onClick={regenerate}>解读模块与流程</button></div> : null}
    {view && !isArchitectureDraft(view.graph) && view.graph.groups === undefined && !busy ? <div className="architecture-draft"><div><strong>这份存档尚未分析组件归属</strong><span>重新阅读代码，补充子系统结构与具体传输内容。</span></div><button disabled={!connected} onClick={regenerate}>补充组件与数据流</button></div> : null}
    <div className="architecture-layout"><div className="architecture-stage">
      <div className="architecture-canvas-toolbar"><span>{view ? `${view.graph.nodes.length} 个组件 · ${scenarios.length} 个流程场景` : "代码 → 架构"}</span><div><button aria-pressed={diagramMode === "structure"} onClick={() => setDiagramMode("structure")}>架构分析图</button><button aria-pressed={diagramMode === "flow"} onClick={() => setDiagramMode("flow")}>流程图</button><button onClick={() => documentDialog.current?.showModal()}>架构文档</button><button onClick={() => setDark(!dark)}>{dark ? "浅色" : "深色"}</button></div></div>
      {view ? <><p className="arki-view-caption">{diagramMode === "structure" ? "方框表示组件归属与系统边界。选中组件查看职责、接口与代码。" : "组件位置保持不变。切换典型场景，沿已确认的关系查看数据；编号用于定位，不表示所有分支串行执行。"}</p>{diagramMode === "flow" ? <><ArchitectureFlowPicker flows={scenarios} flow={flow} onChange={id=>{setFlowId(id);setFlowTrail([]);setFlowTransitionId(undefined);}} />{view.graph.flows === undefined && !busy ? <button disabled={!connected} onClick={regenerate}>分析典型流程</button> : null}{view.graph.flowIssues?.length ? <details className="arki-flow-issues"><summary>有流程待核对</summary>{view.graph.flowIssues.map((issue,index)=><p key={index}>{issue}</p>)}</details> : null}</> : null}<ArchitectureDiagram graph={view.graph} mode={diagramMode} target={target} dark={dark} onSelect={selectDiagram} flow={flow} stepId={flowStep?.id} transitionId={flowTransitionId} onTransition={followFlowTransition} /></> : <div className="architecture-loading"><span>⌘</span><p>{busy || "架构尚未生成"}</p>{!busy ? <button disabled={!connected} onClick={regenerate}>重试</button> : null}</div>}
      {view ? <ArchitectureRelations graph={view.graph} displayedEdgeIds={[]} onSelect={selectChapter} /> : null}
      <footer className="architecture-canvas-footer"><div className="architecture-legend"><span>{diagramMode === "structure" ? "组件归属 / 子系统边界" : "有实现证据的调用 / 数据流"}</span></div><span>v{view?.graph.version ?? 1} · {persistence === "saved" ? "保存在此浏览器" : persistence === "saving" ? "正在保存…" : "尚未保存，请导出"}</span></footer>
    </div><aside className="architecture-inspector" aria-label="架构选区">
      {readingFlow && view && flow && flowStep ? <><ArchitectureFlowReader graph={view.graph} flow={flow} stepId={flowStep.id} transitionId={flowTransitionId} back={flowTrail.length>0} onStep={selectFlowStep} onTransition={followFlowTransition} onBack={previousFlowStep} onSource={onSource} /><form onSubmit={event=>{event.preventDefault();ask();}}><label htmlFor="diagram-question">继续提问当前流程步骤</label><textarea id="diagram-question" maxLength={2400} value={question} disabled={!!busy} onChange={event=>setQuestion(event.target.value)} placeholder="例如：这一分支为什么返回这里？补充实际传递的数据。"/><p className="arki-flow-note">AI 将核验当前场景，并可完善整个架构中的相关流程。</p><button className="primary-button" disabled={!!busy || !connected || !verified || view.stale || !question.trim()}>解释并完善</button></form></> : selected ? <>{view?.graph.narrative ? <button onClick={() => { setTarget(null); setResult(null);  }}>← 阅读主线</button> : null}<span className="architecture-eyebrow">{target?.kind === "group" ? "SUBSYSTEM / 子系统" : target?.kind === "node" ? "COMPONENT / 组件" : "TRANSFER / 关系"}</span><h2>{selected.label}</h2>{"from" in selected ? <p className="architecture-endpoints">{view?.graph.nodes.find(node => node.id === selected.from)?.label} → {view?.graph.nodes.find(node => node.id === selected.to)?.label}</p> : <p className="architecture-summary">{selected.summary}</p>}
        {"codeName" in selected && selected.codeName ? <p className="architecture-document-code">{selected.codeName}</p> : null}<p className="architecture-detail">{selected.detail}</p>{"transfer" in selected && selected.transfer ? <dl className="arki-transfer-facts"><dt>传输数据</dt><dd>{selected.transfer.payload}</dd><dt>调用方式</dt><dd>{selected.transfer.mechanism}</dd><dt>接收方处理</dt><dd>{selected.transfer.processing}</dd><dt>返回 / 结果</dt><dd>{selected.transfer.result}</dd></dl> : null}<div className="architecture-sources"><span>代码来源</span>{selected.sources.map((source, index) => <button key={index} onClick={() => onSource(source.path, source.startLine)}>{source.path}:{source.startLine}</button>)}</div>
        <form onSubmit={event => { event.preventDefault(); ask(); }}><label htmlFor="diagram-scope">允许 AI 修改的范围</label><select id="diagram-scope" value={scope} disabled={!!busy} onChange={event => setScope(event.target.value as ArchitectureEditScope)}><option value="related">选中部分及直接关联区域</option><option value="diagram">整个架构图</option></select><label htmlFor="diagram-question">想弄清这个部分的什么？</label><textarea id="diagram-question" maxLength={3000} value={question} disabled={!!busy} onChange={event => setQuestion(event.target.value)} placeholder="例如：它接收什么，交给谁处理？请在图上补充。" /><button className="primary-button" disabled={!!busy || !connected || !verified || view?.stale || !question.trim()}>解释并完善</button></form>
      </> : <div className="architecture-inspector-empty">{view?.graph.narrative ? <ArchitectureReading graph={view.graph} onSelect={selectChapter} /> : <><span>↖</span><h2>从一个模块开始</h2></>}<p>点击图中的矩形或连线，查看职责、代码来源，再让 AI 把不清楚的部分补充完整。</p>{!view?.graph.narrative ? view?.graph.notes.map((note, index) => <p key={index} className="architecture-note">{note}</p>) : null}</div>}
      {busy ? <div className="architecture-progress" role="status">{busy}<button onClick={() => { consumedAnalyze.current = analyzeRequest; epoch.current++; pending.current?.abort(); pending.current = null; setBusy(""); }}>取消</button></div> : null}
      {result ? <div className="architecture-answer" aria-live="polite"><strong>{result.changedIds.length ? `已完善 ${result.changedIds.length} 处` : "AI 解释"}</strong><AnswerMarkdown>{result.answer}</AnswerMarkdown>{result.limitations.map((item, index) => <p className="architecture-note" key={index}>{item}</p>)}<details><summary>本次参考证据</summary>{result.evidence.map(item => <button key={item.id} onClick={() => onSource(item.path, item.startLine)}>{item.id} · {item.path}:{item.startLine}</button>)}</details></div> : null}
      {view ? <form className="architecture-global-question" onSubmit={event => { event.preventDefault(); explain(); }}><label htmlFor="architecture-whole-question">提问整个项目架构</label><textarea id="architecture-whole-question" value={wholeQuestion} maxLength={3000} disabled={!!busy} onChange={event => setWholeQuestion(event.target.value)} placeholder="例如：应该从哪个入口开始读？请求会经过哪些模块？" /><button className="primary-button" disabled={!!busy || !connected || !verified || view.stale || !wholeQuestion.trim()}>回答架构问题</button></form> : null}
      {history?.conversations?.length ? <details className="architecture-history"><summary>已保存的问答 · {history.conversations.length}</summary>{history.conversations.map((item, index) => <section key={index}><strong>{item.question}</strong><small>架构 v{item.version} · {new Date(item.createdAt).toLocaleString()}</small><AnswerMarkdown>{item.answer}</AnswerMarkdown>{item.limitations.map((note, i) => <p className="architecture-note" key={i}>{note}</p>)}{item.evidence.map(ref => <details key={ref.id}><summary>{ref.path}:{ref.startLine} · 当时的代码证据</summary><pre>{ref.excerpt}</pre><button disabled={!connected} onClick={() => onSource(ref.path, ref.startLine)}>查看当前代码</button></details>)}</section>)}</details> : null}
    </aside></div>
    <dialog ref={documentDialog} className="arki-document-dialog"><button onClick={()=>documentDialog.current?.close()}>关闭架构文档</button>{view ? <ArchitectureDocument graph={view.graph} onSelect={next=>{documentDialog.current?.close();selectChapter(next);}} onSource={(path,line)=>{documentDialog.current?.close();onSource(path,line);}} /> : null}</dialog>
  </section>;
}
