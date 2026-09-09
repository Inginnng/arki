import type { Disposition, EvidenceAnswer, EvidenceReference, QuestionRunEvent, QuestionRunPage, ReaderSession } from "@aimd/contracts";
import { useEffect, useMemo, useReducer, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  createCodexReaderHost,
  ReaderHostError,
  type PatchPreview,
  type ReaderDocument,
  type ReaderDocumentSummary,
  type ReaderHost,
  type ReaderRoot,
} from "./host.js";
import { mapDomRangeToSource, SelectionMappingError } from "./selection.js";
import { InlineSideReader } from "./InlineSideReader.js";
import "./reading-workspace.css";
import { initialReaderState, readerReducer, type UiAnnotation } from "./state.js";

type AppProps = {
  sideQuestions?: boolean;
  host?: ReaderHost;
  persistenceStatus?: "persistent" | "memory_only";
  backendStatus?: {
    kind: "real" | "mock";
    label: string;
    detail?: string;
  };
};

const statusLabels: Record<string, string> = {
  queued: "排队中",
  inspecting: "正在检查项目",
  streaming_unverified: "正在生成草稿——尚未核验",
  validating: "正在核验证据",
  completed: "已完成",
  stale: "快照已过期",
  unsupported: "证据不足",
  failed: "已安全终止",
  cancelled: "已取消",
};

const reviewLabels: Record<EvidenceAnswer["reviewStatus"], string> = {
  citation_validated: "引用已核验",
  evidence_reviewed: "AI 证据已审核",
  stale: "快照已过期",
  unsupported: "证据不足",
  conflict: "证据冲突",
};

const dispositionLabels: Record<Disposition, string> = {
  reading_only: "仅阅读",
  inline: "行内解释",
  replace: "替换所选内容",
  glossary: "术语表条目",
  faq: "常见问题条目",
  ignore: "忽略",
};

const evidenceKindLabels: Record<EvidenceReference["kind"], string> = {
  code_excerpt: "代码摘录",
  test_excerpt: "测试摘录",
  project_document: "项目文档",
  task_decision: "任务决策",
  inference: "推断",
};

const claimCategoryLabels: Record<EvidenceAnswer["claims"][number]["category"], string> = {
  code_fact: "代码事实",
  architecture: "架构",
  cross_module_flow: "跨模块流程",
  configuration: "配置",
  document_literal: "文档原文",
  task_decision: "任务决策",
  inference: "推断",
};

const systemMessageLabels: Record<string, string> = {
  "Inspecting bounded project evidence.": "正在检查限定范围内的项目证据。",
  "Generating a structured answer.": "正在生成结构化回答。",
  "Validating citations and independent semantic support.": "正在核验引用与独立语义支持。",
  "Expanded the bounded evidence packet.": "已扩展限定范围内的证据包。",
  "The side question failed safely.": "辅助提问已安全终止。",
  "The evidence expansion limit was reached.": "已达到证据扩展上限。",
  "The question run failed safely.": "本次提问已安全终止。",
  "The previous server stopped before this question completed.": "上一次服务在问题完成前停止。",
  "Question cancelled.": "问题已取消。",
  "Reader service closed.": "阅读服务已关闭。",
  "Workspace evidence changed during the run.": "运行过程中项目证据已变化。",
  "Workspace evidence changed during independent review.": "独立审核期间项目证据已变化。",
  "through the current completed turn": "截至当前已完成的对话",
  "Through the latest completed parent turn": "截至父任务最近一次已完成的对话",
  "The exact Codex task could not be verified.": "无法验证当前 Codex 任务。",
  "Task context unavailable; project evidence only": "任务上下文不可用；仅使用项目证据。",
  "Task workspace does not own this document": "当前任务工作区不包含此文档。",
  "Task context unavailable": "任务上下文不可用。",
  "Model execution unavailable; project documents remain readable": "模型执行不可用；项目文档仍可阅读。",
};

