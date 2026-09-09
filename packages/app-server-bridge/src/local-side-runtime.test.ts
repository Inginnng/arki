import { mkdtemp, realpath, rmdir } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bridge from "./index.js";
import { JsonlRpcClient, StdioJsonlTransport, type JsonlNotification, type SpawnedJsonlProcess } from "./jsonl.js";

const sourceId = "019abcde-1234-7777-aaaa-123456789abc";
const sourceTurn = "019abcde-5678-7777-aaaa-123456789abc";
const answer = { answer: "batch 37" };
class Rpc {
  listeners = new Set<(n: JsonlNotification) => void>();
  failures = new Set<(e: Error & { code: string }) => void>();
  calls: Array<{ method: string; params: any }> = [];
  rows: any[] = [];
  source: any;
  output = JSON.stringify(answer);
  unsafe = false;
  hold = false;
  startGate: Promise<void> | undefined;
  newThreadId = "side-thread";
  modelItems: any[] | undefined;
  itemsThroughNotifications = false;
  notify() {}
  onNotification(fn: (n: JsonlNotification) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  onFailure(fn: (e: Error & { code: string }) => void) { this.failures.add(fn); return () => { this.failures.delete(fn); }; }
  emit(method: string, params: unknown) { for (const fn of this.listeners) fn({ method, params }); }
  async close() {}
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === "initialize") return { userAgent: "codex/0.153.3" };
    if (method === "thread/list") return { data: this.rows, nextCursor: null };
    if (method === "thread/read") return { thread: structuredClone(this.source) };
    if (method === "thread/turns/list") {
      const turns = [...this.source.turns].reverse();
      const offset = params.cursor ? Number(params.cursor) : 0;
      const data = turns.slice(offset, offset + params.limit);
      return { data: structuredClone(data), nextCursor: offset + data.length < turns.length ? String(offset + data.length) : null };
    }
    if (method === "thread/start") { await this.startGate; return { thread: { id: this.newThreadId, ephemeral: true } }; }
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    if (method === "turn/start") {
      setTimeout(() => {
        if (this.hold) return;
        if (this.unsafe) this.emit("item/started", { threadId: "side-thread", turnId: "side-turn", item: { id: "tool", type: "commandExecution" } });
        this.emit("turn/completed", { threadId: "unrelated", turn: { id: "wrong", status: "failed" } });
        this.emit("turn/completed", { threadId: "side-thread", turn: { id: "wrong", status: "failed" } });
        const items = this.modelItems ?? [{ id: "reply", type: "agentMessage", text: this.output }];
        if (this.itemsThroughNotifications) for (const item of items) this.emit("item/completed", { threadId: "side-thread", turnId: "side-turn", item });
        this.emit("turn/completed", { threadId: "side-thread", turn: { id: "side-turn", status: "completed", items: this.itemsThroughNotifications ? [] : items } });
      }, 0);
      return { turn: { id: "side-turn" } };
    }
    return {};
  }
}

