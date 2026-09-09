import { z } from "zod";
const handle = z.string().min(1).max(160).regex(/^[A-Za-z0-9._~-]+$/u);
const path = z.string().min(1).max(1024).refine(value => !value.startsWith("/") && !value.includes("\\") && !/^[A-Za-z]:/u.test(value) && value.split("/").every(part => part !== ".." && part !== "." && part !== ""));
const text = z.string().max(8192);
export const SideTaskChoiceSchema = z.object({ handle, title: z.string().max(240), updatedAt: z.number().finite() }).strict();
export const SideTaskSelectionSchema = z.object({ handle, title: z.string().max(240), cutoffLabel: z.string().max(240), historyTruncated: z.boolean() }).strict();
export const SideAskInputSchema = z.object({
  selectionHandle: handle, documentPath: path, documentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive(),
  question: z.string().trim().min(1).max(4096),
}).strict().refine(value => value.endOffset > value.startOffset);
export const SideModelAnswerSchema = z.object({
  concept: text,
  projectClaims: z.array(z.object({ statement: text.min(1), evidenceIds: z.array(handle).min(1).max(8) }).strict()).max(12),
  taskDiscussion: text,
  unknowns: z.array(text.min(1)).max(12),
}).strict();
export const SideEvidenceSchema = z.object({
  id: handle, path, startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  excerpt: z.string().max(16384), fileHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().refine(value => value.endLine >= value.startLine);
export const SideQuestionResultSchema = z.object({
  answer: SideModelAnswerSchema, evidence: z.array(SideEvidenceSchema).max(8),
  reviewStatus: z.literal("citation_validated"), retrievalTruncated: z.boolean(),
}).strict();
export type SideTaskChoice = z.infer<typeof SideTaskChoiceSchema>;
export type SideTaskSelection = z.infer<typeof SideTaskSelectionSchema>;
export type SideAskInput = z.infer<typeof SideAskInputSchema>;
export type SideQuestionResult = z.infer<typeof SideQuestionResultSchema>;
export const SideDiagnosticSchema = z.object({
  stage: z.enum(["request", "task_context", "evidence", "model_setup", "model"]),
  elapsedMs: z.number().int().nonnegative(), retryCount: z.number().int().nonnegative(),
  lastErrorCode: z.enum(["CONNECTION_FAILED", "STREAM_DISCONNECTED", "RATE_LIMIT", "AUTH_REQUIRED", "CONTEXT_LIMIT", "SERVICE_UNAVAILABLE", "MODEL_ERROR"]).optional(),
}).strict();
export const SideFailureSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u), message: z.string().max(1000), suggestion: z.string().max(1000),
  requestId: z.uuid(), diagnostic: SideDiagnosticSchema,
}).strict();
export type SideDiagnostic = z.infer<typeof SideDiagnosticSchema>;
export type SideFailure = z.infer<typeof SideFailureSchema>;
