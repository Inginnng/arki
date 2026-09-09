import { createReaderHost, ReaderHostError, type ReaderAppPort, type ReaderHost } from "./host.js";

type HttpReaderHostOptions = {
  fetch?: typeof globalThis.fetch;
  healthUrl?: string;
  readerUrl?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createHttpReaderPort(options: HttpReaderHostOptions): ReaderAppPort {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const healthUrl = options.healthUrl ?? "/api/health";
  const readerUrl = options.readerUrl ?? "/api/reader";

  return {
    connect: async () => {
      try {
        const response = await fetcher(healthUrl, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) throw new Error("health response was not successful");
        const body: unknown = await response.json();
        if (!isRecord(body) || body.ok !== true) throw new Error("health response was invalid");
      } catch {
        throw new ReaderHostError("LOCAL_BACKEND_UNAVAILABLE");
      }
    },
    requestDisplayMode: async ({ mode }) => ({ mode }),
    callServerTool: async ({ name, arguments: input }) => {
      const response = await fetcher(readerUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, arguments: input }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error("reader response was not successful");
      const body: unknown = await response.json();
      if (!isRecord(body) || !("structuredContent" in body)) throw new Error("reader response was invalid");
      return {
        ...(body.isError === true ? { isError: true } : {}),
        content: Array.isArray(body.content) ? body.content : [],
        structuredContent: body.structuredContent,
      };
    },
  };
}

export function createHttpReaderHost(options: HttpReaderHostOptions = {}): ReaderHost {
  return createReaderHost(createHttpReaderPort(options));
}
