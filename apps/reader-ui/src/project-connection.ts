import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { ReaderDocumentSummary, ReaderHost, ReaderRoot } from "./host.js";

const RootCache = z.object({ rootId: z.string().min(1).max(200), workspaceLabel: z.string().min(1).max(300), storageKey: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
function cachedRoot(): ReaderRoot | null {
  try { return RootCache.parse(JSON.parse(localStorage.getItem("arki-project") ?? "null")); } catch { return null; }
}
export function useProjectConnection(host: ReaderHost) {
  const [root, setRoot] = useState<ReaderRoot | null>(cachedRoot);
  const [catalog, setCatalog] = useState<ReaderDocumentSummary[]>([]);
  const [status, setStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [revision, setRevision] = useState(0);
  const retry = useRef<() => void>(() => undefined);
  const reconnect = useCallback(() => retry.current(), []);
  useEffect(() => {
    let live = true; let running = false; let timer: ReturnType<typeof setTimeout> | undefined;
    let lastRootId = ""; let connected = false;
    const connect = async () => {
      if (!live || running) return;
      running = true; clearTimeout(timer);
      try {
        await host.connect();
        if (!live) return;
        const { roots } = await host.call<{ roots: ReaderRoot[] }>("aimd_list_roots", {});
        const next = roots[0]; if (!next) throw Error("PROJECT_UNAVAILABLE");
        const { documents } = await host.call<{ documents: ReaderDocumentSummary[] }>("aimd_list_documents", { rootId: next.rootId });
        if (!live) return;
        setRoot(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        setCatalog(documents); setStatus("online");
        if (!connected || next.rootId !== lastRootId) setRevision(value => value + 1);
        connected = true; lastRootId = next.rootId;
        try { if (next.storageKey) localStorage.setItem("arki-project", JSON.stringify(next)); } catch { /* In-memory use remains available. */ }
      } catch { if (live) { connected = false; setStatus("offline"); } }
      finally { running = false; if (live) timer = setTimeout(() => void connect(), connected ? 20000 : 5000); }
    };
    retry.current = () => void connect();
    const visible = () => { if (document.visibilityState === "visible") void connect(); };
    window.addEventListener("online", retry.current); document.addEventListener("visibilitychange", visible);
    void connect();
    return () => { live = false; clearTimeout(timer); window.removeEventListener("online", retry.current); document.removeEventListener("visibilitychange", visible); };
  }, [host]);
  return { root, catalog, status, revision, reconnect };
}
