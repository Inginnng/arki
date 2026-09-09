import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReaderHost } from "./host.js";
import { useProjectConnection } from "./project-connection.js";
afterEach(() => { cleanup(); localStorage.clear(); });
it("restores a cached project offline and replaces expired root IDs when the backend returns", async () => {
  const saved = { rootId: "root-before", workspaceLabel: "Project", storageKey: "a".repeat(64) };
  localStorage.setItem("arki-project", JSON.stringify(saved));
  let online = false;
  const connect = vi.fn(async () => { if (!online) throw Error("offline"); });
  const host = { connect, call: vi.fn(async (name: string) => name === "aimd_list_roots" ? { roots: [{ ...saved, rootId: "root-after" }] } : { documents: [] }) } as unknown as ReaderHost;
  const { result } = renderHook(() => useProjectConnection(host));
  expect(result.current.root).toEqual(saved);
  await waitFor(() => expect(result.current.status).toBe("offline"));
  online = true; act(() => result.current.reconnect());
  await waitFor(() => expect(result.current.status).toBe("online"));
  expect(result.current.root?.rootId).toBe("root-after"); expect(result.current.revision).toBe(1);
  act(() => result.current.reconnect());
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
  expect(result.current.revision).toBe(1);
});
it("ignores corrupt cached identities and discards a late connection after unmount", async () => {
  localStorage.setItem("arki-project", '{"workspaceLabel":"untrusted"}');
  let finish!: () => void;
  const host = { connect: () => new Promise<void>(resolve => { finish = resolve; }), call: vi.fn(async () => ({ roots: [] })) } as unknown as ReaderHost;
  const { result, unmount } = renderHook(() => useProjectConnection(host));
  expect(result.current.root).toBeNull(); unmount(); await act(async () => finish());
  expect(localStorage.getItem("arki-project")).toBe('{"workspaceLabel":"untrusted"}');
});