const questionOutcomeLabels: Record<string, string> = {
  GENERATION_CHANGED: "问题运行已切换到新一代，请重新提交。",
  CURSOR_EXPIRED: "问题进度游标已过期，请重新提交。",
  CURSOR_GAP: "问题进度不连续，请重新提交。",
};

function positioned(node: unknown) {
  const position = (node as { position?: unknown } | undefined)?.position as { start?: { offset?: number }; end?: { offset?: number } } | undefined;
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  return typeof start === "number" && typeof end === "number"
    ? { "data-source-start": start, "data-source-end": end }
    : {};
}

function headingPosition(node: unknown) {
  const props = positioned(node);
  const line = ((node as { position?: { start?: { line?: number } } } | undefined)?.position?.start?.line);
  return typeof line === "number" ? { ...props, id: `heading-${line}` } : props;
}

const markdownComponents: Components = {
  h1: ({ node, ...props }) => <h1 {...headingPosition(node)} {...props} />,
  h2: ({ node, ...props }) => <h2 {...headingPosition(node)} {...props} />,
  h3: ({ node, ...props }) => <h3 {...headingPosition(node)} {...props} />,
  h4: ({ node, ...props }) => <h4 {...headingPosition(node)} {...props} />,
  p: ({ node, ...props }) => <p {...positioned(node)} {...props} />,
  li: ({ node, ...props }) => <li {...positioned(node)} {...props} />,
  blockquote: ({ node, ...props }) => <blockquote {...positioned(node)} {...props} />,
  td: ({ node, ...props }) => <td {...positioned(node)} {...props} />,
  th: ({ node, ...props }) => <th {...positioned(node)} {...props} />,
  pre: ({ node, ...props }) => <pre {...positioned(node)} {...props} />,
  code: ({ node, ...props }) => <code {...positioned(node)} {...props} />,
};

function errorMessage(error: unknown): string {
  if (error instanceof ReaderHostError) return `阅读操作已安全停止（${error.code}）。`;
  if (error instanceof SelectionMappingError) return "该选区无法明确对应到 Markdown 源文。请缩小选区后重试。";
  return "阅读器无法安全完成此操作。";
}

function localizeSystemMessage(message: string | undefined): string | undefined {
  return message ? systemMessageLabels[message] ?? message : undefined;
}

function ContextBanner({ session, persistenceStatus }: { session: ReaderSession; persistenceStatus: AppProps["persistenceStatus"] }) {
  const verified = session.contextMode === "task_and_project" && session.bindingStatus === "verified";
  return (
    <section className={`context-banner ${verified ? "is-verified" : "is-degraded"}`} aria-label="上下文状态">
      <span className="context-mark" aria-hidden="true">{verified ? "✓" : "!"}</span>
      <div>
        <strong>{verified ? "任务 + 项目上下文" : session.contextMode === "project_only" ? "仅使用项目证据——任务上下文不可用" : "仅使用文档上下文"}</strong>
        {verified ? <p>{localizeSystemMessage(session.cutoffLabel) ?? "已关联当前任务"}</p> : null}
        {persistenceStatus === "memory_only" ? <p className="persistence-warning">会话注释仅保存在内存中，服务重启后将丢失。</p> : null}
      </div>
    </section>
  );
}

function EvidenceButton({ evidence, onOpen }: { evidence: EvidenceReference; onOpen: (evidence: EvidenceReference) => void }) {
  if (evidence.kind === "inference") {
    return <li className="evidence-item"><span className="evidence-kind">{evidenceKindLabels[evidence.kind]}</span><p>{evidence.rationale}</p></li>;
  }
  if (evidence.kind === "task_decision") {
    return <li className="evidence-item"><span className="evidence-kind">{evidenceKindLabels[evidence.kind]}</span><p>{evidence.excerpt}</p></li>;
  }
  return (
    <li className="evidence-item">
      <span className="evidence-kind">{evidenceKindLabels[evidence.kind]}</span>
      <button type="button" className="source-link" onClick={() => onOpen(evidence)} aria-label={`${evidence.path}:${evidence.startLine} 打开证据来源`}>
        {evidence.path}:{evidence.startLine}–{evidence.endLine}
      </button>
      <p>{evidence.excerpt}</p>
    </li>
  );
}

