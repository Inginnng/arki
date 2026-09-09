import { browserStore } from "./browser-store.js";
import { z } from "zod";
import { ArchitectureGraphSchema, ArchitectureViewSchema, ArchitectureEvidenceSchema } from "@aimd/contracts";
export const ConversationSchema = z.object({ question: z.string().max(3000), answer: z.string().max(6000), limitations: z.array(z.string().max(500)).max(6), evidence: z.array(ArchitectureEvidenceSchema).max(24), version: z.number().int().positive(), createdAt: z.string().datetime() }).strict();
export type ArchitectureConversation = z.infer<typeof ConversationSchema>;
export const HistorySchema = z.object({ graphs: z.array(ArchitectureGraphSchema).min(1).max(20), cursor: z.number().int().min(0).max(19), view: ArchitectureViewSchema.optional(), conversations: z.array(ConversationSchema).max(20).optional() }).refine(value => value.cursor < value.graphs.length).refine(value => !value.view || JSON.stringify(value.view.graph) === JSON.stringify(value.graphs[value.cursor]));
export type GraphHistory = z.infer<typeof HistorySchema>;
export async function loadGraphHistory(key: string): Promise<GraphHistory | null> {
  return browserStore("aimd-architecture", "graphs", "readonly", store => store.get(key), value => value === undefined ? null : HistorySchema.parse(value));
}
export async function saveGraphHistory(key: string, history: GraphHistory): Promise<void> {
  const value = HistorySchema.parse(history);
  await browserStore("aimd-architecture", "graphs", "readwrite", store => store.put(value, key), () => undefined);
}
