import { abortableOperation } from "./abortable-operation.js";
import { randomUUID } from "node:crypto";
import { sideQuestionFailure } from "./side-question-errors.js";
import type { SideFailure } from "@aimd/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { SideAskInputSchema, SideTaskChoiceSchema, SideTaskSelectionSchema, SideQuestionResultSchema } from "@aimd/contracts";
import type { createSideQuestionService } from "./side-question-service.js";
const callSchema = z.object({ operation: z.enum(["list", "select", "ask"]), arguments: z.unknown() }).strict();
const empty = z.object({}).strict();
const select = z.object({ handle: z.string().min(1).max(160) }).strict();
function send(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(JSON.stringify(body));
}
function allowed(request: IncomingMessage): boolean {
  try {
    const host = new URL("http://" + (request.headers.host ?? ""));
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host.hostname)) return false;
    if (request.headers["sec-fetch-site"] === "cross-site") return false;
    if (request.headers.origin === undefined) return true;
    const origin = new URL(request.headers.origin);
    return origin.protocol === "http:" && origin.host === host.host;
  } catch { return false; }
}
export function createSideQuestionApi(service: Pick<ReturnType<typeof createSideQuestionService>, "ask" | "listTasks" | "selectTask">, options: { onError?: (failure: SideFailure) => void; requestTimeoutMs?: number } = {}) {
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      if (request.url?.split("?", 1)[0] !== "/api/side") return false;
      const requestId = randomUUID(); const beganAt = Date.now(); let operation = "request";
      const fail = (status: number, error: unknown) => {
        const failure = sideQuestionFailure(error, requestId, beganAt, operation);
        try { options.onError?.(failure); } catch { /* Diagnostics cannot change the response. */ }
        send(response, status, { ok: false, error: failure });
      };
      if (!allowed(request)) { fail(403, new Error("SIDE_ORIGIN_FORBIDDEN")); return true; }
      if (request.method !== "POST") { fail(405, new Error("SIDE_METHOD_INVALID")); return true; }
      const abort = new AbortController();
      const disconnected = () => { if (!response.writableEnded) abort.abort(new Error("SIDE_CANCELLED")); };
      response.once("close", disconnected);
      const timeout = setTimeout(() => abort.abort(new Error("SIDE_TIMEOUT")), options.requestTimeoutMs ?? 180000);
      try {
        if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new Error("SIDE_REQUEST_INVALID");
        const chunks: Buffer[] = []; let size = 0;
        for await (const raw of request) {
          const chunk = Buffer.from(raw); size += chunk.byteLength;
          if (size > 65536) throw new Error("SIDE_REQUEST_INVALID");
          chunks.push(chunk);
        }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("SIDE_REQUEST_INVALID"); }
        const call = callSchema.parse(body); operation = call.operation;
        let data: unknown;
        if (call.operation === "list") {
          empty.parse(call.arguments);
          data = { tasks: z.array(SideTaskChoiceSchema).max(100).parse(await abortableOperation(abort.signal, () => service.listTasks(abort.signal))) };
        } else if (call.operation === "select") {
          data = { selection: SideTaskSelectionSchema.parse(await abortableOperation(abort.signal, () => service.selectTask(select.parse(call.arguments).handle, abort.signal))) };
        } else {
          data = { result: SideQuestionResultSchema.parse(await abortableOperation(abort.signal, () => service.ask(SideAskInputSchema.parse(call.arguments), abort.signal))) };
        }
        send(response, 200, { ok: true, data });
      } catch (error) {
        fail(200, error);
      } finally { clearTimeout(timeout); response.off("close", disconnected); }
      return true;
    },
  };
}
