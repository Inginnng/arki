import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { SideTaskChoiceSchema, SideTaskSelectionSchema, SideQuestionResultSchema, type SideTaskChoice, type SideTaskSelection, type SideQuestionResult } from "@aimd/contracts";
type Props = {
  document: { path: string; hash: string } | null;
  selection: { startOffset: number; endOffset: number; renderedText: string } | null;
  onSource: (path: string, line: number) => void;
  fetcher?: typeof fetch;
};
const messages: Record<string, string> = {
  SIDE_TASK_EXPIRED: "任务选择已过期，请刷新列表并重新选择。",
  SIDE_TASK_INVALID: "任务已不可用或不属于当前项目，请重新选择。",
  SIDE_TASK_EMPTY: "该任务没有可用的已完成讨论。",
  SIDE_BUSY: "另一个问题正在运行，请稍后重试。",
  SIDE_CANCELLED: "问题已取消。",
  SIDE_TIMEOUT: "Codex 响应超时，请检查连接后重试。",
  CODEX_VERSION_UNSUPPORTED: "当前 Codex 版本不支持所选模型，请使用兼容的新运行时启动服务。",
  SIDE_SOURCE_CHANGED: "文档或证据在运行期间已变化，请重新打开文档再提问。",
  SIDE_SELECTION_INVALID: "选区无效或过长，请缩小选区。",
  SIDE_OUTPUT_INVALID: "模型回答未通过格式或引用校验，未展示为有效答案。",
  SIDE_TOOL_BLOCKED: "检测到不允许的工具行为，本次问答已停止。",
};
const failure = (error: unknown) => messages[error instanceof Error ? error.message : ""] ?? "本机 Codex 操作失败，请检查服务、登录和网络连接后重试。";
export function SideQuestionPanel({ document, selection, onSource, fetcher = globalThis.fetch }: Props) {
  const [tasks, setTasks] = useState<SideTaskChoice[]>([]);
  const [choice, setChoice] = useState("");
  const [selected, setSelected] = useState<SideTaskSelection | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState<"select" | "ask" | null>(null);
  const [loading, setLoading] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ question: string; quote: string; value: SideQuestionResult } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const listController = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const request = async (operation: string, args: unknown, signal: AbortSignal) => {
    const response = await fetcher("/api/side", { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, arguments: args }), signal });
    if (!response.ok) throw new Error("SIDE_RUNTIME_UNAVAILABLE");
    const body = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.object({ code: z.string() }).optional() }).parse(await response.json());
    if (!body.ok) throw new Error(body.error?.code ?? "SIDE_RUNTIME_UNAVAILABLE");
    return body.data;
  };
  const stop = () => { epoch.current++; controller.current?.abort(); controller.current = null; setBusy(null); };
  const refresh = async () => {
    stop(); setSelected(null); setChoice(""); setResult(null); setError(""); setLoading(true);
    listController.current?.abort();
    const abort = new AbortController(); listController.current = abort;
    try {
      const data = z.object({ tasks: z.array(SideTaskChoiceSchema) }).parse(await request("list", {}, abort.signal));
      if (!abort.signal.aborted) setTasks(data.tasks);
    } catch (error) { if (!abort.signal.aborted) { setTasks([]); setError(failure(error)); } }
    finally { if (!abort.signal.aborted) setLoading(false); }
  };
  useEffect(() => { void refresh(); return () => { controller.current?.abort(); listController.current?.abort(); epoch.current++; }; }, [fetcher]);
  useEffect(() => { stop(); setResult(null); setQuestion(""); setError(""); }, [document?.path, document?.hash]);
  useEffect(() => { setComposerFocused(false); if (selection && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 821px)").matches) inputRef.current?.focus(); }, [selection]);
  const select = async (handle: string) => {
    stop(); setChoice(handle); setSelected(null); setResult(null); setError("");
    if (!handle) return;
    const current = epoch.current; const abort = new AbortController(); controller.current = abort; setBusy("select");
    try {
      const data = z.object({ selection: SideTaskSelectionSchema }).parse(await request("select", { handle }, abort.signal));
      if (current === epoch.current && !abort.signal.aborted) setSelected(data.selection);
    } catch (error) { if (current === epoch.current && !abort.signal.aborted) setError(failure(error)); }
    finally { if (current === epoch.current) { setBusy(null); controller.current = null; } }
  };
  const ask = async () => {
    if (controller.current || !selected || !document || !selection) return;
    if (!question.trim()) { setError("请输入问题。"); inputRef.current?.focus(); return; }
    const current = epoch.current; const abort = new AbortController(); controller.current = abort;
    const questionText = question.trim(); const quote = selection.renderedText;
    setBusy("ask"); setError(""); setResult(null);
    try {
      const data = z.object({ result: SideQuestionResultSchema }).parse(await request("ask", {
        selectionHandle: selected.handle, documentPath: document.path, documentHash: document.hash,
        startOffset: selection.startOffset, endOffset: selection.endOffset, question: questionText,
      }, abort.signal));
      if (current === epoch.current && !abort.signal.aborted) setResult({ question: questionText, quote, value: data.result });
    } catch (error) { if (current === epoch.current && !abort.signal.aborted) setError(failure(error)); }
    finally { if (current === epoch.current) { setBusy(null); controller.current = null; } }
  };
  return <div className="side-question-panel">
    <div className="rail-heading"><span className="eyebrow">本机 Codex · 侧边问答</span><h2>带着讨论读文档</h2><p>明确选择任务，利用相关片段回答；不会把侧聊写回主任务。</p></div>
    <section className="side-task-picker" aria-label="任务上下文选择">
      <label htmlFor="side-task">选择 Codex 任务</label>
      <div className="side-task-row"><select id="side-task" value={choice} disabled={loading} onChange={event => void select(event.target.value)}>
        <option value="">{loading ? "正在读取任务…" : "请选择当前项目中的任务"}</option>
        {tasks.map(task => <option key={task.handle} value={task.handle}>{task.title || "未命名任务"}</option>)}
      </select><button type="button" className="quiet-button" disabled={loading} onClick={() => void refresh()}>刷新</button></div>
      {selected ? <div className="side-cutoff"><strong>所选任务：{selected.title}</strong><p>{selected.cutoffLabel}</p><p>使用固定讨论片段，不代表桌面当前任务绑定，也不保证包含全部历史。</p>{selected.historyTruncated ? <p>历史已按预算截取，可能遗漏信息。</p> : null}</div> : <p className="composer-help">{busy === "select" ? "正在核验任务与项目…" : "选择后才能提问；不会依据标题或最近访问记录自动猜测任务。"}</p>}
      {!loading && !tasks.length ? <p>未找到当前项目可用的任务。可刷新重试；文档仍可阅读。</p> : null}
    </section>
    {selection ? <section className="question-composer" aria-label="提问区">
      <span className="composer-kicker">已选原文</span><blockquote>{selection.renderedText}</blockquote>
      <label htmlFor="side-question">针对所选内容提问</label>
      <textarea id="side-question" ref={inputRef} value={question} maxLength={4096} readOnly={busy === "ask"} onFocus={() => setComposerFocused(true)}
        onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void ask(); }}
        placeholder="例如：MCP 是什么？在这个项目里如何使用？" />
      <div className="composer-actions"><button className="primary-button" type="button" disabled={!selected || !document || busy !== null} onClick={() => void ask()}>{busy === "ask" ? "Codex 正在回答…" : "提交问题"}</button>
        {busy === "ask" ? <button type="button" className="quiet-button" onClick={() => { stop(); setError("问题已取消。"); }}>取消提问</button> : <span>Ctrl / ⌘ + 回车</span>}</div>
      {busy === "ask" ? <p role="status">正在读取当前证据并调用本机 Codex，尚未得到有效答案。</p> : null}
    </section> : <div className="selection-hint"><span>01</span><div><strong>选择任务</strong><p>保留你已讨论过的背景。</p></div><span>02</span><div><strong>选中原文再提问</strong><p>在文档中拖选词句，问题会发送给真实 Codex。</p></div></div>}
    {error ? <p className="composer-error" role="alert">{error}</p> : null}
    {result ? <section className="annotation side-answer">
      <div className="anchor-quote">“{result.quote}”</div><h3>{result.question}</h3>
      <div className="review-badge">引用位置已核验 · 未进行独立语义审核，不可直接写入</div>
      {result.value.answer.concept ? <section><h4>概念说明</h4><p>{result.value.answer.concept}</p></section> : null}
      {result.value.answer.projectClaims.length ? <section><h4>当前项目证据</h4>{result.value.answer.projectClaims.map((claim, index) => <p key={index}>{claim.statement}<small> [{claim.evidenceIds.join("、")}]</small></p>)}</section> : null}
      {result.value.answer.taskDiscussion ? <section><h4>所选任务中的讨论</h4><p>{result.value.answer.taskDiscussion}</p></section> : null}
      {result.value.answer.unknowns.length ? <section><h4>未知与限制</h4>{result.value.answer.unknowns.map((text, index) => <p key={index}>{text}</p>)}</section> : null}
      {result.value.retrievalTruncated ? <p className="composer-help">证据检索有范围限制，未覆盖整个项目。</p> : null}
      <details className="evidence" open><summary>当次项目来源 · {result.value.evidence.length}</summary><ul>{result.value.evidence.map(item => <li className="evidence-item" key={item.id}><small>{item.id}</small><button className="source-link" type="button" onClick={() => onSource(item.path, item.startLine)}>{item.path}:{item.startLine}–{item.endLine}</button><pre>{item.excerpt}</pre></li>)}</ul></details>
    </section> : null}
    <p className="composer-help">侧聊结果仅保留在当前页面。未证明严格工具隔离；审核、保存解释版尚未接入这条流程。</p>
    {selection && !composerFocused ? <button className="mobile-question-cta" type="button" onClick={() => { inputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }); inputRef.current?.focus({ preventScroll: true }); }}><span>已选中原文</span><strong>去侧边提问</strong></button> : null}
  </div>;
}
