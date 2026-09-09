import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { graph, renderFixture } from "./architecture-fixture.js";

async function setup(page: Page) {
  let online = true; let rootId = "root-initial"; const calls: any[] = [];
  await page.route("**/api/health", route => online ? route.fulfill({ json: { ok: true } }) : route.abort("connectionrefused"));
  await page.route("**/api/reader", route => {
    if (!online) return route.abort("connectionrefused");
    const call = route.request().postDataJSON(); calls.push(call);
    const data = call.name === "aimd_list_roots" ? { roots: [{ rootId, workspaceLabel: "示例项目", storageKey: "d".repeat(64) }] } : call.name === "aimd_list_documents" ? { documents: [] } : { source: { path: "gateway.ts", startLine: 1, endLine: 1, totalLines: 1, lines: [{ line: 1, text: "export const Gateway = Worker;" }], excerpt: "export const Gateway = Worker;", fileHash: "a".repeat(64), truncated: false } };
    return route.fulfill({ json: { structuredContent: data } });
  });
  await page.route("**/api/architecture", async route => {
    if (!online) return route.abort("connectionrefused");
    const call = route.request().postDataJSON(); calls.push(call);
    expect(route.request().headers()["x-arki-project"]).toBe("d".repeat(64));
    if (call.operation === "ask") {
      const next = structuredClone(call.graph);
      const readOnly = call.intent === "explain";
      if (!readOnly) { next.nodes[0].detail = "Gateway 接收请求并交给 Worker；导入关系由 gateway.ts 支持。"; next.version++; }
      return route.fulfill({ json: { ok: true, data: { ...await renderFixture(next), answer: "先阅读 Gateway，再沿代码导入找到 Worker [evidence-1]。", limitations: ["不能从静态导入断言执行频率。"], evidence: [{ ...graph.nodes[0]!.sources[0], id: "evidence-1", excerpt: "1: export const Gateway = Worker;" }], changedIds: readOnly ? [] : [next.nodes[0].id] } } });
    }
    return route.fulfill({ json: { ok: true, data: await renderFixture(call.graph) } });
  });
  return { calls, offline: () => { online = false; }, restart: () => { online = true; rootId = "root-restarted"; } };
}

test("一键分析生成文档与图形，问答保存后可离线重开并在后台重启后继续", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const fixture = await setup(page);
  await page.goto("/web.html");
  await expect(page.getByRole("button", { name: "一键分析当前项目" })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("arki-start.png") });
  await page.getByRole("button", { name: "一键分析当前项目" }).click();
  await expect(page.getByText("已完善 1 处", { exact: true })).toBeVisible();
  expect(fixture.calls.filter(call => call.operation === "ask")).toHaveLength(1);
  await page.getByRole("button", { name: "架构文档", exact: true }).click();
  const document = page.getByRole("article", { name: "架构说明文档" });
  await expect(document).toContainText("Gateway 接收请求并交给 Worker");
  await document.getByRole("button", { name: "提问此模块" }).first().click();
  await expect(page.getByLabel("想弄清这个部分的什么？")).toBeFocused();
  await page.getByRole("button", { name: "架构文档", exact: true }).click();
  await document.getByRole("button", { name: /gateway.ts:/ }).first().click();
  await expect(page.getByRole("dialog", { name: "证据来源" })).toContainText("export const Gateway = Worker");
  await page.getByLabel("关闭证据来源").click();
  const mdDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "导出 MD" }).click();
  const md = await readFile((await (await mdDownload).path())!, "utf8");
  expect(md).toContain("## 模块职责"); expect(md).toContain("gateway.ts");
  await page.getByLabel("提问整个项目架构").fill("刚才提到的入口，接下来读哪里？");
  await page.getByRole("button", { name: "回答架构问题" }).click();
  await expect(page.getByText("AI 解释", { exact: true })).toBeVisible();
  expect(fixture.calls.filter(call => call.operation === "ask")[1].conversation).toHaveLength(1);
  await expect(page.getByText("已保存的问答 · 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "架构图工作台" }).getByText(/保存在此浏览器/)).toBeVisible();
  fixture.offline(); await page.reload();
  await expect(page.getByText("本地后台暂未连接", { exact: true })).toBeVisible();
  await expect(page.locator("[data-node-id]")).toHaveCount(2);
  await page.getByText("已保存的问答 · 2", { exact: true }).click();
  await page.getByText("gateway.ts:1 · 当时的代码证据", { exact: true }).first().click();
  await expect(page.locator(".architecture-history pre").first()).toContainText("export const Gateway = Worker");
  await page.getByRole("button", { name: "架构文档", exact: true }).click();
  await expect(document).toContainText("Gateway 接收请求并交给 Worker");
  await page.getByRole("button", { name: "关闭架构文档", exact: true }).click();
  await page.getByLabel("提问整个项目架构").fill("继续解释模块关系");
  await expect(page.getByRole("button", { name: "回答架构问题" })).toBeDisabled();
  const offlineExport = page.waitForEvent("download"); await page.getByRole("button", { name: "导出 HTML" }).click();
  expect(await readFile((await (await offlineExport).path())!, "utf8")).toContain("Gateway");
  await page.screenshot({ path: testInfo.outputPath("arki-offline.png") });
  fixture.restart(); await page.getByRole("button", { name: "立即重连" }).click();
  await expect(page.getByRole("button", { name: "回答架构问题" })).toBeEnabled();
  expect(fixture.calls.filter(call => call.operation === "ask")).toHaveLength(2);
  await page.getByRole("button", { name: "架构文档", exact: true }).click();
  await document.getByRole("button", { name: /gateway.ts:/ }).first().click();
  expect(fixture.calls.filter(call => call.name === "aimd_read_source").at(-1).arguments.rootId).toBe("root-restarted");
  await page.getByLabel("关闭证据来源").click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("arki-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("启动器的自动分析入口只执行一次，刷新恢复现有版本", async ({ page }) => {
  const fixture = await setup(page);
  await page.goto("/web.html#analyze");
  await expect(page.getByText("已完善 1 处", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#architecture$/);
  await expect(page.getByRole("region", { name: "架构图工作台" }).getByText(/保存在此浏览器/)).toBeVisible();
  await page.reload();
  await expect(page.locator("[data-node-id]")).toHaveCount(2);
  await expect(page.getByText("已保存的问答 · 1", { exact: true })).toBeVisible();
  expect(fixture.calls.filter(call => call.operation === "ask")).toHaveLength(1);
  await page.getByRole("button", { name: "文档工作台", exact: true }).click();
  await expect(page).toHaveURL(/#documents$/);
  await page.reload();
  await expect(page.getByRole("button", { name: "一键分析当前项目" })).toBeVisible();
});
