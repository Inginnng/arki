import { z } from "zod";
import { browserStore } from "./browser-store.js";
const entry = z.object({ id: z.string(), title: z.string(), path: z.string(), markdown: z.string().optional() });
const collection = z.object({ documents: z.array(entry), architecture: z.array(entry) });
export type WorkbenchEntry = z.infer<typeof entry>;
export type WorkbenchCollection = z.infer<typeof collection>;
export async function loadCollection(key: string): Promise<WorkbenchCollection> {
  return browserStore("aimd-workbenches", "collections", "readonly", store => store.get(key), value => value === undefined ? { documents: [], architecture: [] } : collection.parse(value));
}
export async function saveCollection(key: string, value: WorkbenchCollection): Promise<void> {
  const valid = collection.parse(value);
  await browserStore("aimd-workbenches", "collections", "readwrite", store => store.put(valid, key), () => undefined);
}
