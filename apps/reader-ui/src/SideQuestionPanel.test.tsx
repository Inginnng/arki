import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SideQuestionPanel } from "./SideQuestionPanel.js";
afterEach(cleanup);

it.each(["navigation", "cancel", "task"])("aborts and ignores late answers after %s", async reason => {
  let finish!: (response: Response) => void;
  let askSignal!: AbortSignal;
  const response = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) }) as Response;
  const fetcher = vi.fn(async (_url: unknown, options: any) => {
    const call = JSON.parse(options.body);
    if (call.operation === "list") return response({ tasks: [{ handle: "choice-1", title: "任务甲", updatedAt: 100 }] });
    if (call.operation === "select") return response({ selection: { handle: "selected-1", title: "任务甲", cutoffLabel: "固定截止", historyTruncated: false } });
    askSignal = options.signal;
    return new Promise<Response>(resolve => { finish = resolve; });
  }) as unknown as typeof fetch;
  const props = { document: { path: "README.md", hash: "a".repeat(64) }, selection: { startOffset: 5, endOffset: 8, renderedText: "MCP" }, onSource: vi.fn(), fetcher };
  const view = render(<SideQuestionPanel {...props} />);
  await screen.findByRole("option", { name: "任务甲" });
  fireEvent.change(screen.getByLabelText("选择 Codex 任务"), { target: { value: "choice-1" } });
  await screen.findByText("固定截止");
  fireEvent.change(screen.getByLabelText("针对所选内容提问"), { target: { value: "问题" } });
  fireEvent.click(screen.getByRole("button", { name: "提交问题" }));
  await screen.findByRole("button", { name: "取消提问" });
  if (reason === "navigation") view.rerender(<SideQuestionPanel {...props} document={null} />);
  else if (reason === "cancel") fireEvent.click(screen.getByRole("button", { name: "取消提问" }));
  else fireEvent.change(screen.getByLabelText("选择 Codex 任务"), { target: { value: "" } });
  expect(askSignal.aborted).toBe(true);
  await act(async () => finish(response({ result: { answer: { concept: "不应显示的旧回答", projectClaims: [], taskDiscussion: "", unknowns: [] }, evidence: [], reviewStatus: "citation_validated", retrievalTruncated: false } })));
  expect(screen.queryByText("不应显示的旧回答")).toBeNull();
});
it("requires explicit task choice and sends actual selection then displays concept and evidence", async () => {
  const calls: any[] = [];
  const fetcher = vi.fn(async (_url: unknown, options: any) => {
    const call = JSON.parse(options.body); calls.push(call);
    const data = call.operation === "list" ? { tasks: [{ handle: "choice-1", title: "任务甲", updatedAt: 100 }] }
      : call.operation === "select" ? { selection: { handle: "selected-1", title: "任务甲", cutoffLabel: "截至已完成讨论", historyTruncated: false } }
      : { result: { answer: { concept: "MCP 是模型上下文协议。", projectClaims: [{ statement: "使用 stdio", evidenceIds: ["evidence-1"] }], taskDiscussion: "先适配 Codex", unknowns: [] }, evidence: [{ id: "evidence-1", path: "server.ts", startLine: 1, endLine: 1, excerpt: "stdio", fileHash: "a".repeat(64) }], reviewStatus: "citation_validated", retrievalTruncated: false } };
    return { ok: true, json: async () => ({ ok: true, data }) } as Response;
  }) as unknown as typeof fetch;
  const onSource = vi.fn();
  render(<SideQuestionPanel document={{ path: "README.md", hash: "a".repeat(64) }} selection={{ startOffset: 5, endOffset: 8, renderedText: "MCP" }} onSource={onSource} fetcher={fetcher} />);
  await screen.findByRole("option", { name: "任务甲" });
  expect((screen.getByRole("button", { name: "提交问题" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("选择 Codex 任务"), { target: { value: "choice-1" } });
  await screen.findByText("截至已完成讨论");
  fireEvent.change(screen.getByLabelText("针对所选内容提问"), { target: { value: "MCP 是什么？" } });
  fireEvent.click(screen.getByRole("button", { name: "提交问题" }));
  await screen.findByText("MCP 是模型上下文协议。");
  expect(calls.find(call => call.operation === "ask").arguments).toMatchObject({ selectionHandle: "selected-1", documentPath: "README.md", startOffset: 5, endOffset: 8, question: "MCP 是什么？" });
  fireEvent.click(screen.getByRole("button", { name: "server.ts:1–1" }));
  expect(onSource).toHaveBeenCalledWith("server.ts", 1);
  expect(screen.getByText(/未进行独立语义审核/)).toBeTruthy();
});
