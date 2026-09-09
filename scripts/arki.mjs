import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, openSync, closeSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function projectKey(root) { return createHash("sha256").update("aimd-web-collection-v1\0").update(root).digest("hex"); }
export async function inspectBackend(port, key) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    const body = await response.json();
    return response.ok && body.ok === true && body.product === "arki" && body.projectKey === key ? body : null;
  } catch { return null; }
}
function available(port) {
  return new Promise(resolveAvailable => {
    const server = createServer(); server.once("error", () => resolveAvailable(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveAvailable(true)));
  });
}
function options(argv) {
  const result = { root: process.cwd(), open: false, serve: false, analyze: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--root" || arg === "--port") { const value = argv[++i]; if (!value || value.startsWith("--")) throw Error(`Missing ${arg}`); result[arg.slice(2)] = arg === "--port" ? Number(value) : value; }
    else if (arg === "--open") result.open = true;
    else if (arg === "--serve") result.serve = true;
    else if (arg === "--analyze") result.analyze = true;
    else throw Error(`Unknown argument: ${arg}`);
  }
  if (result.port !== undefined && (!Number.isInteger(result.port) || result.port < 1024 || result.port > 65535)) throw Error("Invalid port");
  return result;
}
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
async function supervise(serverPath, root, port) {
  let closing = false; let child;
  const stop = () => { closing = true; child?.kill(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  // Restart transient crashes, but stop a persistent startup failure instead of looping forever.
  let failures = 0;
  while (!closing && failures < 3) {
    const started = Date.now();
    const code = await new Promise(resolveExit => {
      child = spawn(process.execPath, [serverPath, "--root", root, "--port", String(port)], { windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
      child.once("error", () => resolveExit(1)); child.once("exit", code => resolveExit(code ?? 1));
    });
    if (closing || code === 0) break;
    failures = Date.now() - started > 60000 ? 1 : failures + 1;
    if (failures < 3) { process.stderr.write(`[arki] Backend exited; retry ${failures}/2.\n`); await pause(1000 * failures); }
  }
}
export async function startArki(input) {
  const root = await realpath(resolve(input.root));
  if (!(await stat(root)).isDirectory()) throw Error("Project root must be a directory");
  const key = projectKey(root);
  const location = dirname(fileURLToPath(import.meta.url));
  const serverPath = existsSync(join(location, "web-server.mjs")) ? join(location, "web-server.mjs") : resolve(location, "../plugins/aimd-reader/dist/web-server.mjs");
  if (!existsSync(serverPath)) throw Error("Arki 尚未构建。请先在安装目录运行 pnpm build。");
  if (input.serve) { await supervise(serverPath, root, input.port); return; }
  const runtime = join(tmpdir(), "arki-web", key); await mkdir(runtime, { recursive: true });
  const record = join(runtime, "backend.json"); let previous;
  try { const saved = JSON.parse(await readFile(record, "utf8")); if (Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535) previous = saved.port; } catch { /* First start or lost runtime metadata. */ }
  const fallback = 5200 + Number.parseInt(key.slice(0, 4), 16) % 20000;
  const candidates = input.port ? [input.port] : [...new Set([previous, 5173, ...Array.from({ length: 8 }, (_, i) => fallback + i)].filter(Boolean))];
  let port; let reused = false;
  for (const candidate of candidates) {
    if (await inspectBackend(candidate, key)) { port = candidate; reused = true; break; }
    if (await available(candidate)) { port = candidate; break; }
  }
  if (!port) throw Error("可用端口已被占用；未停止或替换其他项目的服务。");
  let supervisorPid;
  if (!reused) {
    const output = openSync(join(runtime, "backend.log"), "a"); const error = openSync(join(runtime, "backend-error.log"), "a");
    let child;
    try {
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--serve", "--root", root, "--port", String(port)], { detached: true, windowsHide: true, stdio: ["ignore", output, error] });
      await new Promise((resolveSpawn, rejectSpawn) => { child.once("spawn", resolveSpawn); child.once("error", rejectSpawn); });
      supervisorPid = child.pid; child.unref();
    } finally { closeSync(output); closeSync(error); }
    const deadline = Date.now() + 30000;
    while (!await inspectBackend(port, key)) {
      if (Date.now() >= deadline) throw Error(`后台未能启动，请检查 ${join(runtime, "backend-error.log")}`);
      await pause(300);
    }
  }
  const temporary = record + `.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ port }), "utf8"); await rename(temporary, record);
  const url = `http://127.0.0.1:${port}/web.html${input.analyze ? "#analyze" : ""}`;
  if (input.open) {
    const child = process.platform === "win32" ? execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:ARKI_OPEN_URL"], { windowsHide: true, env: { ...process.env, ARKI_OPEN_URL: url } }) : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
    child.on("error", () => process.stderr.write("请在浏览器打开输出的 URL。\n")); child.unref();
  }
  return { url, projectKey: key, reused, ...(supervisorPid ? { supervisorPid } : {}) };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const result = await startArki(options(process.argv.slice(2))); if (result) process.stdout.write(JSON.stringify(result) + "\n"); }
  catch (error) { process.stderr.write(`[arki] ${error instanceof Error ? error.message : "启动失败"}\n`); process.exitCode = 1; }
}
