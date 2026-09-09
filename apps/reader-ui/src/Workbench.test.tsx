import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench.js";
import type { ReaderHost } from "./host.js";
import { loadCollection, saveCollection } from "./workbench-store.js";

vi.mock("./workbench-store.js", () => ({ loadCollection: vi.fn(), saveCollection: vi.fn() }));
vi.mock("./InlineSideReader.js", () => ({ InlineSideReader: ({ document }: { document: { path: string } | null }) => <div data-testid="opened-document">{document?.path}</div> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("does not invalidate a newly opened document when removing the previous one finishes late", async () => {
  vi.mocked(loadCollection).mockResolvedValue({ documents: [
    { id: "project:one.md", path: "one.md", title: "第一篇" },
    { id: "project:two.md", path: "two.md", title: "第二篇" },
  ], architecture: [] });
  let finishSave!: () => void;
  vi.mocked(saveCollection).mockImplementation(() => new Promise<void>(resolve => { finishSave = resolve; }));
  let finishRead!: (value: unknown) => void;
  const document = (path: string) => ({ document: { path, hash: "a".repeat(64), markdown: path, headings: [], anchorStatus: { status: "current" } } });
  const host = {
    connect: vi.fn(async () => undefined),
    call: vi.fn(async (tool, input) => {
      if (tool === "aimd_list_roots") return { roots: [{ rootId: "root-one", workspaceLabel: "项目" }] };
      if (tool === "aimd_list_documents") return { documents: [] };
      const path = (input as { path: string }).path;
      if (path === "two.md") return new Promise(resolve => { finishRead = resolve; });
      return document(path);
    }),
  } as unknown as ReaderHost;
  render(<Workbench host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: "第一篇 one.md" }));
  expect((await screen.findByTestId("opened-document")).textContent).toBe("one.md");
  fireEvent.click(screen.getByRole("button", { name: "从工作台移除 第一篇" }));
  await waitFor(() => expect(saveCollection).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "第二篇 two.md" }));
  await screen.findByText("正在读取文档…");
  finishSave();
  await waitFor(() => expect(screen.queryByRole("button", { name: "从工作台移除 第一篇" })).toBeNull());
  finishRead(document("two.md"));
  await waitFor(() => expect(screen.getByTestId("opened-document").textContent).toBe("two.md"));
});
