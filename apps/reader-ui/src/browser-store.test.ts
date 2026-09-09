import { afterEach, expect, it, vi } from "vitest";
import { loadGraphHistory } from "./architecture-store.js";
import { loadCollection, saveCollection } from "./workbench-store.js";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture(value: unknown, aborted = false) {
  const transaction: any = { error: new Error("write aborted"), abort: vi.fn() };
  const operation = () => { const request: any = { result: value }; queueMicrotask(() => { request.onsuccess?.(); queueMicrotask(() => aborted ? transaction.onabort?.() : transaction.oncomplete?.()); }); return request; };
  transaction.objectStore = () => ({ get: operation, put: operation });
  const db: any = { close: vi.fn(), transaction: () => transaction, objectStoreNames: { contains: () => true } };
  const open: any = { result: db };
  vi.stubGlobal("indexedDB", { open: () => { queueMicrotask(() => open.onsuccess?.()); return open; } });
  return { db, open, transaction };
}
it("rejects corrupt architecture data through the promise and closes its connection", async () => {
  const { db } = fixture({ graphs: [], cursor: 0 });
  await expect(loadGraphHistory("project")).rejects.toThrow(); expect(db.close).toHaveBeenCalledOnce();
});
it("validates document collections before passing data to React", async () => {
  const { db } = fixture({ documents: "corrupt", architecture: [] });
  await expect(loadCollection("project")).rejects.toThrow(); expect(db.close).toHaveBeenCalledOnce();
});
it("does not treat a successful put as saved when the transaction aborts", async () => {
  const { db } = fixture(undefined, true);
  await expect(saveCollection("project", { documents: [], architecture: [] })).rejects.toThrow("write aborted"); expect(db.close).toHaveBeenCalledOnce();
});
it("bounds an open request that never responds and closes a late connection", async () => {
  vi.useFakeTimers(); const db = { close: vi.fn() }; const request: any = { result: db };
  vi.stubGlobal("indexedDB", { open: () => request });
  const check = expect(loadCollection("project")).rejects.toThrow("BROWSER_STORAGE_UNAVAILABLE");
  await vi.advanceTimersByTimeAsync(5001); await check; request.onsuccess(); expect(db.close).toHaveBeenCalledOnce();
});
it("fails promptly when another tab blocks a database upgrade", async () => {
  const request: any = {}; vi.stubGlobal("indexedDB", { open: () => { queueMicrotask(() => request.onblocked()); return request; } });
  await expect(loadCollection("project")).rejects.toThrow("BROWSER_STORAGE_UNAVAILABLE");
});
it("bounds a transaction that never completes", async () => {
  vi.useFakeTimers(); const transaction: any = { objectStore: () => ({ get: () => ({}) }), abort: vi.fn() }; const db: any = { close: vi.fn(), transaction: () => transaction };
  const request: any = { result: db }; vi.stubGlobal("indexedDB", { open: () => { queueMicrotask(() => request.onsuccess()); return request; } });
  const check = expect(loadCollection("project")).rejects.toThrow("BROWSER_STORAGE_UNAVAILABLE");
  await vi.advanceTimersByTimeAsync(5001); await check; expect(transaction.abort).toHaveBeenCalledOnce(); expect(db.close).toHaveBeenCalledOnce();
});
