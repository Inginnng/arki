import { expect, test, type Page } from "@playwright/test";
import { graph, renderFixture } from "./architecture-fixture.js";
async function setup(page: Page) {
  const calls: any[] = [];
  await page.route("**/api/health", route => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/reader", route => {
    const call = route.request().postDataJSON();
    return route.fulfill({ json: { structuredContent: call.name === "aimd_list_roots" ? { roots: [{ rootId: "root-fixture", workspaceLabel: "示例项目", storageKey: "c".repeat(64) }] } : call.name === "aimd_list_documents" ? { documents: [] } : { source: { path: "gateway.ts", startLine: 1, endLine: 1, totalLines: 1, lines: [{ line: 1, text: "export const Gateway = Worker;" }], excerpt: "export const Gateway = Worker;", fileHash: "a".repeat(64), truncated: false } } } });
  });
  let waitForAsk: (() => Promise<void>) | undefined;
  let failure: unknown = null;
  await page.route("**/api/architecture", async route => {
    const call = route.request().postDataJSON(); calls.push(call);
    if (call.operation === "ask") {
      if (call.intent === "analyze") return route.fulfill({ json: { ok: true, data: { ...await renderFixture(call.graph), answer: "示例架构已读取。", limitations: [], evidence: [], changedIds: [] } } });
      if (failure) return route.fulfill({ json: { ok: false, error: failure } });
      await waitForAsk?.();
      const next = structuredClone(call.graph);
      if (call.target.kind === "node") { next.nodes[0].summary = "接收请求并转发处理"; next.nodes[0].detail = "Gateway 接收请求并交给 Worker。"; }
      else { next.edges[0].label = "转发处理"; next.edges[0].detail = "Gateway 将请求交给 Worker。"; }
      next.version++;
      return route.fulfill({ json: { ok: true, data: { ...await renderFixture(next), answer: "已根据 gateway.ts 完善选中部分。", limitations: [], evidence: [{ ...graph.nodes[0]!.sources[0], id: "evidence-1", excerpt: "export const Gateway = Worker;" }], changedIds: [call.target.id] } } });
    }
    if (call.operation === "export") return route.fulfill({ json: { ok: true, data: { html: "<!doctype html><title>Archify</title>" } } });
    return route.fulfill({ json: { ok: true, data: await renderFixture(call.graph) } });
  });
  await page.goto("/web.html");
  await page.getByRole("button", { name: "架构工作台", exact: true }).click();
  await expect(page.locator("[data-node-id]")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "重新生成", exact: true })).toBeEnabled(); calls.length = 0;
  return { calls, failAsk: (value: unknown) => { failure = value; }, holdAsk: (hold: () => Promise<void>) => { waitForAsk = hold; } };
}
test("真实组件矩形与依赖关系可选择，AI 修改能撤销、恢复和持久化", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const { calls } = await setup(page);
  await page.locator('[data-node-id="gateway"]').click();
  await expect(page.getByRole("heading", { name: "Gateway", exact: true })).toBeVisible();
  await page.getByLabel("想弄清这个部分的什么？").fill("补充处理职责");
  await page.getByRole("button", { name: "解释并完善", exact: true }).click();
  await expect(page.getByText("已完善 1 处", { exact: true })).toBeVisible();
  expect(calls.find(call => call.operation === "ask").target).toEqual({ kind: "node", id: "gateway" });
  await expect(page.locator('[data-node-id="gateway"]')).toContainText("接收请求并转发处理");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator('[data-node-id="gateway"]')).toContainText("请求入口");
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(page.locator('[data-node-id="gateway"]')).toContainText("接收请求并转发处理");
  await page.locator(".architecture-relations>summary").click();
  await page.locator(".architecture-relations button").filter({ hasText: "引用" }).click();
  await expect(page.getByRole("heading", { name: "引用", exact: true })).toBeVisible();
  await page.getByLabel("想弄清这个部分的什么？").fill("完善这条关系"); await page.getByRole("button", { name: "解释并完善", exact: true }).click();
  await expect(page.getByRole("heading", { name: "转发处理", exact: true })).toBeVisible();
  expect(calls.filter(call => call.operation === "ask")[1].target).toEqual({ kind: "edge", id: "requests" });
  await page.getByRole("button", { name: "gateway.ts:1", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "证据来源" })).toContainText("export const Gateway = Worker;");
  await page.getByRole("button", { name: "关闭证据来源" }).click();
  await page.screenshot({ path: testInfo.outputPath("architecture-edited.png") });
  await page.reload(); await page.getByRole("button", { name: "架构工作台", exact: true }).click();
  await expect(page.locator('[data-node-id="gateway"]')).toContainText("接收请求并转发处理");
  await page.locator(".architecture-relations>summary").click();
  await page.locator(".architecture-relations button").filter({ hasText: "转发处理" }).press("Enter");
  await expect(page.getByRole("heading", { name: "转发处理", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "深色", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("architecture-dark.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("architecture-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});
test("取消后迟到的结果不改变架构，伪造消息不能选择节点", async ({ page }) => {
  const { holdAsk } = await setup(page);
  await page.evaluate(() => window.postMessage({ type: "select", channel: "forged", target: { kind: "node", id: "gateway" } }, "*"));
  await expect(page.getByRole("heading", { name: "从一个模块开始", exact: true })).toBeVisible();
  await page.locator('[data-node-id="gateway"]').press("Enter");
  let release!: () => void; holdAsk(() => new Promise<void>(resolve => { release = resolve; }));
  await page.getByLabel("想弄清这个部分的什么？").fill("完善职责"); await page.getByRole("button", { name: "解释并完善", exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.locator('[data-node-id="worker"]').click();
  await expect(page.getByRole("heading", { name: "Gateway", exact: true })).toBeVisible();
  await expect(page.locator('[data-node-id="gateway"]')).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "取消", exact: true }).click(); release();
  await expect(page.getByRole("button", { name: "撤销", exact: true })).toBeDisabled();
  await expect(page.locator('[data-node-id="gateway"]')).toContainText("请求入口");
  await page.getByRole("button", { name: "文档工作台", exact: true }).click();
  await page.getByRole("button", { name: "架构工作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Gateway", exact: true })).toBeVisible();
});
test("编辑范围可选择，失败显示具体对象和证据并支持复制诊断", async ({ page }, testInfo) => {
  const { calls, failAsk } = await setup(page);
  await page.locator('[data-node-id="gateway"]').click();
  await expect(page.getByLabel("允许 AI 修改的范围")).toHaveValue("related");
  await page.getByLabel("允许 AI 修改的范围").selectOption("diagram");
  const requestId = "d699de5b-876a-4c85-a7d6-f83cbe36d644";
  failAsk({ code: "ARCHITECTURE_UNKNOWN_EVIDENCE", message: "AI 引用了本次未提供的证据编号。", stage: "validation", suggestion: "重新提交问题；若反复发生，请复制诊断信息。", requestId, repairAttempts: 1, issues: [{ code: "ARCHITECTURE_UNKNOWN_EVIDENCE", objectId: "worker", field: "nodeUpdates.evidenceIds", message: "本次没有提供这些证据编号，无法核验该修改。", actual: "evidence-99", expected: "evidence-1, evidence-2" }] });
  await page.getByLabel("想弄清这个部分的什么？").fill("完善关联模块");
  await page.getByRole("button", { name: "解释并完善", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("原图已保留");
  await alert.getByText("查看排查详情（1 项）", { exact: true }).click();
  await expect(alert).toContainText("已尝试 1 次，仍未通过");
  await expect(alert).toContainText("worker"); await expect(alert).toContainText("evidence-99"); await expect(alert).toContainText(requestId);
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (text: string) => { (window as any).copiedArchitectureDiagnostic = text; } }); });
  await alert.getByRole("button", { name: "复制诊断信息", exact: true }).click();
  await expect(alert.getByRole("status")).toHaveText("已复制诊断信息");
  expect(JSON.parse(await page.evaluate(() => (window as any).copiedArchitectureDiagnostic)).requestId).toBe(requestId);
  expect(calls.find(call => call.operation === "ask").scope).toBe("diagram");
  await expect(page.getByLabel("想弄清这个部分的什么？")).toHaveValue("完善关联模块");
  await expect(page.locator('[data-node-id="gateway"]')).toContainText("请求入口");
  await page.screenshot({ path: testInfo.outputPath("architecture-diagnostic.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  failAsk(null);
  await page.getByRole("button", { name: "解释并完善", exact: true }).click();
  await expect(page.getByText("已完善 1 处", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
test("损坏的架构存档不会卡住或被静默覆盖", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await setup(page); await expect(page.getByRole("region", { name: "架构图工作台" }).getByText(/保存在此浏览器/)).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve, reject) => { const request = indexedDB.open("aimd-architecture", 1); request.onsuccess = () => { const db = request.result; const tx = db.transaction("graphs", "readwrite"); tx.objectStore("graphs").put({ graphs: [], cursor: 999 }, "c".repeat(64)); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; }));
  await page.reload(); await page.getByRole("button", { name: "架构工作台", exact: true }).click();
  await expect(page.locator("[data-node-id]")).toHaveCount(2);
  await expect(page.getByRole("alert")).toContainText("原存档已保留"); await expect(page.getByText(/尚未保存，请导出/)).toBeVisible();
  const stored = await page.evaluate(() => new Promise<unknown>(resolve => { const request = indexedDB.open("aimd-architecture", 1); request.onsuccess = () => { const db = request.result; const read = db.transaction("graphs").objectStore("graphs").get("c".repeat(64)); read.onsuccess = () => { const value = read.result; db.close(); resolve(value); }; }; }));
  expect(stored).toEqual({ graphs: [], cursor: 999 }); expect(errors).toEqual([]);
});
test("保存空间不足时保留内存中的修改和撤销能力，并明确标记未保存", async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>) { if (this.name === "aimd-architecture" && args[1] === "readwrite") throw new DOMException("Quota reached", "QuotaExceededError"); return original.apply(this, args); };
  });
  await setup(page); await expect(page.getByRole("alert")).toContainText("浏览器保存失败");
  await expect(page.getByText(/尚未保存，请导出/)).toBeVisible();
  await page.locator('[data-node-id="gateway"]').click();
  await page.getByLabel("想弄清这个部分的什么？").fill("完善职责"); await page.getByRole("button", { name: "解释并完善", exact: true }).click();
  await expect(page.locator('[data-node-id="gateway"]')).toContainText("接收请求并转发处理");
  await expect(page.getByText(/尚未保存，请导出/)).toBeVisible(); await expect(page.getByRole("button", { name: "导出 HTML", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator('[data-node-id="gateway"]')).toContainText("请求入口");
});
