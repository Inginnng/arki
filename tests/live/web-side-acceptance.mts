/** Opt-in real browser + real Codex acceptance. Creates and archives only its own synthetic task. */
import { randomBytes, createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "@playwright/test";
import { JsonlRpcClient, spawnStdioJsonlTransport } from "../../packages/app-server-bridge/src/jsonl.js";
const executable = process.argv[process.argv.indexOf("--codex") + 1];
if (!executable || !/^(?:[A-Za-z]:|\/)/u.test(executable)) throw new Error("EXPLICIT_CODEX_REQUIRED");
const baseUrl = process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1]! : "http://127.0.0.1:5180";
if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(baseUrl)) throw new Error("LOCAL_URL_REQUIRED");
const projectRoot = resolve(".");
const documentPath = "docs/project-introduction.zh-CN.md";
const title = "AIMD 网页验收 " + randomBytes(3).toString("hex");
const args = ["app-server", "--stdio", "--strict-config"];
for (const feature of ["shell_tool","apps","browser_use","computer_use","multi_agent","hooks","plugins","image_generation","sleep_tool","view_image"]) args.push("-c", "features." + feature + "=false");
args.push("-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"', "-c", 'web_search="disabled"');
const rpc = new JsonlRpcClient(spawnStdioJsonlTransport(executable, args));
let sourceId: string | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const request = (method: string, params: unknown) => rpc.request(method, params, { timeoutMs: 30000 }) as Promise<any>;
const emit = (data: unknown) => process.stdout.write(JSON.stringify(data) + "\n");
try {
  await request("initialize", { clientInfo: { name: "aimd-web-acceptance", version: "0.1.0" }, capabilities: { experimentalApi: true } }); rpc.notify("initialized");
  const source = await request("thread/start", { cwd: projectRoot, approvalPolicy: "never", sandbox: "read-only", ephemeral: false,
    config: { web_search: "disabled", features: { shell_tool: false, apps: false, browser_use: false, computer_use: false, multi_agent: false, plugins: false, hooks: false } },
    developerInstructions: "This is a non-sensitive acceptance fixture. Never call tools. Reply only the requested JSON." });
  sourceId = source.thread.id;
  await request("thread/name/set", { threadId: sourceId, name: title });
  let resolveSeed!: () => void; let rejectSeed!: (error: Error) => void;
  const seed = new Promise<void>((yes, no) => { resolveSeed = yes; rejectSeed = no; });
  void seed.catch(() => undefined);
  const timer = setTimeout(() => rejectSeed(new Error("FIXTURE_TIMEOUT")), 90000);
  const unsubscribe = rpc.onNotification(({ method, params }: any) => {
    if (params?.threadId !== sourceId) return;
    if (method === "item/started" && !["userMessage","agentMessage","reasoning","plan"].includes(params.item?.type)) rejectSeed(new Error("FIXTURE_TOOL_BLOCKED"));
    if (method === "turn/completed") params.turn.status === "completed" ? resolveSeed() : rejectSeed(new Error("FIXTURE_MODEL_FAILED"));
  });
  try {
    await request("turn/start", { threadId: sourceId, input: [{ type: "text", text: "这是网页验收的测试讨论：曾经计划批次为37，最新决定改成25，因为下游上限改为28并预留3条。数据库类型尚未决定。只回复JSON：{\"ok\":true}。", text_elements: [] }],
      approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } });
    await seed;
  } finally { clearTimeout(timer); unsubscribe(); }
  emit({ stage: "fixture_ready", realModel: true });
  const before = createHash("sha256").update(await readFile(join(projectRoot, documentPath))).digest("hex");
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: "zh-CN" });
  const errors: string[] = [];
  page.on("pageerror", () => errors.push("PAGE_ERROR"));
  await page.goto(baseUrl + "/web.html");
  await page.getByRole("option", { name: title, exact: true }).waitFor({ timeout: 45000 });
  await page.getByLabel("选择 Codex 任务").selectOption({ label: title });
  await page.locator(".inline-context-details").waitFor({ timeout: 45000 });
  await page.getByRole("navigation", { name: "项目文档" }).getByRole("button").filter({ hasText: documentPath }).click();
  const paragraph = page.locator(".markdown-paper p").filter({ hasText: "MCP 的全称是" }).first();
  await paragraph.waitFor({ timeout: 30000 });
  await paragraph.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const index = (node.textContent ?? "").indexOf("MCP");
      if (index < 0) continue;
      const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 3);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); return;
    }
    throw new Error("MCP_SELECTION_MISSING");
  });
  const question = "MCP 是什么？结合当前项目说明，并根据所选任务说明最新批次及原因；数据库决定了吗？";
  await page.getByLabel("针对所选内容提问").waitFor();
  await page.getByLabel("针对所选内容提问").fill(question);
  const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/side") && response.request().postDataJSON()?.operation === "ask", { timeout: 150000 });
  await page.getByRole("button", { name: "提交问题", exact: true }).click();
  const response = await responsePromise; const body = await response.json();
  if (!body.ok) { emit({ stage: "web_question_failed", code: body.error?.code }); throw new Error("WEB_QUESTION_FAILED"); }
  const result = body.data.result;
  if (!/模型上下文|Model Context Protocol/iu.test(result.answer.concept)) throw new Error("CONCEPT_MISSING");
  if (!/25/u.test(result.answer.taskDiscussion) || !/28/u.test(result.answer.taskDiscussion)) throw new Error("LATEST_DECISION_MISSING");
  if (!/未|不确定|未知/u.test(result.answer.taskDiscussion + result.answer.unknowns.join(" "))) throw new Error("UNKNOWN_MISSING");
  await page.getByRole("button", { name: /MCP.*1.*解释/ }).click();
  await page.locator(".inline-answer").waitFor();
  const screenshotDir = resolve(".tmp/side-web-acceptance"); await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, "desktop.png"), fullPage: false });
  const sourceLink = page.locator(".inline-answer .inline-source-link").first(); await sourceLink.click();
  await page.getByRole("dialog", { name: "证据来源" }).waitFor();
  await page.getByRole("button", { name: "关闭证据来源" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".inline-toolbar").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshotDir, "mobile.png"), fullPage: false });
  const after = createHash("sha256").update(await readFile(join(projectRoot, documentPath))).digest("hex");
  if (after !== before) throw new Error("SOURCE_MUTATED");
  if (errors.length) throw new Error("BROWSER_ERROR");
  emit({ stage: "web_acceptance", status: "passed", realModel: true, documentPath, sourceUnchanged: true, browserErrors: errors.length,
    answer: result.answer, evidence: result.evidence.map((e: any) => ({ id: e.id, path: e.path, startLine: e.startLine, endLine: e.endLine })), retrievalTruncated: result.retrievalTruncated });
} catch (error) {
  emit({ stage: "failed", code: error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : "ACCEPTANCE_FAILED" });
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (sourceId) await request("thread/archive", { threadId: sourceId }).then(() => emit({ cleanup: "fixture_archived" }), () => emit({ cleanup: "fixture_archive_failed" }));
  await rpc.close();
}
