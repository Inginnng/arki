import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  DispositionSchema,
  OpaqueIdSchema,
  RelativePathSchema,
  Sha256DigestSchema,
} from "@aimd/contracts";
import { z } from "zod";

import type { ReaderMcpService } from "./mcp.js";

const MAX_HTTP_BODY_BYTES = 64 * 1_024;
const TOOL_NAMES = [
  "aimd_list_roots",
  "aimd_list_documents",
  "aimd_read_document",
  "aimd_read_source",
  "aimd_create_session",
  "aimd_ask_start",
  "aimd_question_events",
  "aimd_cancel_question",
  "aimd_set_disposition",
  "aimd_prepare_patch",
  "aimd_approve_patch",
  "aimd_write_explained",
] as const;

const ToolCallSchema = z.object({
  name: z.enum(TOOL_NAMES),
  arguments: z.unknown(),
}).strict();
const EmptySchema = z.object({}).strict();
const RootSchema = z.object({ rootId: OpaqueIdSchema }).strict();
const PathSchema = RootSchema.extend({ path: RelativePathSchema }).strict();
const SourceSchema = PathSchema.extend({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).strict().refine((value) => value.endLine >= value.startLine);
const SessionSchema = z.object({ sessionId: OpaqueIdSchema }).strict();
const AskSchema = SessionSchema.extend({
  question: z.object({
    question: z.string().min(1).max(16_384).refine((value) => value.trim().length > 0),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
  }).strict().refine((value) => value.endOffset > value.startOffset),
}).strict();
const PollSchema = z.object({
  runId: OpaqueIdSchema,
  cursor: z.object({
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema,
    sequence: z.number().int().positive(),
  }).strict().optional(),
}).strict().refine((value) => value.cursor === undefined || value.cursor.runId === value.runId);
const RunSchema = z.object({ runId: OpaqueIdSchema }).strict();
const DispositionInputSchema = z.object({
  annotationId: OpaqueIdSchema,
  disposition: DispositionSchema,
}).strict();
const PrepareSchema = SessionSchema.extend({
  annotationIds: z.array(OpaqueIdSchema).min(1).max(256).refine((ids) => new Set(ids).size === ids.length),
}).strict();
const ApproveSchema = SessionSchema.extend({
  sourceHash: Sha256DigestSchema,
  diffHash: Sha256DigestSchema,
}).strict();
const WriteSchema = SessionSchema.extend({
  previewId: OpaqueIdSchema,
  approvalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();

const SAFE_ERROR_CODES = new Set([
  "ROOT_NOT_FOUND",
  "DOCUMENT_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "RUN_NOT_FOUND",
  "RUN_CAPACITY_EXCEEDED",
  "CURSOR_GAP",
  "CURSOR_INVALID",
  "EVENT_REPLAY_MISMATCH",
  "RUN_TERMINAL",
  "ANCHOR_STALE",
  "QUESTION_FAILED",
  "ANNOTATION_NOT_FOUND",
  "ANNOTATION_NOT_ACCEPTED",
  "PATCH_NOT_FOUND",
  "PATCH_NOT_APPROVABLE",
  "APPROVAL_INVALID",
  "SOURCE_CHANGED",
  "OUTPUT_ALREADY_EXISTS",
  "SAFE_WRITE_UNAVAILABLE",
  "SERVER_RESTARTED",
  "SERVICE_CLOSED",
  "ROOT_AUTHORIZATION_REVOKED",
]);

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  }).end(body);
}

function fixedFailure(code: string) {
  return {
    isError: true,
    content: [{ type: "text", text: "AIMD Reader operation failed safely." }],
    structuredContent: {
      error: {
        code,
        message: "AIMD Reader operation failed safely.",
      },
    },
  };
}

function errorCode(error: unknown): string {
  if (error instanceof z.ZodError) return "REQUEST_INVALID";
  if (typeof error === "object" && error !== null) {
    const value = Reflect.get(error, "code");
    if (typeof value === "string" && SAFE_ERROR_CODES.has(value)) return value;
  }
  return "READER_OPERATION_FAILED";
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw Object.assign(new Error("CONTENT_TYPE_REQUIRED"), { code: "REQUEST_INVALID" });
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > MAX_HTTP_BODY_BYTES) throw Object.assign(new Error("BODY_TOO_LARGE"), { code: "REQUEST_INVALID" });
    chunks.push(chunk);
  }
  if (bytes === 0) throw Object.assign(new Error("BODY_REQUIRED"), { code: "REQUEST_INVALID" });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON_INVALID"), { code: "REQUEST_INVALID" });
  }
}

function sameBrowserOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  const host = request.headers.host;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

type LocalWebReaderApiOptions = Readonly<{
  projectRoot: string;
  service: ReaderMcpService;
}>;

