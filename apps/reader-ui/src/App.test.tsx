import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EvidenceAnswer, QuestionRunPage, ReaderSession } from "@aimd/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import type { PatchPreview, ReaderHost } from "./host.js";

afterEach(cleanup);

vi.mock("./SideQuestionPanel.js", () => ({ SideQuestionPanel: ({ document }: { document: unknown }) => <div data-testid="side-document">{document ? "available" : "unavailable"}</div> }));
vi.mock("./InlineSideReader.js", () => ({ InlineSideReader: ({ document }: { document: unknown }) => <div data-testid="side-document">{document ? "available" : "unavailable"}</div> }));

it("uses a reading-first web layout with collapsible navigation and no permanent answer rail", async () => {
  render(<App host={createHost()} sideQuestions />);
  await waitFor(() => expect(screen.getByTestId("side-document").textContent).toBe("available"));
  expect(screen.queryByRole("complementary", { name: "提问与证据" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "收起文档列表" }));
  expect(screen.queryByRole("navigation", { name: "项目文档" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "展开文档列表" }));
  expect(screen.getByRole("navigation", { name: "项目文档" })).toBeTruthy();
});

it("invalidates side document immediately when a document reload is pending or fails", async () => {
  const host = createHost();
  render(<App host={host} sideQuestions />);
  await waitFor(() => expect(screen.getByTestId("side-document").textContent).toBe("available"));
  const original = host.call;
  let rejectRead!: (reason: Error) => void;
  host.call = vi.fn((tool, args) => tool === "aimd_read_document" ? new Promise((_resolve, reject) => { rejectRead = reject; }) : original(tool, args)) as ReaderHost["call"];
  fireEvent.click(screen.getByRole("button", { name: /Architecture/ }));
  await waitFor(() => expect(screen.getByTestId("side-document").textContent).toBe("unavailable"));
  rejectRead(new Error("read failed"));
  await screen.findByText("阅读器无法安全完成此操作。");
});

const digest = "a".repeat(64);
const documentFixture = {
  path: "docs/architecture.md",
  hash: digest,
  markdown: "# Architecture\n\nThe gateway routes requests to the worker.",
  headings: [{ depth: 1, text: "Architecture", line: 1 }],
  anchorStatus: { status: "current" },
};

const taskSession: ReaderSession = {
  id: "session-1",
  bindingStatus: "verified",
  contextMode: "task_and_project",
  rootId: "root-1",
  workspaceLabel: "AIMD",
  documentPath: documentFixture.path,
  cutoffLabel: "through the current completed turn",
};

const answer = {
  conclusionClaimId: "claim-1",
  runId: "run-1",
  generation: "generation-1",
  candidateDigest: digest,
  claims: [{
    id: "claim-1",
    statement: "The gateway is the request-routing boundary before worker execution.",
    category: "architecture",
    evidenceIds: ["evidence-1", "evidence-2"],
  }],
  reviewStatus: "evidence_reviewed",
  contextMode: "task_and_project",
  documentPath: documentFixture.path,
  evidence: [
    {
      id: "evidence-1",
      kind: "code_excerpt",
      path: "src/gateway.ts",
      startLine: 8,
      endLine: 14,
      excerpt: "export function route(request) { return worker.run(request); }",
      excerptHash: digest,
      fileHash: digest,
      snapshotDigest: digest,
      provenance: { issuer: "workspace_service", packetId: "packet-1", runId: "run-1", generation: "generation-1" },
    },
    {
      id: "evidence-2",
      kind: "test_excerpt",
      path: "src/gateway.test.ts",
      startLine: 20,
      endLine: 26,
      excerpt: "expect(worker.run).toHaveBeenCalled();",
      excerptHash: digest,
      fileHash: digest,
      snapshotDigest: digest,
      provenance: { issuer: "workspace_service", packetId: "packet-1", runId: "run-1", generation: "generation-1" },
    },
  ],
  unknowns: [],
  snapshotDigest: digest,
  supportReview: {
    id: "review-1",
    reviewer: "independent_model",
    modelAssisted: true,
    runId: "run-1",
    generation: "generation-1",
    candidateDigest: digest,
    snapshotDigest: digest,
    records: [{ id: "record-1", claimId: "claim-1", evidenceIds: ["evidence-1", "evidence-2"], verdict: "directly_supported", rationale: "Both implementation and test evidence support the claim." }],
  },
} satisfies EvidenceAnswer;