function AnswerView({ answer, rootId, host, onSource, onError }: {
  answer: EvidenceAnswer;
  rootId: string;
  host: ReaderHost;
  onSource: (source: Awaited<ReturnType<ReaderHost["openSource"]>>) => void;
  onError: (error: unknown) => void;
}) {
  const conclusion = answer.claims.find((claim) => claim.id === answer.conclusionClaimId) ?? answer.claims[0];
  const remaining = answer.claims.filter((claim) => claim.id !== conclusion?.id);
  const open = async (evidence: EvidenceReference) => {
    if (!("path" in evidence)) return;
    try {
      onSource(await host.openSource(rootId, evidence.path, evidence.startLine));
    } catch (error) {
      onError(error);
    }
  };
  return (
    <div className="answer">
      <div className={`review-badge review-${answer.reviewStatus}`}>{reviewLabels[answer.reviewStatus]}</div>
      {conclusion ? <p className="conclusion">{conclusion.statement}</p> : null}
      {remaining.length ? <ul className="claims">{remaining.map((claim) => <li key={claim.id}><span>{claimCategoryLabels[claim.category]}</span>{claim.statement}</li>)}</ul> : null}
      {answer.unknowns.length ? <div className="unknowns"><strong>已知限制</strong>{answer.unknowns.map((item) => <p key={item.id}>{item.statement}</p>)}</div> : null}
      <details className="evidence" open>
        <summary>证据 · {answer.evidence.length}</summary>
        <ul>{answer.evidence.map((item) => <EvidenceButton key={item.id} evidence={item} onOpen={(evidence) => void open(evidence)} />)}</ul>
      </details>
    </div>
  );
}

function canSynthesize(annotation: UiAnnotation): boolean {
  return !annotation.orphaned && annotation.questions.some((question) => question.status === "completed" && question.answer?.reviewStatus === "evidence_reviewed");
}

