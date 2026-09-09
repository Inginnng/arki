import { mintModelIsolationAuthorityForTesting } from "./isolation-authority.js";
import type { ModelIsolationResult } from "./isolation.js";

/** Test-only friend API. This module is not exported by the package entry. */
export function issueModelIsolationAuthorityForTesting(): ModelIsolationResult {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("MODEL_ISOLATION_TEST_AUTHORITY_UNAVAILABLE");
  }
  return mintModelIsolationAuthorityForTesting();
}
