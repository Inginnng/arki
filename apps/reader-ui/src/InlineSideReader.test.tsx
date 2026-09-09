import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InlineSideReader } from "./InlineSideReader.js";

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals(); });
const documentData = { path: "README.md", hash: "a".repeat(64), markdown: "MCP connects tools.\n\nEvidence stays current." };
const result = { answer: { concept: "MCP 是模型上下文协议。", projectClaims: [{ statement: "使用 stdio", evidenceIds: ["evidence-1"] }], taskDiscussion: "先适配 Codex", unknowns: ["尚无完整历史"] }, evidence: [{ id: "evidence-1", path: "server.ts", startLine: 1, endLine: 1, excerpt: "stdio", fileHash: "a".repeat(64) }], reviewStatus: "citation_validated", retrievalTruncated: false };
const response = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) }) as Response;
function service(ask?: (options: RequestInit) => Promise<Response>) {
  return vi.fn(async (_url: unknown, options: RequestInit) => {
    const call = JSON.parse(options.body as string);
    if (call.operation === "list") return response({ tasks: [{ handle: "choice-1", title: "任务甲", updatedAt: 100 }] });
    if (call.operation === "select") return response({ selection: { handle: "selected-1", title: "任务甲", cutoffLabel: "截至已完成讨论", historyTruncated: false } });
    return ask ? ask(options) : response({ result });
  }) as unknown as typeof fetch;
}
function selectText(text = "MCP connects tools.", start = 0, end = 3) {
  const element = screen.getByText(text);
  const range = window.document.createRange();
  range.setStart(element.firstChild!, start); range.setEnd(element.firstChild!, end);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  fireEvent.mouseUp(element);
}
async function chooseTask() {
  await screen.findByRole("option", { name: "任务甲" });
  fireEvent.change(screen.getByLabelText("选择 Codex 任务"), { target: { value: "choice-1" } });
  await screen.findByText("截至已完成讨论");
}
function compose(question = "MCP 是什么？") {
  fireEvent.change(screen.getByLabelText("针对所选内容提问"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "提交问题" }));
}

it.each(["outside", "escape", "selection cleared"])("discards an unsubmitted popup on %s without leaving a capsule", async reason => {
  const fetcher = service();
  render(<InlineSideReader document={documentData} onSource={vi.fn()} fetcher={fetcher} />);
  await chooseTask(); selectText();
  const input = screen.getByLabelText("针对所选内容提问");
  if (reason === "outside") fireEvent.pointerDown(screen.getByText("Evidence stays current."));
  else if (reason === "escape") fireEvent.keyDown(input, { key: "Escape" });
  else { fireEvent.blur(input); input.blur(); window.getSelection()!.removeAllRanges(); fireEvent(document, new Event("selectionchange")); }
  expect(screen.queryByLabelText("针对所选内容提问")).toBeNull();
  expect(document.querySelector(".inline-capsule")).toBeNull();
  expect(vi.mocked(fetcher).mock.calls).toHaveLength(2);
});

it("replaces an unsubmitted selection instead of leaving draft markers", async () => {
  render(<InlineSideReader document={documentData} onSource={vi.fn()} fetcher={service()} />);
  await chooseTask(); selectText();
  fireEvent.change(screen.getByLabelText("针对所选内容提问"), { target: { value: "旧草稿" } });
  selectText("Evidence stays current.", 0, 8);
  expect(screen.getByLabelText("针对所选内容提问")).toHaveProperty("value", "");
  expect(document.querySelector(".inline-composer")?.textContent).toContain("Evidence");
  expect(document.querySelectorAll(".inline-capsule")).toHaveLength(0);
});

