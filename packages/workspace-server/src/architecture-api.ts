import { abortableOperation } from "./abortable-operation.js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ArchitectureGraphSchema, ArchitectureTargetSchema, ArchitectureEditScopeSchema, ArchitectureFailureSchema, type ArchitectureFailure } from "@aimd/contracts";
import type { createArchitectureService } from "./architecture-service.js";
import { ArchitectureError, architectureFailure } from "./architecture-errors.js";
const input = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("open"), graph: ArchitectureGraphSchema.optional() }).strict(),
  z.object({ operation: z.literal("export"), graph: ArchitectureGraphSchema }).strict(),
  z.object({ operation: z.literal("ask"), graph: ArchitectureGraphSchema, target: ArchitectureTargetSchema, question: z.string().trim().min(1).max(3000), scope: ArchitectureEditScopeSchema.optional(), intent: z.enum(["edit", "explain", "analyze"]).optional(), conversation: z.array(z.object({ question: z.string().max(3000), answer: z.string().max(6000) }).strict()).max(6).optional() }).strict(),
]);
export function createArchitectureApi(service: ReturnType<typeof createArchitectureService>, options: { onError?: (failure: ArchitectureFailure) => void; requestTimeoutMs?: number; projectKey?: string } = {}) {
  return { async handle(request: IncomingMessage, response: ServerResponse) {
    if (request.url?.split("?", 1)[0] !== "/api/architecture") return false;
    const requestId = randomUUID();
    const send = (status: number, body: unknown) => { if (!response.destroyed && !response.writableEnded) response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(JSON.stringify(body)); };
    const fail = (status: number, error: unknown) => {
      const failure = ArchitectureFailureSchema.parse(architectureFailure(error, requestId));
      // Log exactly the safe public diagnostic, never prompts, raw model output or stacks.
      try { options.onError?.(failure); } catch { /* Logging cannot change the response. */ }
      send(status, { ok: false, error: failure });
    };
    try {
      const host = new URL("http://" + (request.headers.host ?? ""));
      if (!["127.0.0.1", "localhost", "[::1]"].includes(host.hostname) || request.headers["sec-fetch-site"] === "cross-site" || (request.headers.origin && request.headers.origin !== host.origin)) throw new Error();
    } catch { fail(403, new ArchitectureError("ARCHITECTURE_ORIGIN_FORBIDDEN")); return true; }
    if (options.projectKey && request.headers["x-arki-project"] !== options.projectKey) { fail(409, new ArchitectureError("ARCHITECTURE_PROJECT_CHANGED")); return true; }
    if (request.method !== "POST") { fail(405, new ArchitectureError("ARCHITECTURE_METHOD_INVALID")); return true; }
    const controller = new AbortController();
    const disconnected = () => { if (!response.writableEnded) controller.abort(new ArchitectureError("ARCHITECTURE_CANCELLED")); };
    response.once("close", disconnected);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(new ArchitectureError("ARCHITECTURE_TIMEOUT")); }, options.requestTimeoutMs ?? 240000);
    try {
      if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new ArchitectureError("ARCHITECTURE_REQUEST_INVALID", [{ code: "CONTENT_TYPE", message: "请求内容必须为 application/json。" }]);
      let size = 0; const chunks: Buffer[] = [];
      for await (const raw of request) { const chunk = Buffer.from(raw); size += chunk.byteLength; if (size > 512000) throw new ArchitectureError("ARCHITECTURE_REQUEST_INVALID", [{ code: "BODY_LIMIT", message: "请求体超过 512000 字节限制。" }]); chunks.push(chunk); }
      const call = input.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const data = await abortableOperation(controller.signal, async () => call.operation === "open" ? await service.open(call.graph, controller.signal) : call.operation === "export" ? { html: await service.export(call.graph, controller.signal) } : await service.ask({ ...call, scope: call.scope ?? "related", intent: call.intent ?? "edit", conversation: call.conversation ?? [] }, controller.signal));
      send(200, { ok: true, data });
    } catch (error) { fail(200, timedOut ? new ArchitectureError("ARCHITECTURE_TIMEOUT") : error); }
    finally { clearTimeout(timeout); response.off("close", disconnected); }
    return true;
  } };
}
