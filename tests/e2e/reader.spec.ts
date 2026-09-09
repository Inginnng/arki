import { expect, test } from "@playwright/test";

test("默认中文界面可完成选区、提问、证据检查、审批和安全写入", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("/mock.html");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "AIMD Reader：项目流程与实现方式", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("main").getByText("docs/project-introduction.zh-CN.md", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("模拟后端 · 固定数据 · 不会调用 Codex", { exact: true })).toBeVisible();
  await expect(page.getByText("仅使用项目证据——任务上下文不可用")).toBeVisible();

  const passage = page.getByRole("heading", { name: "1. 项目定位", level: 2 });
  await passage.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  const question = page.getByLabel("针对所选内容提问");
  await expect(question).toBeVisible();
  await question.fill("这段内容如何保持项目事实可追溯？");
  await question.press("Control+Enter");
  await expect(page.getByText(/这段内容说明了从源码选区到证据审核/)).toBeVisible();
  await expect(page.getByText("AI 证据已审核")).toBeVisible();

  await page.getByRole("button", { name: /docs\/project-introduction\.zh-CN\.md:\d+ 打开证据来源/ }).click();
  const source = page.getByRole("dialog", { name: "证据来源" });
  await expect(source).toContainText("不会让模型直接修改项目文档");
  await source.getByRole("button", { name: "关闭证据来源" }).click();

  await page.getByLabel("写入位置").selectOption("inline");
  await page.getByRole("button", { name: "生成解释版文档预览" }).click();
  const review = page.getByRole("dialog", { name: "解释版文档审核" });
  await expect(review.getByRole("heading", { name: "原文" })).toBeVisible();
  await expect(review.getByRole("heading", { name: "生成结果" })).toBeVisible();
  await expect(review.getByRole("heading", { name: "统一差异" })).toBeVisible();
  await review.getByRole("button", { name: "批准此精确差异" }).click();
  await review.getByRole("button", { name: "写入 .explained.md 文件" }).click();
  await expect(review.getByText(/已创建 docs\/project-introduction\.zh-CN\.explained\.md/)).toBeVisible();
  await expect(review.getByText("不会覆盖源文档。")).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath("reader-success.png"), animations: "disabled" });
  expect(consoleErrors).toEqual([]);
});

test("移动端选区保持阅读位置，并由用户明确打开提问框", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/mock.html");

  const passage = page.getByRole("heading", { name: "1. 项目定位", level: 2 });
  await passage.scrollIntoViewIfNeeded();
  const beforeSelection = await page.evaluate(() => window.scrollY);
  await passage.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  await expect(page.getByRole("button", { name: "向所选内容提问" })).toBeVisible();
  await expect.poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - beforeSelection)).toBeLessThan(100);

  await page.getByRole("button", { name: "向所选内容提问" }).click();
  const question = page.getByLabel("针对所选内容提问");
  await expect(question).toBeFocused();
  await expect(question).toBeInViewport();
});