describe("LocalSideRuntime", () => {
  let root: string;
  let rpc: Rpc;
  let runtime: InstanceType<typeof bridge.LocalSideRuntime>;
  let now: number;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "aimd-side-test-")));
    rpc = new Rpc();
    now = Date.now();
    rpc.rows = [{ id: sourceId, cwd: root, name: `Task ${sourceId} ${root}`, updatedAt: 100 }];
    rpc.source = { ...rpc.rows[0], turns: [
      { id: sourceTurn, status: "completed", completedAt: 100, items: [
        { type: "userMessage", content: [{ type: "text", text: `Batch decision 37 at ${root}, task ${sourceId}.` }] },
        { type: "agentMessage", text: "Confirmed batch decision 37." },
        { type: "reasoning", text: "SECRET_REASONING" },
      ] },
      { id: "in-progress", status: "inProgress", items: [{ type: "agentMessage", text: "UNFINISHED_SECRET" }] },
    ] };
    expect(bridge.LocalSideRuntime).toBeTypeOf("function");
    runtime = new bridge.LocalSideRuntime({ executablePath: process.execPath, projectRoot: root, rpc, now: () => now });
  });
  afterEach(async () => { await runtime?.close(); if (root) await rmdir(root); vi.useRealTimers(); });
  const request = { question: "What is the batch decision?", developerInstructions: "Return requested JSON.", outputSchema: { type: "object" } };
  async function select() { const rows = await runtime.listTasks(); return runtime.selectTask(rows[0]!.handle); }

  it("recovers on the next operation after initialization fails", async () => {
    await runtime.close();
    const replacement = new Rpc(); replacement.rows = rpc.rows; replacement.source = rpc.source;
    const original = rpc.request.bind(rpc);
    vi.spyOn(rpc, "request").mockImplementation(async (method, params) => { if (method === "initialize") throw Error("temporary failure"); return original(method, params); });
    const factory = vi.fn(() => replacement);
    runtime = new bridge.LocalSideRuntime({ executablePath: process.execPath, projectRoot: root, rpc, rpcFactory: factory });
    await expect(runtime.listTasks()).rejects.toMatchObject({ code: "SIDE_RUNTIME_UNAVAILABLE" });
    await expect(runtime.listTasks()).resolves.toHaveLength(1);
    expect(factory).toHaveBeenCalledOnce();
  });
  it("reconnects after transport death while preserving the selected snapshot", async () => {
    await runtime.close();
    const replacement = new Rpc(); replacement.rows = rpc.rows; replacement.source = structuredClone(rpc.source);
    replacement.source.turns[0].items[0].content[0].text = "NEW_DISCUSSION_MUST_NOT_REPLACE_SNAPSHOT";
    runtime = new bridge.LocalSideRuntime({ executablePath: process.execPath, projectRoot: root, rpc, rpcFactory: () => replacement });
    const selected = await select();
    for (const listener of [...rpc.failures]) listener(Object.assign(Error("transport exited"), { code: "APP_SERVER_EXITED" }));
    await expect(runtime.run(selected.handle, request)).resolves.toEqual(answer);
    expect(JSON.stringify(replacement.calls.find(call => call.method === "turn/start")?.params)).not.toContain("NEW_DISCUSSION_MUST_NOT_REPLACE_SNAPSHOT");
    expect(replacement.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  });
  it("does not permanently close the runtime when disposable-thread cleanup fails", async () => {
    await runtime.close();
    const replacement = new Rpc(); replacement.rows = rpc.rows; replacement.source = rpc.source;
    const original = rpc.request.bind(rpc);
    vi.spyOn(rpc, "request").mockImplementation(async (method, params) => { if (method === "thread/unsubscribe") throw Error("cleanup failed"); return original(method, params); });
    runtime = new bridge.LocalSideRuntime({ executablePath: process.execPath, projectRoot: root, rpc, rpcFactory: () => replacement });
    const selected = await select(); await expect(runtime.run(selected.handle, request)).resolves.toEqual(answer);
    await expect(runtime.listTasks()).resolves.toHaveLength(1);
    await runtime.close(); await expect(runtime.listTasks()).rejects.toMatchObject({ code: "SIDE_RUNTIME_UNAVAILABLE" });
  });
  it("stops paging task history after cancellation and passes the signal to RPC", async () => {
    const rows = await runtime.listTasks(); const abort = new AbortController();
    const original = rpc.request.bind(rpc); let observedSignal: AbortSignal | undefined;
    vi.spyOn(rpc, "request").mockImplementation(async (method, params, options?: any) => {
      if (method === "thread/turns/list") { observedSignal = options?.signal; abort.abort(); return { data: [], nextCursor: "next-page" }; }
      return original(method, params);
    });
    await expect(runtime.selectTask(rows[0]!.handle, abort.signal)).rejects.toMatchObject({ code: "SIDE_CANCELLED" });
    expect(observedSignal).toBe(abort.signal);
  });
  it("lists only canonical project matches with opaque handles and safe titles", async () => {
    rpc.rows.push({ id: "other", cwd: tmpdir(), name: "Other", updatedAt: 101 });
    rpc.rows.push({ id: "ephemeral", cwd: root, name: "Temporary", updatedAt: 102, ephemeral: true });
    const rows = await runtime.listTasks();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(sourceId);
    expect(JSON.stringify(rows)).not.toContain(root);
    expect(rows[0]!.handle).not.toBe(sourceId);
    expect(rpc.calls.find(c => c.method === "thread/list")?.params.useStateDbOnly).toBe(true);
    expect(rpc.calls.find(c => c.method === "thread/list")?.params.cwd).toBe(root);
  });
  it("rejects forged handles and root changes on selection", async () => {
    await expect(runtime.selectTask(sourceId)).rejects.toMatchObject({ code: "SIDE_TASK_INVALID", message: "SIDE_TASK_INVALID" });
    const rows = await runtime.listTasks();
    rpc.source.cwd = tmpdir();
    await expect(runtime.selectTask(rows[0]!.handle)).rejects.toMatchObject({ code: "SIDE_TASK_INVALID" });
  });
  it("uses immutable completed discussion snapshot and never mutates source", async () => {
    const selected = await select();
    expect(selected.handle).not.toBe(sourceId);
    expect(selected.cutoffLabel).not.toContain(sourceTurn);
    rpc.source.turns[0].items[0].content[0].text = "CHANGED_AFTER_SELECTION";
    expect(await runtime.run(selected.handle, request)).toEqual(answer);
    const input = JSON.stringify(rpc.calls.find(c => c.method === "turn/start")?.params.input);
    expect(input).toContain("37");
    for (const secret of [sourceId, sourceTurn, root, "SECRET_REASONING", "UNFINISHED_SECRET", "CHANGED_AFTER_SELECTION"]) expect(input).not.toContain(secret);
    const start = rpc.calls.find(c => c.method === "thread/start")!.params;
    expect(start.ephemeral).toBe(true);
    expect(start.cwd).not.toBe(root);
    expect(start.config.features.shell_tool).toBe(false);
    expect(start.dynamicTools).toEqual([]);
    expect(rpc.calls.some(c => /fork|resume|inject|archive/u.test(c.method))).toBe(false);
    expect(rpc.calls.filter(c => c.params?.threadId === sourceId).every(c => ["thread/read", "thread/turns/list"].includes(c.method))).toBe(true);
    expect(rpc.calls.find(c => c.method === "thread/unsubscribe")?.params).toEqual({ threadId: "side-thread" });
  });
  it("rejects expired snapshots without silently refreshing", async () => {
    const selected = await select(); now += 30 * 60_000 + 1;
    await expect(runtime.run(selected.handle, request)).rejects.toMatchObject({ code: "SIDE_TASK_EXPIRED" });
    expect(rpc.calls.filter(c => c.method === "thread/read")).toHaveLength(1);
  });
  it("rejects an empty completed snapshot", async () => {
    rpc.source.turns = rpc.source.turns.slice(1);
    await expect(select()).rejects.toMatchObject({ code: "SIDE_TASK_EMPTY" });
  });
  it("bounds history and exposes truncation", async () => {
    rpc.source.turns[0].items[0].content[0].text = "large history ".repeat(6000);
    const selected = await select();
    expect(selected.historyTruncated).toBe(true);
    await runtime.run(selected.handle, request);
    expect(JSON.stringify(rpc.calls.find(c => c.method === "turn/start")!.params.input).length).toBeLessThan(27_000);
  });
  it.each([sourceId, (root: string) => root, "/home/private/secret.txt"])("rejects model output leaking private values: %s", async secret => {
    const selected = await select(); rpc.output = JSON.stringify({ answer: typeof secret === "function" ? secret(root) : secret });
    await expect(runtime.run(selected.handle, request)).rejects.toMatchObject({ code: "SIDE_OUTPUT_INVALID" });
  });
  it("rejects malformed JSON", async () => {
    const selected = await select(); rpc.output = "not JSON";
    await expect(runtime.run(selected.handle, request)).rejects.toMatchObject({ code: "SIDE_OUTPUT_INVALID" });
  });
  it("interrupts only its own turn on unknown tool events", async () => {
    const selected = await select(); rpc.unsafe = true;
    await expect(runtime.run(selected.handle, request)).rejects.toMatchObject({ code: "SIDE_TOOL_BLOCKED" });
    expect(rpc.calls.find(c => c.method === "turn/interrupt")?.params).toEqual({ threadId: "side-thread", turnId: "side-turn" });
  });
  it("handles abort and rejects simultaneous runs", async () => {
    const selected = await select(); rpc.hold = true;
    const controller = new AbortController();
    const running = runtime.run(selected.handle, request, controller.signal);
    const assertion = expect(running).rejects.toMatchObject({ code: "SIDE_CANCELLED" });
    await vi.waitFor(() => expect(rpc.calls.some(c => c.method === "turn/start")).toBe(true));
    await expect(runtime.run(selected.handle, request)).rejects.toMatchObject({ code: "SIDE_BUSY" });
    controller.abort(); await assertion;
    expect(rpc.calls.find(c => c.method === "turn/interrupt")?.params.threadId).toBe("side-thread");
    expect(rpc.listeners.size).toBe(0);
  });
  it("retains question-relevant older excerpts alongside latest history", async () => {
    rpc.source.turns[0].items = Array.from({ length: 24 }, (_, i) => ({
      type: "agentMessage", text: i === 0 ? "ORIGINAL_BATCH_DECISION 37 " + "detail ".repeat(140) : "unrelated latest discussion " + "color ".repeat(160),
    }));
    const selected = await select();
    await runtime.run(selected.handle, { ...request, question: JSON.stringify({ evidence: Array.from({ length: 100 }, (_, i) => `evidenceToken${i}`), question: "ORIGINAL_BATCH_DECISION", selectedText: "" }) });
    const packet = JSON.parse(rpc.calls.find(c => c.method === "turn/start")!.params.input[0].text);
    expect(packet.selectedTaskDiscussion.excerpts.join("\n")).toContain("ORIGINAL_BATCH_DECISION");
  });
  it("times out and interrupts its own turn without raw errors", async () => {
    const selected = await select(); rpc.hold = true;
    vi.useFakeTimers();
    const running = runtime.run(selected.handle, request);
    const assertion = expect(running).rejects.toMatchObject({ code: "SIDE_TIMEOUT", message: "SIDE_TIMEOUT" });
    await vi.waitFor(() => expect(rpc.calls.some(c => c.method === "turn/start")).toBe(true));
    await vi.advanceTimersByTimeAsync(120_001); await assertion;
    expect(rpc.calls.find(c => c.method === "turn/interrupt")?.params.turnId).toBe("side-turn");
  });
  it("preserves connection retries on timeout without exposing upstream text or foreign events", async () => {
    const selected = await select(); rpc.hold = true; vi.useFakeTimers();
    const running = runtime.run(selected.handle, request);
    const assertion = expect(running).rejects.toMatchObject({ code: "SIDE_TIMEOUT", diagnostic: { stage: "model", retryCount: 2, lastErrorCode: "CONNECTION_FAILED" } });
    await vi.waitFor(() => expect(rpc.calls.some(call => call.method === "turn/start")).toBe(true));
    const upstream = { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, message: "connection failed SECRET " + root };
    rpc.emit("error", { threadId: "foreign", turnId: "side-turn", willRetry: true, error: upstream });
    rpc.emit("error", { threadId: "side-thread", turnId: "foreign", willRetry: true, error: upstream });
    rpc.emit("error", { threadId: "side-thread", turnId: "side-turn", willRetry: true, error: upstream });
    rpc.emit("error", { threadId: "side-thread", willRetry: true, error: upstream });
    await vi.advanceTimersByTimeAsync(120_001); await assertion;
    const error = await running.catch(error => error);
    expect(JSON.stringify(error)).not.toContain("SECRET"); expect(JSON.stringify(error)).not.toContain(root);
    expect((error as { diagnostic: { elapsedMs: number } }).diagnostic.elapsedMs).toBeGreaterThanOrEqual(120_000);
  });
  it("caps the catalog at 100 opaque entries", async () => {
    rpc.rows = Array.from({ length: 150 }, (_, i) => ({ id: `source-${i}`, cwd: root, name: `Task ${i}`, updatedAt: i }));
    expect(await runtime.listTasks()).toHaveLength(100);
  });
  it("does not start a model turn after close during thread creation", async () => {
    const selected = await select();
    let release!: () => void;
    rpc.startGate = new Promise<void>(resolve => { release = resolve; });
    const running = runtime.run(selected.handle, request);
    const assertion = expect(running).rejects.toMatchObject({ code: "SIDE_CANCELLED" });
    await vi.waitFor(() => expect(rpc.calls.some(c => c.method === "thread/start")).toBe(true));
    await runtime.close(); release(); await assertion;
    expect(rpc.calls.some(c => c.method === "turn/start")).toBe(false);
  });
  it("permits endpoint and slash-command discussion in model JSON", async () => {
    const selected = await select(); rpc.output = JSON.stringify({ answer: "Use /api/reader and /btw." });
    await expect(runtime.run(selected.handle, request)).resolves.toEqual({ answer: "Use /api/reader and /btw." });
  });
  it("revalidates source project authority without refreshing history", async () => {
    const selected = await select(); rpc.source.cwd = tmpdir();
    await expect(runtime.run(selected.handle, request)).rejects.toMatchObject({ code: "SIDE_TASK_INVALID" });
    expect(rpc.calls.some(c => c.method === "thread/start")).toBe(false);
  });
  it("visibly marks partial App Server item history", async () => {
    rpc.source.turns[0].itemsView = "summary";
    expect((await select()).historyTruncated).toBe(true);
  });
  it("never mutates an old source even after catalog refresh and a forged start response", async () => {
    const selected = await select();
    rpc.rows = []; await runtime.listTasks(); rpc.newThreadId = sourceId;
    await expect(runtime.run(selected.handle, request)).rejects.toMatchObject({ code: "SIDE_MODEL_FAILED" });
    expect(rpc.calls.filter(c => c.params?.threadId === sourceId).every(c => ["thread/read", "thread/turns/list"].includes(c.method))).toBe(true);
  });
  it("refuses private-state growth beyond a bounded session budget", async () => {
    rpc.rows = [{ id: "x".repeat(262_145), cwd: root, name: "oversized identifier", updatedAt: 1 }];
    await expect(runtime.listTasks()).rejects.toMatchObject({ code: "SIDE_RUNTIME_UNAVAILABLE" });
  });
  it.each([false, true])("accepts final JSON after commentary (notifications=%s)", async notifications => {
    const selected = await select();
    rpc.itemsThroughNotifications = notifications;
    rpc.modelItems = [
      { id: "progress", type: "agentMessage", phase: "commentary", text: "正在整理依据。" },
      { id: "legacy-draft", type: "agentMessage", text: "Unphased intermediate text." },
      { id: "reply", type: "agentMessage", phase: "final_answer", text: JSON.stringify(answer) },
    ];
    await expect(runtime.run(selected.handle, request)).resolves.toEqual(answer);
  });
  it("selects bounded pages through the real JSONL transport when full history exceeds 1 MiB", async () => {
    await runtime.close();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const processEvents = new EventEmitter();
    const calls: Array<{ method: string; params: any }> = [];
    const hugeHistory = Array.from({ length: 12 }, (_, i) => ({
      id: "historic-" + i, status: "completed", completedAt: i + 1, itemsView: "full",
      items: [{ type: "commandExecution", aggregatedOutput: "x".repeat(110_000) },
        { type: "agentMessage", text: "Completed discussion " + i }],
    }));
    const allTurns = [...hugeHistory, { id: "latest-running", status: "inProgress", itemsView: "full",
      items: [{ type: "agentMessage", text: "DO_NOT_CAPTURE_RUNNING" }] }];
    expect(Buffer.byteLength(JSON.stringify(allTurns))).toBeGreaterThan(1_048_576);
    const child = {
      stdout, stderr,
      stdin: {
        on() {},
        end() {},
        write(chunk: string) {
          const frame = JSON.parse(chunk);
          if (!("id" in frame)) return true;
          calls.push(frame);
          let result: unknown;
          if (frame.method === "initialize") result = { userAgent: "codex/0.153.3" };
          else if (frame.method === "thread/list") result = { data: [{ id: sourceId, cwd: root, name: "Long task", updatedAt: 100 }], nextCursor: null };
          else if (frame.method === "thread/read") result = { thread: { id: sourceId, cwd: root, turns: frame.params.includeTurns ? allTurns : [] } };
          else if (frame.method === "thread/turns/list") {
            const offset = Number(frame.params.cursor ?? 0);
            const data = [...allTurns].reverse().slice(offset, offset + frame.params.limit).map(turn => ({
              ...turn, itemsView: "summary", items: turn.items.filter(item => item.type === "agentMessage"),
            }));
            result = { data, nextCursor: offset + data.length < allTurns.length ? String(offset + data.length) : null };
          } else throw new Error("Unexpected fixture request");
          // Exercise real framing, including its oversized single-line rejection.
          queueMicrotask(() => stdout.emit("data", JSON.stringify({ id: frame.id, result }) + "\n"));
          return true;
        },
      },
      on: processEvents.on.bind(processEvents),
      kill() { processEvents.emit("exit", 0, null); return true; },
    } as unknown as SpawnedJsonlProcess;
    const actualRpc = new JsonlRpcClient(new StdioJsonlTransport(child));
    runtime = new bridge.LocalSideRuntime({ executablePath: process.execPath, projectRoot: root, rpc: actualRpc });
    const listed = await runtime.listTasks();
    const selected = await runtime.selectTask(listed[0]!.handle);
    expect(selected.historyTruncated).toBe(true);
    expect(selected.cutoffLabel).toContain("1970-01-01T00:00:12");
    expect(calls.filter(call => call.method === "thread/read").every(call => call.params.includeTurns === false)).toBe(true);
    expect(calls.some(call => call.method === "thread/turns/list" && call.params.itemsView === "summary")).toBe(true);
    await expect(runtime.listTasks()).resolves.toHaveLength(1);
  });
  it("caps summary pagination and keeps a fixed cutoff after newer work completes", async () => {
    rpc.source.turns = Array.from({ length: 50 }, (_, i) => ({
      id: "completed-" + i, status: "completed", completedAt: i + 1, itemsView: "summary",
      items: [{ type: "agentMessage", text: "Past discussion " + i }],
    }));
    rpc.source.turns.push({ id: "newer-turn", status: "inProgress", completedAt: null,
      itemsView: "summary", items: [{ type: "agentMessage", text: "NEWER_COMPLETION_MUST_STAY_OUT" }] });
    const selected = await select();
    expect(selected.cutoffLabel).toContain("1970-01-01T00:00:50");
    expect(selected.historyTruncated).toBe(true);
    expect(rpc.calls.filter(call => call.method === "thread/turns/list")).toHaveLength(32);
    rpc.source.turns.at(-1).status = "completed";
    await runtime.run(selected.handle, request);
    const packet = JSON.parse(rpc.calls.find(call => call.method === "turn/start")!.params.input[0].text);
    expect(packet.selectedTaskDiscussion.excerpts.join("\n")).not.toContain("NEWER_COMPLETION_MUST_STAY_OUT");
    expect(packet.selectedTaskDiscussion.excerpts.join("\n")).toContain("Past discussion 49");
    expect(rpc.calls.filter(call => call.method === "thread/turns/list")).toHaveLength(32);
  });
});
