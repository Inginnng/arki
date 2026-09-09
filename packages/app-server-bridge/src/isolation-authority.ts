const MODEL_ISOLATION_AUTHORITY = Symbol("aimd.model-isolation-authority");

export type ModelIsolationEnabledAuthority = Readonly<{
  status: "enabled";
  capability: "empty-model-tool-surface";
  readonly [MODEL_ISOLATION_AUTHORITY]: true;
}>;

const issuedModelIsolationAuthorities = new WeakSet<object>();

export function authenticateModelIsolationAuthority(
  value: unknown,
): ModelIsolationEnabledAuthority | undefined {
  return typeof value === "object" && value !== null &&
      issuedModelIsolationAuthorities.has(value)
    ? value as ModelIsolationEnabledAuthority
    : undefined;
}

/**
 * Internal friend seam imported only by isolation.testing.ts. It is not
 * re-exported by the package entry and is tree-shaken from the plugin bundle.
 */
export function mintModelIsolationAuthorityForTesting(): ModelIsolationEnabledAuthority {
  const authority = Object.freeze({
    status: "enabled" as const,
    capability: "empty-model-tool-surface" as const,
    [MODEL_ISOLATION_AUTHORITY]: true as const,
  });
  issuedModelIsolationAuthorities.add(authority);
  return authority;
}