it("highlights the source without rewriting its DOM and clears highlights on document changes", async () => {
  const highlights = new Map<string, { ranges: Range[] }>();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("Highlight", class { constructor(...publicRanges: Range[]) { this.ranges = publicRanges; } ranges: Range[]; });
  const props = { document: documentData, onSource: vi.fn(), fetcher: service() };
  const view = render(<InlineSideReader {...props} />);
  await chooseTask();
  const sourceNode = screen.getByText("MCP connects tools.").firstChild;
  selectText();
  expect(highlights.get("aimd-inline-selection")?.ranges[0]?.toString()).toBe("MCP");
  expect(screen.getByText("MCP connects tools.").firstChild).toBe(sourceNode);
  view.rerender(<InlineSideReader {...props} document={null} />);
  expect(highlights.size).toBe(0);
});

it("opens and focuses a mobile composer directly without scrolling the document", async () => {
  const previous = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  const scroll = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
  vi.stubGlobal("innerWidth", 600);
  try {
    render(<InlineSideReader document={documentData} onSource={vi.fn()} fetcher={service()} />);
    await chooseTask(); selectText();
    expect(scroll).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText("针对所选内容提问"));
    expect(screen.queryByRole("button", { name: "解释所选内容" })).toBeNull();
  } finally {
    if (previous) Object.defineProperty(Element.prototype, "scrollIntoView", previous);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

it("keeps selection local until explicit submit and shows validated sources on hover/pin", async () => {
  const fetcher = service(); const onSource = vi.fn();
  render(<InlineSideReader document={documentData} onSource={onSource} fetcher={fetcher} />);
  await chooseTask(); selectText();
  expect(screen.getByLabelText("针对所选内容提问")).toBeTruthy();
  expect(vi.mocked(fetcher).mock.calls).toHaveLength(2);
  expect(screen.getByText("MCP connects tools.").textContent).toBe("MCP connects tools.");
  compose();
  const capsule = await screen.findByRole("button", { name: "MCP · 1 条解释" });
  const preservedRange = document.createRange();
  const sourceText = screen.getByText("MCP connects tools.").firstChild!;
  preservedRange.setStart(sourceText, 0); preservedRange.setEnd(sourceText, 3);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(preservedRange);
  fireEvent.mouseUp(capsule);
  expect(screen.queryByLabelText("针对所选内容提问")).toBeNull();
  expect(screen.queryByText(result.answer.concept)).toBeNull();
  fireEvent.mouseEnter(capsule.closest(".inline-thread")!);
  expect(screen.getByText(result.answer.concept)).toBeTruthy();
  fireEvent.mouseLeave(capsule.closest(".inline-thread")!);
  expect(screen.queryByText(result.answer.concept)).toBeNull();
  fireEvent.click(capsule); fireEvent.mouseLeave(capsule.closest(".inline-thread")!);
  expect(screen.getByText(result.answer.concept)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "server.ts:1–1" }));
  expect(onSource).toHaveBeenCalledWith("server.ts", 1);
  expect(screen.getByText(/结论待确认/)).toBeTruthy();
  const call = JSON.parse(vi.mocked(fetcher).mock.calls[2]![1]!.body as string);
  expect(call.arguments).toMatchObject({ selectionHandle: "selected-1", documentPath: "README.md", startOffset: 0, endOffset: 3, question: "MCP 是什么？" });
});

