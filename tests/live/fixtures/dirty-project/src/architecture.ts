export const LIVE_DIRTY_SENTINEL = "committed-baseline";

export type ContextLayer = "task" | "workspace" | "document";

export function describeContextFlow(layers: readonly ContextLayer[]): string {
  return layers.join(" -> ");
}