export function App({ host: suppliedHost, persistenceStatus = "persistent", backendStatus, sideQuestions = false }: AppProps) {
  const host = useMemo(() => suppliedHost ?? createCodexReaderHost(), [suppliedHost]);
  const [state, dispatch] = useReducer(readerReducer, initialReaderState);
  const [roots, setRoots] = useState<ReaderRoot[]>([]);
  const [documents, setDocuments] = useState<ReaderDocumentSummary[]>([]);
  const [session, setSession] = useState<ReaderSession | null>(null);
  const [draft, setDraft] = useState("");
  const [composerError, setComposerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mobileComposerOpen, setMobileComposerOpen] = useState(false);
  const [busy, setBusy] = useState(true);
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => typeof window !== "undefined" && window.innerWidth < 821);
  const [writtenPath, setWrittenPath] = useState<string | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const questionStartInFlight = useRef<symbol | null>(null);
  const documentGeneration = useRef(0);

  const openDocument = async (rootId: string, path: string) => {
    const requestGeneration = ++documentGeneration.current;
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    questionStartInFlight.current = null;
    setSubmitting(false);
    setBusy(true);
    setSession(null);
    setDraft("");
    setWrittenPath(null);
    setComposerError(null);
    setMobileComposerOpen(false);
    try {
      const [{ document }, { session: nextSession }] = await Promise.all([
        host.call<{ document: ReaderDocument }>("aimd_read_document", { rootId, path }),
        host.call<{ session: ReaderSession }>("aimd_create_session", { rootId, path }),
      ]);
      if (requestGeneration !== documentGeneration.current) return;
      dispatch({ type: "document_loaded", document });
      setSession(nextSession);
    } catch (error) {
      if (requestGeneration === documentGeneration.current) dispatch({ type: "notice", notice: errorMessage(error) });
    } finally {
      if (requestGeneration === documentGeneration.current) setBusy(false);
    }
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await host.connect();
        void host.requestFullscreen();
        const { roots: availableRoots } = await host.call<{ roots: ReaderRoot[] }>("aimd_list_roots", {});
        if (!live) return;
        setRoots(availableRoots);
        const firstRoot = availableRoots[0];
        if (!firstRoot) {
          dispatch({ type: "notice", notice: "没有可用的已授权项目根目录。" });
          setBusy(false);
          return;
        }
        dispatch({ type: "root_selected", rootId: firstRoot.rootId });
        const { documents: availableDocuments } = await host.call<{ documents: ReaderDocumentSummary[] }>("aimd_list_documents", { rootId: firstRoot.rootId });
        if (!live) return;
        setDocuments(availableDocuments);
        const firstDocument = availableDocuments[0];
        if (!firstDocument) {
          dispatch({ type: "notice", notice: "项目中未找到 Markdown 文档。" });
          setBusy(false);
          return;
        }
        await openDocument(firstRoot.rootId, firstDocument.path);
      } catch (error) {
        if (live) {
          dispatch({ type: "notice", notice: errorMessage(error) });
          setBusy(false);
        }
      }
    })();
    return () => {
      live = false;
      controllers.current.forEach((controller) => controller.abort());
    };
  }, [host]);

  useEffect(() => {
    if (!state.selection) return;
    const desktopLayout = typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 821px)").matches;
    if (desktopLayout) questionInput.current?.focus();
  }, [state.selection]);

  const captureSelection = (event: ReactMouseEvent<HTMLElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed || !state.document) return;
    const range = selection.getRangeAt(0);
    if (!event.currentTarget.contains(range.commonAncestorContainer)) return;
    try {
      dispatch({ type: "selection_captured", selection: mapDomRangeToSource(range, state.document.markdown) });
      setComposerError(null);
      setMobileComposerOpen(false);
    } catch (error) {
      dispatch({ type: "notice", notice: errorMessage(error) });
    }
  };

  const applyPage = (page: QuestionRunPage) => {
    if (page.outcome !== "events") {
      dispatch({ type: "notice", notice: questionOutcomeLabels[page.outcome] ?? "问题轮询已安全停止，请重新提交。" });
      return;
    }
    for (const event of page.events) applyEvent(event);
  };

  const applyEvent = (event: QuestionRunEvent) => {
    if (event.type === "status" || event.type === "progress") {
      if (event.payload.status !== "draft") dispatch({ type: "question_progress", runId: event.runId, status: event.payload.status, ...(event.type === "progress" ? { message: event.payload.message } : {}) });
      return;
    }
    if (event.type === "completed") {
      const review = event.payload.answer.reviewStatus;
      dispatch({ type: "question_finished", runId: event.runId, status: review === "unsupported" ? "unsupported" : "completed", answer: event.payload.answer });
    } else if (event.type === "stale") {
      dispatch({ type: "question_finished", runId: event.runId, status: "stale", ...(event.payload.answer ? { answer: event.payload.answer } : {}), message: event.payload.reason });
    } else if (event.type === "failed") {
      dispatch({ type: "question_finished", runId: event.runId, status: "failed", message: event.payload.message });
    } else {
      dispatch({ type: "question_finished", runId: event.runId, status: "cancelled", ...(event.payload.reason ? { message: event.payload.reason } : {}) });
    }
  };

  const ask = async () => {
    const question = draft.trim();
    const selection = state.selection;
    const documentPath = state.document?.path;
    if (!selection || !documentPath) return;
    if (!question) {
      setComposerError("请输入问题后再提问。");
      questionInput.current?.focus();
      return;
    }
    if (!session) {
      setComposerError("项目会话尚未就绪，请稍后重试。");
      questionInput.current?.focus();
      return;
    }
    if (questionStartInFlight.current) return;

    const submissionToken = Symbol("question-start");
    questionStartInFlight.current = submissionToken;
    setSubmitting(true);
    setComposerError(null);
    const sourceDocumentGeneration = documentGeneration.current;
    let job: { runId: string };
    try {
      const result = await host.call<{ job: { runId: string } }>("aimd_ask_start", {
        sessionId: session.id,
        question: { question, startOffset: selection.startOffset, endOffset: selection.endOffset },
      });
      job = result.job;
    } catch (error) {
      dispatch({ type: "notice", notice: errorMessage(error) });
      return;
    } finally {
      if (questionStartInFlight.current === submissionToken) {
        questionStartInFlight.current = null;
        setSubmitting(false);
      }
    }

    if (sourceDocumentGeneration !== documentGeneration.current) {
      dispatch({ type: "notice", notice: "文档已切换；刚才的提问已取消，不会附加到新文档。" });
      void host.call("aimd_cancel_question", { runId: job.runId }).catch(() => undefined);
      return;
    }

    dispatch({ type: "question_started", runId: job.runId, question, selection, documentPath });
    setDraft("");
    const controller = new AbortController();
    controllers.current.set(job.runId, controller);
    try {
      await host.watchQuestion(job.runId, applyPage, controller.signal);
      if (controller.signal.aborted) {
        dispatch({ type: "question_finished", runId: job.runId, status: "cancelled" });
      }
    } catch (error) {
      dispatch({ type: "notice", notice: errorMessage(error) });
    } finally {
      controllers.current.delete(job.runId);
    }
  };

  const revealMobileComposer = () => {
    setMobileComposerOpen(true);
    questionInput.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    questionInput.current?.focus({ preventScroll: true });
  };

  const changeDisposition = async (annotation: UiAnnotation, disposition: Disposition) => {
    const accepted = annotation.questions.filter((question) => question.status === "completed" && question.answer?.reviewStatus === "evidence_reviewed");
    try {
      await Promise.all(accepted.map((question) => host.call("aimd_set_disposition", { annotationId: question.runId, disposition })));
      dispatch({ type: "disposition_changed", annotationId: annotation.id, disposition });
    } catch (error) {
      dispatch({ type: "notice", notice: errorMessage(error) });
    }
  };

  const selectedAnnotationIds = state.annotations.flatMap((annotation) =>
    canSynthesize(annotation) && !["reading_only", "ignore"].includes(annotation.disposition)
      ? annotation.questions.filter((question) => question.status === "completed" && question.answer?.reviewStatus === "evidence_reviewed").map((question) => question.runId)
      : [],
  );

  const preparePatch = async () => {
    if (!session || selectedAnnotationIds.length === 0) return;
    try {
      const { preview } = await host.call<{ preview: PatchPreview }>("aimd_prepare_patch", { sessionId: session.id, annotationIds: selectedAnnotationIds });
      dispatch({ type: "patch_prepared", patch: preview });
    } catch (error) {
      dispatch({ type: "notice", notice: errorMessage(error) });
    }
  };

  const approvePatch = async () => {
    if (!session || !state.patch || state.patch.status !== "ready") return;
    try {
      const { approval } = await host.call<{ approval: { approvalToken: string } }>("aimd_approve_patch", { sessionId: session.id, sourceHash: state.patch.sourceHash, diffHash: state.patch.diffHash });
      dispatch({ type: "patch_approved", approvalToken: approval.approvalToken });
    } catch (error) {
      dispatch({ type: "notice", notice: errorMessage(error) });
    }
  };

  const writePatch = async () => {
    if (!session || !state.patch || !state.approvalToken) return;
    try {
      const { result } = await host.call<{ result: { path: string } }>("aimd_write_explained", { sessionId: session.id, previewId: state.patch.id, approvalToken: state.approvalToken });
      setWrittenPath(result.path);
    } catch (error) {
      dispatch({ type: "notice", notice: errorMessage(error) });
    }
  };

  return (
    <div className={`app-frame${backendStatus ? " has-backend-status" : ""}${sideQuestions ? " reading-workspace" : ""}${navigationCollapsed ? " navigation-collapsed" : ""}`}>
      {backendStatus ? (
        <aside className={`backend-status is-${backendStatus.kind}`} role="status" aria-label="后端状态">
          <span className="backend-status-dot" aria-hidden="true" />
          <strong>{backendStatus.label}</strong>
          {backendStatus.detail ? <span>{backendStatus.detail}</span> : null}
        </aside>
      ) : null}
      <div className="reader-shell">
      <aside className="document-rail" hidden={sideQuestions && navigationCollapsed}>
        <div className="brand"><span>Arki</span><strong>一览 · 文档研读</strong></div>
        <p className="workspace-label">{roots.find((root) => root.rootId === state.rootId)?.workspaceLabel ?? "项目"}</p>
        <nav aria-label="项目文档">
          {documents.map((document) => <button key={document.path} type="button" className={state.document?.path === document.path ? "active" : ""} onClick={() => state.rootId && void openDocument(state.rootId, document.path)}><span>{document.title}</span><small>{document.path}</small></button>)}
        </nav>
        {state.document?.headings.length ? <div className="outline"><span className="eyebrow">本页目录</span>{state.document.headings.map((heading) => <a key={`${heading.line}-${heading.text}`} href={`#heading-${heading.line}`} style={{ paddingLeft: `${Math.max(0, heading.depth - 1) * 10}px` }}>{heading.text}</a>)}</div> : null}
      </aside>

      <main className="reading-stage">
        <header className="reader-header"><div className="reader-location">{sideQuestions ? <button type="button" className="navigation-toggle" aria-label={navigationCollapsed ? "展开文档列表" : "收起文档列表"} aria-expanded={!navigationCollapsed} onClick={() => setNavigationCollapsed(value => !value)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg></button> : null}<div><span className="eyebrow">项目文档</span><p>{state.document?.path ?? "正在打开…"}</p></div></div><button type="button" className="quiet-button" disabled={!state.document} onClick={() => state.document && navigator.clipboard?.writeText(state.document.path)}>复制路径</button></header>
        {session && !sideQuestions ? <ContextBanner session={session} persistenceStatus={persistenceStatus} /> : null}
        {state.notice ? <div className="notice" role="status">{state.notice}</div> : null}
        {sideQuestions ? <InlineSideReader document={busy ? null : state.document} onSource={(path, line) => { if (state.rootId) void host.openSource(state.rootId, path, line).then(source => dispatch({ type: "source_opened", source }), error => dispatch({ type: "notice", notice: errorMessage(error) })); }} /> : busy ? <div className="loading" aria-label="正在加载文档">正在读取项目…</div> : state.document ? (
          <article className="markdown-paper" onMouseUp={captureSelection}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{state.document.markdown}</ReactMarkdown>
          </article>
        ) : null}
      </main>

      {!sideQuestions ? <aside className="evidence-rail" aria-label="提问与证据">
        <div className="rail-heading"><h2>向文档提问</h2></div>
        {state.selection ? (
          <section className="question-composer" aria-label="提问区">
            <span className="composer-kicker">已选原文</span>
            <blockquote>{state.selection.renderedText}</blockquote>
            <label htmlFor="selection-question">针对所选内容提问</label>
            <textarea
              ref={questionInput}
              id="selection-question"
              value={draft}
              readOnly={submitting}
              aria-busy={submitting || undefined}
              aria-invalid={composerError ? "true" : undefined}
              aria-describedby={composerError ? "selection-question-error" : "selection-question-help"}
              onChange={(event) => {
                setDraft(event.target.value);
                if (composerError) setComposerError(null);
              }}
              onFocus={() => setMobileComposerOpen(true)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void ask();
              }}
              placeholder="例如：这段设计解决了什么问题？"
            />
            <p className="composer-help" id="selection-question-help">⌘/Ctrl + 回车提交</p>
            {composerError ? <p className="composer-error" id="selection-question-error" role="alert">{composerError}</p> : null}
            <div className="composer-actions"><button type="button" className="primary-button" aria-busy={submitting || undefined} onClick={() => void ask()}>{submitting ? "正在提交问题" : "提交问题"}</button></div>
          </section>
        ) : (
          <div className="selection-hint">
            <div><strong>选中一段原文，开始提问</strong></div>
          </div>
        )}

        <div className="annotation-list">
          {[...state.annotations].reverse().map((annotation) => <section className="annotation" key={annotation.id}>
            <div className="anchor-quote">“{annotation.selection.renderedText}”</div>
            {annotation.questions.map((question) => <div className="question-thread" key={question.runId}>
              <h3>{question.question}</h3>
              {question.answer ? <AnswerView answer={question.answer} rootId={state.rootId!} host={host} onSource={(source) => dispatch({ type: "source_opened", source })} onError={(error) => dispatch({ type: "notice", notice: errorMessage(error) })} /> : <div className="run-status" role="status" aria-live="polite"><span className="pulse" />{statusLabels[question.status] ?? question.status}{localizeSystemMessage(question.message) ? ` · ${localizeSystemMessage(question.message)}` : ""}{controllers.current.has(question.runId) ? <button type="button" aria-label="取消提问" onClick={() => controllers.current.get(question.runId)?.abort()}>取消</button> : null}</div>}
            </div>)}
            {canSynthesize(annotation) ? <label className="disposition">写入位置<select aria-label="写入位置" value={annotation.disposition} onChange={(event) => void changeDisposition(annotation, event.target.value as Disposition)}>{Object.entries(dispositionLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label> : null}
          </section>)}
        </div>

        {selectedAnnotationIds.length ? <section className="synthesis-actions"><span className="eyebrow">已审核内容 · {selectedAnnotationIds.length}</span><button className="primary-button" type="button" onClick={() => void preparePatch()}>生成解释版文档预览</button></section> : null}
      </aside> : null}

      {!sideQuestions && state.selection && !mobileComposerOpen ? <button type="button" className="mobile-question-cta" onClick={revealMobileComposer}><span>已选中原文</span><strong>向所选内容提问</strong></button> : null}

      {state.sourcePeek ? <div className="source-drawer" role="dialog" aria-label="证据来源"><button type="button" aria-label="关闭证据来源" onClick={() => dispatch({ type: "source_closed" })}>×</button><span className="eyebrow">{state.sourcePeek.path}:{state.sourcePeek.startLine}</span><pre>{state.sourcePeek.lines.map((line) => `${String(line.line).padStart(4, " ")}  ${line.text}`).join("\n")}</pre></div> : null}

      {state.patch ? <div className="patch-review" role="dialog" aria-label="解释版文档审核">
        <div className="patch-header"><div><span className="eyebrow">精确差异审核</span><h2>{state.patch.targetPath}</h2></div><button type="button" className="quiet-button" onClick={() => dispatch({ type: "patch_cleared" })}>关闭</button></div>
        {state.patch.conflicts.length ? <div className="conflicts">{state.patch.conflicts.map((conflict) => <p key={conflict.annotationId}>{conflict.reason}</p>)}</div> : null}
        <div className="patch-content">
          <div className="patch-columns">
            <section><h3>原文</h3><pre>{state.document?.markdown ?? ""}</pre></section>
            <section><h3>生成结果</h3><pre>{state.patch.markdown}</pre></section>
          </div>
          <section className="patch-diff"><h3>统一差异</h3><pre>{state.patch.unifiedDiff}</pre></section>
        </div>
        <footer>{writtenPath ? <strong className="write-success">已创建 {writtenPath}</strong> : state.approvalToken ? <button type="button" className="primary-button" onClick={() => void writePatch()}>写入 .explained.md 文件</button> : <button type="button" className="primary-button" disabled={state.patch.status !== "ready"} onClick={() => void approvePatch()}>批准此精确差异</button>}<p>不会覆盖源文档。</p></footer>
      </div> : null}
      </div>
    </div>
  );
}