const terminalPage = {
  outcome: "events",
  runId: "run-1",
  generation: "generation-1",
  cursor: null,
  nextCursor: { runId: "run-1", generation: "generation-1", sequence: 1 },
  events: [{
    runId: "run-1",
    generation: "generation-1",
    sequence: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    type: "completed",
    payload: { status: "completed", answer },
  }],
} satisfies QuestionRunPage;

const preview: PatchPreview = {
  id: "preview-1",
  sessionId: "session-1",
  status: "ready",
  sourcePath: documentFixture.path,
  targetPath: "docs/architecture.explained.md",
  sourceHash: digest,
  resultHash: "b".repeat(64),
  diffHash: "c".repeat(64),
  markdown: "# Architecture\n\nExpanded explanation.",
  unifiedDiff: "@@ -1,2 +1,4 @@\n # Architecture\n+\n+Expanded explanation.",
  annotationIds: ["run-1"],
  conflicts: [],
};

function createHost(session: ReaderSession = taskSession): ReaderHost {
  const host: ReaderHost = {
    connect: vi.fn(async () => undefined),
    requestFullscreen: vi.fn(async () => undefined),
    openSource: vi.fn(async (_rootId, path, line = 1) => ({
      path,
      startLine: line,
      endLine: line + 1,
      totalLines: 30,
      lines: [{ line, text: "export function route() {}" }],
      excerpt: `${line}: export function route() {}`,
      fileHash: digest,
      truncated: false,
    })),
    watchQuestion: vi.fn(async (_runId, onPage) => onPage(terminalPage)),
    call: vi.fn(async (tool: Parameters<ReaderHost["call"]>[0]) => {
      if (tool === "aimd_list_roots") return { roots: [{ rootId: "root-1", workspaceLabel: "AIMD" }] };
      if (tool === "aimd_list_documents") return { documents: [{ path: documentFixture.path, title: "Architecture", hash: digest }] };
      if (tool === "aimd_read_document") return { document: documentFixture };
      if (tool === "aimd_create_session") return { session };
      if (tool === "aimd_ask_start") return { job: { runId: "run-1" } };
      if (tool === "aimd_set_disposition") return { status: "updated" };
      if (tool === "aimd_prepare_patch") return { preview };
      if (tool === "aimd_approve_patch") return { approval: { approvalToken: "x".repeat(43) } };
      if (tool === "aimd_write_explained") return { result: { path: preview.targetPath } };
      throw new Error(`Unexpected tool: ${tool}`);
    }) as ReaderHost["call"],
  };
  return host;
}

async function boot(host = createHost()) {
  render(<App host={host} />);
  await screen.findByRole("heading", { name: "Architecture", level: 1 });
  return host;
}

function selectTextFrom(element: HTMLElement, textFragment: string) {
  const node = element.firstChild!;
  const text = node.textContent!;
  const start = text.indexOf(textFragment);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + textFragment.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(element);
}

function selectText(textFragment: string) {
  selectTextFrom(screen.getByText(/The gateway routes/), textFragment);
}

function selectGateway() {
  selectText("gateway");
}

