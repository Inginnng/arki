// Browser interaction contract only: every API response below is an explicit test fixture.
// This does not measure real Codex availability or answer accuracy.
import { expect, test } from "@playwright/test";
test("新中文网页通过段落内胶囊提问并按悬停收放解释", async ({ page }, testInfo) => {
  const hash = "a".repeat(64);
  const markdown = "# 测试文档\n\nMCP connects tools.";
  const requests: any[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/health", route => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/reader", route => {
    const { name } = route.request().postDataJSON();
    const data = name === "aimd_list_roots" ? { roots: [{ rootId: "root-fixture", workspaceLabel: "测试项目" }] }
      : name === "aimd_list_documents" ? { documents: [{ path: "README.md", title: "测试文档", hash }] }
      : name === "aimd_read_document" ? { document: { path: "README.md", hash, markdown, headings: [], anchorStatus: { status: "current" } } }
      : { session: { id: "session-fixture", rootId: "root-fixture", workspaceLabel: "测试项目", documentPath: "README.md", bindingStatus: "unavailable", contextMode: "project_only" } };
    return route.fulfill({ json: { content: [], structuredContent: data } });
  });
  await page.route("**/api/side", route => {
    const call = route.request().postDataJSON(); requests.push(call);
    const data = call.operation === "list" ? { tasks: [{ handle: "fixture-choice", title: "离线测试任务", updatedAt: 100 }] }
      : call.operation === "select" ? { selection: { handle: "fixture-selected", title: "离线测试任务", cutoffLabel: "测试截止点", historyTruncated: true } }
      : { result: { answer: { concept: "测试概念回答", projectClaims: [{ statement: "测试引用说明", evidenceIds: ["evidence-1"] }], taskDiscussion: "测试任务讨论", unknowns: ["测试未知项"] }, evidence: [{ id: "evidence-1", path: "README.md", startLine: 3, endLine: 3, excerpt: "3: MCP connects tools.", fileHash: hash }], retrievalTruncated: true, reviewStatus: "citation_validated" } };
    return route.fulfill({ json: { ok: true, data } });
  });
  await page.goto("/web.html");
  await page.getByRole("button", { name: "＋ 从项目添加", exact: true }).click();
  await page.getByRole("checkbox", { name: /测试文档/ }).check();
  await page.getByRole("button", { name: "添加到工作台" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "测试文档", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "提问与证据" })).toHaveCount(0);
  const typography = await page.locator(".markdown-paper").evaluate(element => ({ font: getComputedStyle(element).fontFamily, size: parseFloat(getComputedStyle(element).fontSize) }));
  expect(typography.font).not.toMatch(/(?:^|[ ,])serif(?:$|[ ,])/);
  expect(typography.size).toBeGreaterThanOrEqual(16);
  await page.getByLabel("选择 Codex 任务").selectOption({ label: "离线测试任务" });
  const passage = page.locator(".markdown-paper p");
  const selectionBox = await passage.evaluate(element => {
    const range = document.createRange();
    range.setStart(element.firstChild!, 0); range.setEnd(element.firstChild!, 3);
    const rect = range.getBoundingClientRect();
    return { x: rect.left, y: rect.top + rect.height / 2, width: rect.width };
  });
  const scrollBeforeSelection = await page.evaluate(() => window.scrollY);
  await page.mouse.move(selectionBox.x, selectionBox.y);
  await page.mouse.down();
  await page.mouse.move(selectionBox.x + selectionBox.width, selectionBox.y, { steps: 8 });
  await page.mouse.up();
  expect(requests.filter(call => call.operation === "ask")).toHaveLength(0);
  await expect(page.getByLabel("针对所选内容提问")).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeSelection);
  await expect(page.getByRole("button", { name: "解释所选内容" })).toHaveCount(0);
  const sourceBox = (await passage.boundingBox())!;
  const popupBox = (await page.getByRole("region", { name: "划词提问" }).boundingBox())!;
  expect(Math.abs(popupBox.y - (sourceBox.y + sourceBox.height))).toBeLessThan(30);
  await page.getByLabel("针对所选内容提问").fill("测试问题");
  await page.screenshot({ path: testInfo.outputPath("inline-composer.png"), animations: "disabled" });
  await page.getByRole("button", { name: "提交问题" }).click();
  const capsule = page.getByRole("button", { name: /MCP.*1.*解释/ });
  await expect(capsule).toBeVisible();
  await page.mouse.move(0, 0);
  await page.getByRole("heading", { name: "测试文档", exact: true }).click();
  await expect(page.getByText("测试概念回答", { exact: true })).not.toBeVisible();
  await capsule.hover();
  await expect(page.getByText("测试概念回答", { exact: true })).toBeVisible();
  expect(requests.find(call => call.operation === "ask").arguments).toMatchObject({
    selectionHandle: "fixture-selected", question: "测试问题", documentPath: "README.md",
    documentHash: hash, startOffset: markdown.indexOf("MCP"), endOffset: markdown.indexOf("MCP") + 3,
  });
  await expect(page.getByText("测试任务讨论", { exact: true })).toBeVisible();
  await expect(page.getByText("引用已核验 · 结论待确认")).toBeVisible();
  await expect(page.getByRole("button", { name: "生成解释版文档预览" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("inline-answer.png"), animations: "disabled" });
  await page.mouse.move(0, 0);
  await expect(page.getByText("测试概念回答", { exact: true })).not.toBeVisible();
  await capsule.click();
  await page.mouse.move(0, 0);
  await expect(page.getByText("测试概念回答", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("选择 Codex 任务")).toBeVisible();
  expect((await page.getByLabel("选择 Codex 任务").boundingBox())!.width).toBeGreaterThan(240);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("inline-mobile.png"), animations: "disabled" });
  await passage.first().evaluate(element => {
    const start = element.textContent!.indexOf("tools");
    const range = document.createRange();
    range.setStart(element.firstChild!, start); range.setEnd(element.firstChild!, start + 5);
    const selected = window.getSelection(); selected?.removeAllRanges(); selected?.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await expect(page.getByLabel("针对所选内容提问")).toBeVisible();
  await page.getByLabel("针对所选内容提问").fill("第二个选区的问题");
  await page.getByRole("button", { name: "提交问题", exact: true }).click();
  const secondCapsule = page.getByRole("button", { name: /tools.*1.*解释/ });
  await expect(secondCapsule).toBeVisible();
  await expect(capsule).toBeVisible();
  expect(requests.filter(call => call.operation === "ask")).toHaveLength(2);
  await secondCapsule.focus();
  await expect(page.getByRole("region", { name: "tools 的解释", exact: true })).toBeVisible();
  await secondCapsule.press("Escape");
  await expect(page.getByRole("region", { name: "tools 的解释", exact: true })).toHaveCount(0);
  await passage.first().evaluate(element => {
    const range = document.createRange(); range.setStart(element.firstChild!, 4); range.setEnd(element.firstChild!, 12);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await expect(page.getByLabel("针对所选内容提问")).toBeVisible();
  const mobilePopup = (await page.locator(".selection-popup").boundingBox())!;
  expect(mobilePopup.x).toBeGreaterThanOrEqual(0);
  expect(mobilePopup.x + mobilePopup.width).toBeLessThanOrEqual(390);
  await page.getByRole("heading", { name: "测试文档", exact: true }).click();
  await expect(page.getByLabel("针对所选内容提问")).toHaveCount(0);
  await expect(page.locator(".inline-capsule")).toHaveCount(2);
  expect(errors).toEqual([]);
});