it("retains answers for multiple selections and bounds follow-up context", async () => {
  const fetcher = service();
  render(<InlineSideReader document={documentData} onSource={vi.fn()} fetcher={fetcher} />);
  await chooseTask(); selectText(); compose();
  await screen.findByRole("button", { name: "MCP · 1 条解释" });
  selectText("Evidence stays current.", 0, 8); compose("证据如何更新？");
  await screen.findByRole("button", { name: "Evidence · 1 条解释" });
  const capsule = screen.getByRole("button", { name: "MCP · 1 条解释" });
  fireEvent.click(capsule); fireEvent.click(screen.getByRole("button", { name: "继续追问" }));
  fireEvent.change(screen.getByLabelText("针对所选内容提问"), { target: { value: "那它与插件有何关系？" } });
  fireEvent.click(screen.getByRole("button", { name: "提交问题" }));
  await screen.findByRole("button", { name: "MCP · 2 条解释" });
  const last = vi.mocked(fetcher).mock.calls.at(-1)!;
  const sent = JSON.parse(last[1]!.body as string).arguments.question;
  expect(sent).toContain("MCP 是什么？"); expect(sent).toContain("不可信引用"); expect(sent.length).toBeLessThanOrEqual(4096);
  fireEvent.click(screen.getByRole("button", { name: "MCP · 2 条解释" }));
  expect(screen.getByRole("heading", { name: "那它与插件有何关系？" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Evidence · 1 条解释" })).toBeTruthy();
});

it.each(["navigation", "cancel", "task", "hash"])("aborts and discards stale responses after %s", async reason => {
  let finish!: (response: Response) => void; let signal!: AbortSignal;
  const fetcher = service(options => { signal = options.signal!; return new Promise(resolve => { finish = resolve; }); });
  const props = { document: documentData, onSource: vi.fn(), fetcher };
  const view = render(<InlineSideReader {...props} />);
  await chooseTask(); selectText(); compose();
  await screen.findByRole("button", { name: "取消提问" });
  if (reason === "navigation") { view.rerender(<InlineSideReader {...props} document={null} />); view.rerender(<InlineSideReader {...props} />); }
  else if (reason === "cancel") fireEvent.click(screen.getByRole("button", { name: "取消提问" }));
  else if (reason === "hash") view.rerender(<InlineSideReader {...props} document={{ ...documentData, hash: "b".repeat(64) }} />);
  else fireEvent.change(screen.getByLabelText("选择 Codex 任务"), { target: { value: "" } });
  expect(signal.aborted).toBe(true);
  await act(async () => finish(response({ result })));
  expect(screen.queryByRole("button", { name: "MCP · 1 条解释" })).toBeNull();
});

it("rejects selecting answer UI as source and makes errors visible", async () => {
  const fetcher = service(async () => ({ ok: true, json: async () => ({ ok: false, error: { code: "SIDE_SOURCE_CHANGED" } }) }) as Response);
  render(<InlineSideReader document={documentData} onSource={vi.fn()} fetcher={fetcher} />);
  await chooseTask(); selectText(); compose();
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("已变化"));
  expect(screen.getByRole("alert").closest(".inline-composer")).toBeTruthy();
  expect(screen.getByText("MCP connects tools.").closest("[data-source-start]")?.textContent).toBe("MCP connects tools.");
  expect(screen.getByLabelText("针对所选内容提问").closest("[data-source-start]")).toBeNull();
});
it("shows actionable timeout diagnostics, copies them, and retains the question", async () => {
  const details = { code: "SIDE_TIMEOUT", message: "模型连接反复失败，最终超过等待时限。", suggestion: "检查本机代理是否运行。", requestId: "d699de5b-876a-4c85-a7d6-f83cbe36d644", diagnostic: { stage: "model", elapsedMs: 120000, retryCount: 4, lastErrorCode: "CONNECTION_FAILED" } };
  const writeText = vi.fn(async (_text: string) => {}); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<InlineSideReader document={documentData} onSource={vi.fn()} fetcher={service(async () => ({ ok: true, json: async () => ({ ok: false, error: details }) }) as Response)} />);
  await chooseTask(); selectText(); compose();
  const alert = await screen.findByRole("alert"); expect(alert.textContent).toContain("模型连接反复失败");
  fireEvent.click(screen.getByText("查看排查详情"));
  expect(alert.textContent).toContain("120.0 秒"); expect(alert.textContent).toContain("4 次"); expect(alert.textContent).toContain(details.requestId);
  fireEvent.click(screen.getByRole("button", { name: "复制诊断信息" }));
  await screen.findByText("已复制诊断信息"); expect(JSON.parse(writeText.mock.calls[0]![0]!)).toEqual(details);
  expect(screen.getByLabelText("针对所选内容提问")).toHaveProperty("value", "MCP 是什么？");
});