export function createLocalWebReaderApi(options: LocalWebReaderApiOptions) {
  const authorizedRoots = Object.freeze([{ uri: pathToFileURL(options.projectRoot).href }]);

  const authorize = async (kind: "session" | "run" | "annotation" | "preview", id: string) => {
    await options.service.authorizeAccess({ kind, id }, authorizedRoots);
  };

  const dispatch = async (raw: unknown) => {
    const call = ToolCallSchema.parse(raw);
    let structuredContent: Record<string, unknown>;
    switch (call.name) {
      case "aimd_list_roots": {
        EmptySchema.parse(call.arguments);
        const roots = z.array(z.object({ rootId: OpaqueIdSchema, workspaceLabel: z.string() }).strict()).parse(await options.service.listRoots(authorizedRoots));
        const storageKey = createHash("sha256").update("aimd-web-collection-v1\0").update(options.projectRoot).digest("hex");
        structuredContent = { roots: roots.map(root => ({ ...root, storageKey })) };
        break;
      }
      case "aimd_list_documents": {
        const input = RootSchema.parse(call.arguments);
        structuredContent = { documents: await options.service.listDocuments(input.rootId) };
        break;
      }
      case "aimd_read_document": {
        const input = PathSchema.parse(call.arguments);
        structuredContent = { document: await options.service.openDocument(input.rootId, input.path) };
        break;
      }
      case "aimd_read_source": {
        const input = SourceSchema.parse(call.arguments);
        structuredContent = { source: await options.service.readSource(input.rootId, input.path, input.startLine, input.endLine) };
        break;
      }
      case "aimd_create_session": {
        const input = PathSchema.parse(call.arguments);
        const binding = options.service.captureSessionBinding(undefined);
        structuredContent = { session: await options.service.createSessionFromBinding(input.rootId, input.path, binding) };
        break;
      }
      case "aimd_ask_start": {
        const input = AskSchema.parse(call.arguments);
        await authorize("session", input.sessionId);
        structuredContent = { job: await options.service.startQuestion(input.sessionId, input.question) };
        break;
      }
      case "aimd_question_events": {
        const input = PollSchema.parse(call.arguments);
        await authorize("run", input.runId);
        structuredContent = { page: await options.service.pollQuestion(input.runId, input.cursor) };
        break;
      }
      case "aimd_cancel_question": {
        const input = RunSchema.parse(call.arguments);
        await authorize("run", input.runId);
        await options.service.cancelQuestion(input.runId);
        structuredContent = { status: "cancelled" };
        break;
      }
      case "aimd_set_disposition": {
        const input = DispositionInputSchema.parse(call.arguments);
        await authorize("annotation", input.annotationId);
        await options.service.setDisposition(input.annotationId, input.disposition);
        structuredContent = { status: "updated" };
        break;
      }
      case "aimd_prepare_patch": {
        const input = PrepareSchema.parse(call.arguments);
        await authorize("session", input.sessionId);
        structuredContent = { preview: await options.service.preparePatch(input.sessionId, input.annotationIds) };
        break;
      }
      case "aimd_approve_patch": {
        const input = ApproveSchema.parse(call.arguments);
        await authorize("session", input.sessionId);
        structuredContent = { approval: await options.service.approvePatch(input.sessionId, input.sourceHash, input.diffHash) };
        break;
      }
      case "aimd_write_explained": {
        const input = WriteSchema.parse(call.arguments);
        await Promise.all([
          authorize("session", input.sessionId),
          authorize("preview", input.previewId),
        ]);
        structuredContent = { result: await options.service.writeExplained(input.sessionId, input.previewId, input.approvalToken) };
        break;
      }
    }
    return {
      content: [{ type: "text", text: "AIMD Reader operation completed." }],
      structuredContent,
    };
  };

  return {
    dispatch,
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/api/health") {
        if (request.method !== "GET") {
          writeJson(response, 405, fixedFailure("METHOD_NOT_ALLOWED"));
          return true;
        }
        writeJson(response, 200, {
          ok: true,
          backend: "codex-cli",
          contextMode: "project_only",
          reviewCapability: "citation_validated",
        });
        return true;
      }
      if (pathname !== "/api/reader") return false;
      if (request.method !== "POST") {
        writeJson(response, 405, fixedFailure("METHOD_NOT_ALLOWED"));
        return true;
      }
      if (!sameBrowserOrigin(request)) {
        writeJson(response, 403, fixedFailure("ORIGIN_FORBIDDEN"));
        return true;
      }
      try {
        writeJson(response, 200, await dispatch(await readJsonBody(request)));
      } catch (error) {
        writeJson(response, 200, fixedFailure(errorCode(error)));
      }
      return true;
    },
  };
}