describe("AIMD Reader application", () => {
  it("shows an explicit real-backend banner when the entry point supplies one", async () => {
    render(<App host={createHost()} backendStatus={{ kind: "real", label: "真实后端 · 本机 Codex CLI" }} />);
    await screen.findByRole("heading", { name: "Architecture", level: 1 });

    const banner = screen.getByRole("status", { name: "后端状态" });
    expect(banner.textContent).toContain("真实后端 · 本机 Codex CLI");
    expect(banner.className).toContain("is-real");
  });

  it("keeps the question action operable and explains an empty draft", async () => {
    const host = await boot();
    selectGateway();

    const input = await screen.findByLabelText("针对所选内容提问");
    const submit = screen.getByRole("button", { name: "提交问题" });
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(submit);

    expect((await screen.findByRole("alert")).textContent).toBe("请输入问题后再提问。");
    expect(document.activeElement).toBe(input);
    expect(host.call).not.toHaveBeenCalledWith("aimd_ask_start", expect.anything());
  });

  it("starts only one question and keeps the submitted selection while startup is pending", async () => {
    const host = createHost();
    const originalCall = host.call;
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    host.call = vi.fn(async (tool, input) => {
      if (tool === "aimd_ask_start") {
        await startGate;
        return { job: { runId: "run-1" } };
      }
      return await originalCall(tool, input);
    }) as ReaderHost["call"];

    await boot(host);
    selectGateway();
    fireEvent.change(await screen.findByLabelText("针对所选内容提问"), { target: { value: "这个选区有什么作用？" } });
    const submit = screen.getByRole("button", { name: "提交问题" });
    submit.focus();
    fireEvent.click(submit);
    fireEvent.click(submit);

    const submittingButton = screen.getByRole("button", { name: "正在提交问题" }) as HTMLButtonElement;
    expect(submittingButton.disabled).toBe(false);
    expect(document.activeElement).toBe(submittingButton);
    selectText("worker");
    const startCalls = vi.mocked(host.call).mock.calls.filter(([tool]) => tool === "aimd_ask_start");
    releaseStart();

    expect(startCalls).toHaveLength(1);
    await screen.findByText(/request-routing boundary/);
    expect(document.querySelector(".anchor-quote")?.textContent).toContain("gateway");
  });

  it("releases a pending question-start lock when the user switches documents", async () => {
    const host = createHost();
    const originalCall = host.call;
    const secondDocument = {
      path: "docs/second.md",
      hash: "d".repeat(64),
      markdown: "# Second\n\nA different document.",
      headings: [{ depth: 1, text: "Second", line: 1 }],
      anchorStatus: { status: "current" as const },
    };
    let releaseFirstStart!: () => void;
    const firstStartGate = new Promise<void>((resolve) => { releaseFirstStart = resolve; });
    let startCount = 0;
    host.watchQuestion = vi.fn(async () => undefined);
    host.call = vi.fn(async (tool, input) => {
      const path = (input as { path?: string }).path;
      if (tool === "aimd_list_documents") return { documents: [
        { path: documentFixture.path, title: "Architecture", hash: documentFixture.hash },
        { path: secondDocument.path, title: "Second", hash: secondDocument.hash },
      ] };
      if (tool === "aimd_read_document" && path === secondDocument.path) return { document: secondDocument };
      if (tool === "aimd_create_session" && path === secondDocument.path) return { session: { ...taskSession, id: "session-2", documentPath: secondDocument.path } };
      if (tool === "aimd_ask_start") {
        const currentStart = ++startCount;
        if (currentStart === 1) await firstStartGate;
        return { job: { runId: currentStart === 1 ? "run-stale-start" : "run-new-document" } };
      }
      if (tool === "aimd_cancel_question") return { status: "cancelled" };
      return await originalCall(tool, input);
    }) as ReaderHost["call"];

    await boot(host);
    selectGateway();
    fireEvent.change(await screen.findByLabelText("针对所选内容提问"), { target: { value: "旧文档问题" } });
    fireEvent.click(screen.getByRole("button", { name: "提交问题" }));
    fireEvent.click(screen.getByRole("button", { name: /Second docs\/second\.md/ }));
    await screen.findByRole("heading", { name: "Second", level: 1 });

    selectTextFrom(screen.getByText(/different document/), "different");
    fireEvent.change(await screen.findByLabelText("针对所选内容提问"), { target: { value: "新文档问题" } });
    fireEvent.click(screen.getByRole("button", { name: "提交问题" }));

    await waitFor(() => expect(startCount).toBe(2));
    releaseFirstStart();
    await waitFor(() => expect(host.call).toHaveBeenCalledWith("aimd_cancel_question", { runId: "run-stale-start" }));
  });

  it("cancels a question start that returns after the user switches documents", async () => {
    const host = createHost();
    const originalCall = host.call;
    const secondDocument = {
      path: "docs/second.md",
      hash: "d".repeat(64),
      markdown: "# Second\n\nA different document.",
      headings: [{ depth: 1, text: "Second", line: 1 }],
      anchorStatus: { status: "current" as const },
    };
    let releaseStart!: () => void;
    let releaseCancel!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
    host.call = vi.fn(async (tool, input) => {
      const path = (input as { path?: string }).path;
      if (tool === "aimd_list_documents") return { documents: [
        { path: documentFixture.path, title: "Architecture", hash: documentFixture.hash },
        { path: secondDocument.path, title: "Second", hash: secondDocument.hash },
      ] };
      if (tool === "aimd_read_document" && path === secondDocument.path) return { document: secondDocument };
      if (tool === "aimd_create_session" && path === secondDocument.path) return { session: { ...taskSession, id: "session-2", documentPath: secondDocument.path } };
      if (tool === "aimd_ask_start") {
        await startGate;
        return { job: { runId: "run-stale-start" } };
      }
      if (tool === "aimd_cancel_question") {
        await cancelGate;
        return { status: "cancelled" };
      }
      return await originalCall(tool, input);
    }) as ReaderHost["call"];

    await boot(host);
    selectGateway();
    fireEvent.change(await screen.findByLabelText("针对所选内容提问"), { target: { value: "这个选区有什么作用？" } });
    fireEvent.click(screen.getByRole("button", { name: "提交问题" }));
    fireEvent.click(screen.getByRole("button", { name: /Second docs\/second\.md/ }));
    await screen.findByRole("heading", { name: "Second", level: 1 });
    releaseStart();

    await waitFor(() => expect(host.call).toHaveBeenCalledWith("aimd_cancel_question", { runId: "run-stale-start" }));
    expect((await screen.findByRole("status")).textContent).toContain("文档已切换");
    selectTextFrom(screen.getByText(/different document/), "different");
    const newQuestion = await screen.findByLabelText("针对所选内容提问");
    fireEvent.change(newQuestion, { target: { value: "这是新文档的问题" } });
    releaseCancel();

    expect(document.querySelector(".anchor-quote")).toBeNull();
    await waitFor(() => expect((newQuestion as HTMLTextAreaElement).value).toBe("这是新文档的问题"));
  });

  it("opens the first authorized document and declares verified task context", async () => {
    const host = await boot();
    expect(screen.getByText("任务 + 项目上下文")).toBeTruthy();
    expect(screen.getByText("截至当前已完成的对话")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "项目文档" })).toBeTruthy();
    expect(host.connect).toHaveBeenCalledOnce();
  });

  it("uses Simplified Chinese for the default reader controls", async () => {
    await boot();

    expect(screen.getByText("本页目录")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "向文档提问" })).toBeTruthy();
    expect(screen.getByText("选中一段原文，开始提问")).toBeTruthy();
    expect(screen.queryByText("Ask the document")).toBeNull();
  });

  it("turns a source-positioned selection into a grounded evidence answer", async () => {
    const host = await boot();
    selectGateway();
    const input = await screen.findByLabelText("针对所选内容提问");
    fireEvent.change(input, { target: { value: "这个 gateway 在架构里负责什么？" } });
    fireEvent.click(screen.getByRole("button", { name: "提交问题" }));

    expect(await screen.findByText(/request-routing boundary/)).toBeTruthy();
    expect(screen.getByText("AI 证据已审核")).toBeTruthy();
    expect(screen.queryByText(/proven/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /src\/gateway\.ts:8/ }));
    await waitFor(() => expect(host.openSource).toHaveBeenCalledWith("root-1", "src/gateway.ts", 8));
    const sourceDialog = await screen.findByRole("dialog", { name: "证据来源" });
    expect(within(sourceDialog).getByText(/export function route/)).toBeTruthy();
  });

  it("reports source-peek failures without an unhandled async rejection", async () => {
    const host = createHost();
    host.openSource = vi.fn(async () => {
      throw new Error("source unavailable");
    });
    await boot(host);
    selectGateway();
    fireEvent.change(await screen.findByLabelText("针对所选内容提问"), { target: { value: "Where is this implemented?" } });
    fireEvent.click(screen.getByRole("button", { name: "提交问题" }));

    fireEvent.click(await screen.findByRole("button", { name: /src\/gateway\.ts:8/ }));
    expect((await screen.findByRole("status")).textContent).toContain("阅读器无法安全完成此操作");
  });

  it("keeps project-only degradation visible", async () => {
    const host = createHost({ ...taskSession, bindingStatus: "unavailable", contextMode: "project_only", cutoffLabel: undefined, degradationReason: "The exact Codex task could not be verified." });
    await boot(host);
    expect(screen.getByText("仅使用项目证据——任务上下文不可用")).toBeTruthy();
    expect(screen.getByRole("region", { name: "上下文状态" }).textContent).toContain("任务上下文不可用");
  });

  it("supports keyboard submission and visibly cancels an active run", async () => {
    const host = createHost();
    let observedSignal: AbortSignal | undefined;
    host.watchQuestion = vi.fn(async (_runId, _onPage, signal) => {
      observedSignal = signal;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    await boot(host);
    selectGateway();
    const input = await screen.findByLabelText("针对所选内容提问");
    fireEvent.change(input, { target: { value: "Keep this question as the visible run" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    expect(await screen.findByText("Keep this question as the visible run")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "取消提问" }));
    expect(observedSignal?.aborted).toBe(true);
    expect(screen.getByText("Keep this question as the visible run")).toBeTruthy();
    expect(await screen.findByText("已取消")).toBeTruthy();
  });

  it("requires explicit disposition, preview approval, and a separate write", async () => {
    const host = await boot();
    selectGateway();
    fireEvent.change(await screen.findByLabelText("针对所选内容提问"), { target: { value: "Explain this boundary" } });
    fireEvent.click(screen.getByRole("button", { name: "提交问题" }));
    await screen.findByText(/request-routing boundary/);

    fireEvent.change(screen.getByLabelText("写入位置"), { target: { value: "inline" } });
    await waitFor(() => expect(host.call).toHaveBeenCalledWith("aimd_set_disposition", { annotationId: "run-1", disposition: "inline" }));
    fireEvent.click(screen.getByRole("button", { name: "生成解释版文档预览" }));
    const review = await screen.findByRole("dialog", { name: "解释版文档审核" });
    expect(review.textContent).toContain("Expanded explanation");
    expect(within(review).getByRole("heading", { name: "原文" })).toBeTruthy();
    expect(within(review).getByRole("heading", { name: "生成结果" })).toBeTruthy();
    expect(within(review).getByRole("heading", { name: "统一差异" })).toBeTruthy();
    expect(host.call).not.toHaveBeenCalledWith("aimd_write_explained", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "批准此精确差异" }));
    await screen.findByRole("button", { name: "写入 .explained.md 文件" });
    expect(host.call).not.toHaveBeenCalledWith("aimd_write_explained", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "写入 .explained.md 文件" }));
    expect(await screen.findByText(/已创建 docs\/architecture\.explained\.md/)).toBeTruthy();
  });

  it("warns when annotation persistence is memory-only", async () => {
    render(<App host={createHost()} persistenceStatus="memory_only" />);
    await screen.findByRole("heading", { name: "Architecture", level: 1 });
    expect(screen.getByText(/仅保存在内存中/)).toBeTruthy();
    expect(screen.getByText(/服务重启后将丢失/)).toBeTruthy();
  });
});
