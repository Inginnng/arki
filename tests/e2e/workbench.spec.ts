import { expect, test, type Page } from "@playwright/test";

import { renderFixture } from "./architecture-fixture.js";

const hash = "a".repeat(64);
const sources: Record<string, string> = {
  "README.md": "# 项目概览\n\nGateway receives requests and calls Worker.\n",
  "docs/architecture.md": "# 系统设计\n\nGateway routes requests to Worker.\n",
};
async function fixture(page: Page) {
  const calls: { operation?: string; name?: string; arguments: any }[] = [];
  await page.route("**/api/health", route => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/reader", route => {
    const call = route.request().postDataJSON(); calls.push(call);
    const data = call.name === "aimd_list_roots" ? { roots: [{ rootId: "root-workbench", workspaceLabel: "示例项目", storageKey: hash }] }
      : call.name === "aimd_list_documents" ? { documents: Object.entries(sources).map(([path, text]) => ({ path, title: text.split("\n")[0]!.slice(2), hash })) }
      : call.name === "aimd_read_document" ? { document: { path: call.arguments.path, markdown: sources[call.arguments.path], hash, headings: [], anchorStatus: { status: "current" } } }
      : { source: { path: "gateway.ts", startLine: 1, endLine: 1, totalLines: 1, lines: [{ line: 1, text: "export const Gateway = Worker;" }], excerpt: "1: export const Gateway = Worker;", fileHash: hash, truncated: false } };
    return route.fulfill({ json: { content: [], structuredContent: data } });
  });
  await page.route("**/api/side", route => {
    const call = route.request().postDataJSON(); calls.push(call);
    const data = call.operation === "list" ? { tasks: [{ handle: "task-choice", title: "架构讨论", updatedAt: 100 }] }
      : call.operation === "select" ? { selection: { handle: "selected-task", title: "架构讨论", cutoffLabel: "截至已完成讨论", historyTruncated: false } }
      : { result: { answer: { concept: "", projectClaims: [{ statement: "Gateway 将请求交给 Worker。", evidenceIds: ["evidence-1"] }], taskDiscussion: "", unknowns: [] }, evidence: [{ id: "evidence-1", path: "gateway.ts", startLine: 1, endLine: 1, excerpt: "1: export const Gateway = Worker;", fileHash: hash }], retrievalTruncated: true, reviewStatus: "citation_validated" } };
    return route.fulfill({ json: { ok: true, data } });
  });
  await page.route("**/api/architecture", async route => {
    const call = route.request().postDataJSON(); calls.push(call);
    return route.fulfill({ json: { ok: true, data: await renderFixture(call.graph) } });
  });
  return calls;
}
async function add(page: Page, title: string) {
  await page.getByRole("button", { name: "＋ 从项目添加", exact: true }).click();
  await page.getByRole("checkbox", { name: new RegExp(title) }).check();
  await page.getByRole("button", { name: "添加到工作台" }).click();
}

test("按需添加、搜索、持久化和移除项目文档，两个工作台互不混杂", async ({ page }, testInfo) => {
  const calls = await fixture(page);
  await page.goto("/web.html");
  await expect(page.getByRole("heading", { name: "从项目全貌，读到代码证据" })).toBeVisible();
  expect(calls.some(call => call.name === "aimd_read_document")).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("workbench-empty.png") });
  await add(page, "项目概览");
  await expect(page.getByRole("heading", { name: "项目概览", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "架构工作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "项目架构", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "工作台文档" })).not.toBeVisible();
  await expect(page.locator("[data-node-id]")).toHaveCount(2);
  await page.getByRole("button", { name: "文档工作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "项目概览", exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "搜索工作台文档" }).fill("不存在");
  await expect(page.getByText("没有匹配的文档", { exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "搜索工作台文档" }).fill("");
  await page.reload();
  await page.getByRole("navigation", { name: "工作台文档" }).getByRole("button", { name: /^项目概览 / }).click();
  await expect(page.getByRole("heading", { name: "项目概览", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("workbench-reading.png") });
  await page.getByRole("button", { name: "从工作台移除 项目概览" }).click();
  await expect(page.getByRole("heading", { name: "从项目全貌，读到代码证据" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("navigation", { name: "工作台文档" })).not.toContainText("项目概览");
  await page.getByRole("button", { name: "架构工作台", exact: true }).click();
  await expect(page.locator("[data-node-id]")).toHaveCount(2);
  expect(calls.filter(call => call.name?.includes("write"))).toHaveLength(0);
});

test("本地 Markdown 可批量导入并恢复，非法文件被拒绝且不会触发项目问答", async ({ page }) => {
  const calls = await fixture(page);
  await page.goto("/web.html");
  await expect(page.getByRole("button", { name: "＋ 从项目添加", exact: true })).toBeEnabled();
  await page.getByLabel("导入 Markdown 文件").setInputFiles([
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# 我的笔记\n\n本地保存的内容。") },
    { name: "other.markdown", mimeType: "text/markdown", buffer: Buffer.from("# 第二篇资料\n\n补充信息。") },
    { name: "invalid.txt", mimeType: "text/plain", buffer: Buffer.from("拒绝的文件") },
  ]);
  await expect(page.getByRole("heading", { name: "我的笔记", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("invalid.txt");
  await expect(page.getByRole("navigation", { name: "工作台文档" })).toContainText("第二篇资料");
  await page.reload();
  await page.getByRole("navigation", { name: "工作台文档" }).getByRole("button", { name: /^我的笔记 / }).click();
  await expect(page.getByText("本地保存的内容。")).toBeVisible();
  expect(calls.some(call => call.name === "aimd_read_document" || call.operation)).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("Markdown 连接超时显示诊断，保留问题并支持重新提交", async ({ page }, testInfo) => {
  await fixture(page); let failed = true;
  await page.route("**/api/side", async route => {
    if (route.request().postDataJSON().operation !== "ask" || !failed) return route.fallback();
    return route.fulfill({ json: { ok: false, error: { code: "SIDE_TIMEOUT", message: "模型连接反复失败，最终超过等待时限。", suggestion: "检查本机代理是否运行。", requestId: "d699de5b-876a-4c85-a7d6-f83cbe36d644", diagnostic: { stage: "model", elapsedMs: 120000, retryCount: 4, lastErrorCode: "CONNECTION_FAILED" } } } });
  });
  await page.goto("/web.html"); await add(page, "项目概览");
  await page.getByLabel("选择 Codex 任务").selectOption("task-choice");
  await expect(page.getByText("截至已完成讨论", { exact: true })).toBeAttached();
  await page.getByText("Gateway receives requests and calls Worker.", { exact: true }).evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
  await page.getByLabel("针对所选内容提问").fill("解释入口职责"); await page.getByRole("button", { name: "提交问题", exact: true }).click();
  const alert = page.getByRole("alert"); await expect(alert).toContainText("模型连接反复失败");
  await alert.getByText("查看排查详情", { exact: true }).click(); await expect(alert).toContainText("120.0 秒"); await expect(alert).toContainText("4 次");
  await expect(alert.getByRole("button", { name: "复制诊断信息", exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("md-timeout-diagnostic.png") });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByLabel("针对所选内容提问")).toHaveValue("解释入口职责");
  await expect(alert.getByRole("button", { name: "复制诊断信息", exact: true })).toBeInViewport();
  failed = false; await page.getByRole("button", { name: "提交问题", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
