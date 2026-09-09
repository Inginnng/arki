import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { InlineSideReader } from "./InlineSideReader.js";
import { useProjectConnection } from "./project-connection.js";
import { loadGraphHistory } from "./architecture-store.js";
import { ArchitectureWorkbench } from "./ArchitectureWorkbench.js";
import { UpdatePanel } from "./UpdatePanel.js";
import { createHttpReaderHost } from "./http-host.js";
import type { ReaderDocument, ReaderDocumentSummary, ReaderHost, ReaderRoot, SourcePeek } from "./host.js";
import { loadCollection, saveCollection, type WorkbenchCollection, type WorkbenchEntry } from "./workbench-store.js";
import "./reading-workspace.css";
import "./workbench.css";

type Mode = keyof WorkbenchCollection;
type Opened = { entry: WorkbenchEntry; document: ReaderDocument | null; loading: boolean; error?: string };
const titles = { documents: "文档工作台", architecture: "架构工作台" };

export function Workbench({ host: suppliedHost }: { host?: ReaderHost }) {
  const host = useMemo(() => suppliedHost ?? createHttpReaderHost(), [suppliedHost]);
  const { root, catalog, status: connection, revision, reconnect } = useProjectConnection(host);
  const [analyzeRequest, setAnalyzeRequest] = useState(() => location.hash === "#analyze" ? 1 : 0);
  const [hasAnalysis, setHasAnalysis] = useState(false);
  const [collection, setCollection] = useState<WorkbenchCollection>({ documents: [], architecture: [] });
  const [mode, setMode] = useState<Mode>(() => { try { return ["#architecture", "#analyze"].includes(location.hash) || localStorage.getItem("arki-mode") === "architecture" ? "architecture" : "documents"; } catch { return "documents"; } });
  const [architectureOpened, setArchitectureOpened] = useState(mode === "architecture");
  const [opened, setOpened] = useState<Partial<Record<Mode, Opened | undefined>>>({});
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [picker, setPicker] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [peek, setPeek] = useState<SourcePeek | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef({ documents: 0, architecture: 0 });
  const activeEntry = useRef<Record<Mode, string | null>>({ documents: null, architecture: null });
  const mutation = useRef(false);
  const collectionRef = useRef(collection);
  const storageKey = useRef("");
  const projectKey = root?.storageKey ?? root?.rootId;
  useEffect(() => {
    window.history.replaceState(null, "", location.pathname + location.search + "#" + mode);
    try { localStorage.setItem("arki-mode", mode); } catch { /* Optional preference. */ }
  }, [mode]);
  useEffect(() => {
    if (!projectKey) return;
    let live = true; storageKey.current = projectKey; setReady(false);
    setOpened({}); activeEntry.current = { documents: null, architecture: null };
    void loadCollection(projectKey).then(saved => { if (live) { collectionRef.current = saved; setCollection(saved); setReady(true); } }).catch(() => { if (live) setError("浏览器存储不可用，本次文档整理无法保存。架构仍可在内存中分析与导出。"); });
    void loadGraphHistory(projectKey).then(saved => { if (live) setHasAnalysis(!!saved); }).catch(() => { if (live) setHasAnalysis(false); });
    return () => { live = false; generation.current.documents++; generation.current.architecture++; };
  }, [projectKey]);
  const startAnalysis = () => { setArchitectureOpened(true); setMode("architecture"); setAnalyzeRequest(value => value + 1); setHasAnalysis(true); };
  const continueAnalysis = () => { setArchitectureOpened(true); setMode("architecture"); };
  useEffect(() => { if (picker) dialog.current?.showModal(); else if (dialog.current?.open) dialog.current.close(); }, [picker]);

  const persist = async (next: WorkbenchCollection) => {
    await saveCollection(storageKey.current, next);
    collectionRef.current = next; setCollection(next);
  };
  const update = async (action: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true; setSaving(true); setError("");
    try { await action(); }
    catch { setError("未能保存更改，请检查浏览器存储空间后重试。"); }
    finally { mutation.current = false; setSaving(false); }
  };
  const open = async (entry: WorkbenchEntry, target = mode) => {
    activeEntry.current[target] = entry.id;
    const version = ++generation.current[target];
    setOpened(previous => ({ ...previous, [target]: { entry, document: null, loading: entry.markdown === undefined } }));
    if (entry.markdown !== undefined || !root) return;
    try {
      const { document } = await host.call<{ document: ReaderDocument }>("aimd_read_document", { rootId: root.rootId, path: entry.path });
      if (generation.current[target] === version) setOpened(previous => ({ ...previous, [target]: { entry, document, loading: false } }));
    } catch {
      if (generation.current[target] === version) setOpened(previous => ({ ...previous, [target]: { entry, document: null, loading: false, error: "文档无法读取，可能已被移动或删除。" } }));
    }
  };
  const addProject = () => {
    const target = mode;
    void update(async () => {
      const current = collectionRef.current;
      const additions = catalog.filter(item => picked.includes(item.path) && !current[target].some(entry => entry.id === `project:${item.path}`))
        .map(item => ({ id: `project:${item.path}`, path: item.path, title: item.title }));
      await persist({ ...current, [target]: [...current[target], ...additions] });
      setPicker(false); setPicked([]);
      if (additions[0]) void open(additions[0], target);
    });
  };
  const importFiles = (files: File[]) => {
    const target = mode;
    void update(async () => {
      const additions: WorkbenchEntry[] = [];
      const rejected: string[] = [];
      for (const file of files) {
        if (!/\.(md|markdown)$/iu.test(file.name) || file.size > 2 * 1024 * 1024) { rejected.push(file.name); continue; }
        let markdown: string;
        try { markdown = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
        catch { rejected.push(file.name); continue; }
        if (markdown.includes("\0")) { rejected.push(file.name); continue; }
        additions.push({ id: `local:${crypto.randomUUID()}`, path: file.name, title: markdown.match(/^#\s+(.+)$/mu)?.[1]?.trim() || file.name, markdown });
      }
      if (additions.length) {
        const current = collectionRef.current;
        await persist({ ...current, [target]: [...current[target], ...additions] });
        void open(additions[0]!, target);
      }
      if (rejected.length) setError(`未导入：${rejected.join("、")}。请选择 UTF-8 编码、2 MB 以内的 Markdown 文件。`);
    });
  };
  const remove = (entry: WorkbenchEntry) => {
    const target = mode;
    void update(async () => {
      const current = collectionRef.current;
      await persist({ ...current, [target]: current[target].filter(item => item.id !== entry.id) });
      if (activeEntry.current[target] === entry.id) {
        activeEntry.current[target] = null;
        generation.current[target]++;
        setOpened(previous => previous[target]?.entry.id === entry.id ? { ...previous, [target]: undefined } : previous);
      }
    });
  };
  const openSource = async (path: string, line: number) => {
    if (!root) return;
    if (connection !== "online") { setError("查看当前代码需要本地后台。请启动 Arki，页面会自动重连。"); return; }
    try { setPeek(await host.openSource(root.rootId, path, line)); }
    catch { setError("来源无法读取，请重新打开文档后重试。"); }
  };
  const showPicker = () => { setPicked([]); setCatalogQuery(""); setPicker(true); };
  const entries = collection[mode].filter(entry => `${entry.title} ${entry.path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  return <div className="reading-workspace workbench">
    <header className="workbench-topbar"><a className="workbench-brand" href="#documents" onClick={() => setMode("documents")}><b>A</b><strong>Arki<span>一览 · 看清架构，读懂代码</span></strong></a>
      <nav aria-label="工作台"><button type="button" aria-current={mode === "documents" ? "page" : undefined} onClick={() => { setMode("documents"); setQuery(""); }}>文档工作台</button><button type="button" aria-current={mode === "architecture" ? "page" : undefined} onClick={() => { setMode("architecture"); setArchitectureOpened(true); setQuery(""); }}>架构工作台</button></nav>
      <span className="workbench-project">{root?.workspaceLabel ?? "当前项目"}</span><button className={`arki-connection ${connection}`} onClick={reconnect} aria-label="重新连接项目">{connection === "online" ? "● 已连接" : connection === "connecting" ? "连接中…" : "○ 重新连接"}</button><UpdatePanel/>
    </header>
    {connection === "offline" ? <div className="arki-offline" role="status"><strong>本地后台暂未连接</strong><span>已有分析可以继续阅读。双击项目中的 Arki.cmd，或运行 pnpm start；后台启动后会自动恢复连接。</span><button onClick={reconnect}>立即重连</button></div> : null}
    {error ? <div className="workbench-notice" role="alert">{error}<button type="button" aria-label="关闭提示" onClick={() => setError("")}>×</button></div> : null}
    <div className={`workbench-body${mode === "architecture" ? " architecture-active" : ""}`}>
      {architectureOpened && root ? <div hidden={mode !== "architecture"}><ArchitectureWorkbench key={root.storageKey ?? root.rootId} storageKey={root.storageKey ?? root.rootId} connected={connection === "online"} connectionRevision={revision} analyzeRequest={analyzeRequest} onSource={(path, line) => void openSource(path, line)} /></div> : null}
      <aside className="workbench-library" aria-label={titles[mode]}>
        <div className="library-heading"><h1>{mode === "documents" ? "我的文档" : "分析资料"}</h1><span>{collection[mode].length}</span></div>
        <div className="library-actions"><button type="button" className="primary-button" disabled={!root || !ready || saving} onClick={showPicker}>＋ 从项目添加</button><button type="button" className="quiet-button" disabled={!root || !ready || saving} onClick={() => fileInput.current?.click()}>导入 MD</button></div>
        <input ref={fileInput} type="file" aria-label="导入 Markdown 文件" accept=".md,.markdown" multiple hidden onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) importFiles(files); }} />
        <input className="library-search" type="search" aria-label="搜索工作台文档" placeholder="搜索文档…" value={query} onChange={event => setQuery(event.target.value)} />
        <nav className="library-list" aria-label="工作台文档">
          {entries.map(entry => <div key={entry.id} className={`library-item${opened[mode]?.entry.id === entry.id ? " active" : ""}`}><button type="button" onClick={() => void open(entry)}><span className="file-mark" aria-hidden="true">MD</span><span><strong>{entry.title}</strong><small>{entry.markdown !== undefined ? "本地 · " : ""}{entry.path}</small></span></button><button type="button" className="remove-document" aria-label={`从工作台移除 ${entry.title}`} title="从工作台移除" disabled={saving} onClick={() => remove(entry)}>×</button></div>)}
          {ready && !entries.length ? <p className="library-empty">{query ? "没有匹配的文档" : "添加你需要的文档"}</p> : null}
        </nav>
        <p className="library-footer">保存在此浏览器 · 移除不影响源文件</p>
      </aside>
      <main className="workbench-content">
        {(["documents"] as const).map(target => {
          const item = opened[target];
          return <section key={target} hidden={mode !== target} aria-label={titles[target]}>
            {!item ? <div className="workbench-empty"><span className="empty-symbol" aria-hidden="true">{target === "documents" ? "▤" : "⌘"}</span><h2>{target === "documents" ? "从项目全貌，读到代码证据" : "梳理程序的结构与关系"}</h2><p>{target === "documents" ? "一键分析当前项目，生成架构文档与示意图。沿着模块和关系提问，逐步读懂实现。" : "添加项目说明，选择任务，分析模块职责与调用关系。"}</p><div className="arki-start-actions"><button type="button" className="primary-button" disabled={!root || connection !== "online"} onClick={startAnalysis}>一键分析当前项目</button>{hasAnalysis ? <button type="button" className="quiet-button" onClick={continueAnalysis}>继续上次分析</button> : null}</div><div className="arki-secondary-actions"><button type="button" className="quiet-button" disabled={!root || !ready || saving} onClick={showPicker}>从项目添加</button><button type="button" className="quiet-button" disabled={!root || !ready || saving} onClick={() => fileInput.current?.click()}>导入 MD</button></div></div> : <>
              <header className="document-topline"><div><span>{titles[target]}</span><p>{item.entry.path}</p></div><button type="button" className="quiet-button" onClick={() => { generation.current[target]++; setOpened(previous => previous[target]?.entry.id === item.entry.id ? { ...previous, [target]: undefined } : previous); }}>关闭文档</button></header>
              {item.error ? <div role="alert" className="workbench-document-error">{item.error}<button type="button" className="quiet-button" onClick={() => void open(item.entry, target)}>重试</button></div> : item.loading ? <p role="status">正在读取文档…</p> : item.entry.markdown !== undefined ? <><p className="local-document-note">本地阅读 · 项目问答请从项目添加文档</p><article className="markdown-paper"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.entry.markdown}</ReactMarkdown></article></> : <InlineSideReader document={item.document} onSource={(path, line) => void openSource(path, line)} />}
            </>}
          </section>;
        })}
      </main>
    </div>
    <dialog ref={dialog} className="document-picker" aria-label="添加项目文档" onCancel={() => setPicker(false)} onClose={() => setPicker(false)}>
      <header><div><h2>添加项目文档</h2><p>{titles[mode]}</p></div><button type="button" className="quiet-button" onClick={() => setPicker(false)}>关闭</button></header>
      <input type="search" aria-label="搜索项目文档" placeholder="搜索标题或路径…" value={catalogQuery} onChange={event => setCatalogQuery(event.target.value)} />
      <div className="project-document-list">{catalog.filter(item => `${item.title} ${item.path}`.toLowerCase().includes(catalogQuery.toLowerCase())).map(item => {
        const added = collection[mode].some(entry => entry.id === `project:${item.path}`);
        return <label key={item.path}><input type="checkbox" disabled={added || saving} checked={added || picked.includes(item.path)} onChange={event => setPicked(previous => event.target.checked ? [...previous, item.path] : previous.filter(path => path !== item.path))} /><span><strong>{item.title}</strong><small>{item.path}</small></span>{added ? <small>已添加</small> : null}</label>;
      })}{!catalog.some(item => `${item.title} ${item.path}`.toLowerCase().includes(catalogQuery.toLowerCase())) ? <p>没有匹配的文档</p> : null}</div>
      <footer><span>已选 {picked.length} 篇</span><button type="button" className="primary-button" disabled={!picked.length || saving} onClick={addProject}>{saving ? "保存中…" : "添加到工作台"}</button></footer>
    </dialog>
    {peek ? <div className="source-drawer" role="dialog" aria-label="证据来源"><button type="button" aria-label="关闭证据来源" onClick={() => setPeek(null)}>×</button><strong>{peek.path}:{peek.startLine}</strong><pre>{peek.lines.map(line => `${line.line}  ${line.text}`).join("\n")}</pre></div> : null}
  </div>;
}
