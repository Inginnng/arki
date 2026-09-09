export type ThreadReadParams = {
    threadId: string;
    /**
     * When true, include turns and their items from rollout history.
     * Full-history hydration is deprecated for paginated threads; prefer a
     * metadata-only read and page with `thread/turns/list` and
     * `thread/items/list`.
     */
    includeTurns?: boolean;
};
