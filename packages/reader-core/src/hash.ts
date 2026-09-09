/**
 * Synchronous hashing for trusted Node/server code.
 *
 * This module intentionally imports `node:crypto`; browser/UI bundles must not
 * import it. Browser callers should use Web Crypto asynchronously at their own
 * boundary and compare lowercase hex digests. Canonical JSON itself is runtime
 * neutral, but it lives here so every server-owned digest has one definition.
 */
import { createHash } from "node:crypto";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Canonical JSON numbers must be finite");
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError("Canonical JSON accepts only JSON-safe values");
  }

  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON cannot contain cycles");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError("Canonical JSON arrays must not be sparse");
        }
        entries.push(canonicalize(value[index], ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON objects must be plain JSON-safe records");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Canonical JSON objects must not contain symbol keys");
    }

    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new TypeError("Canonical JSON objects must contain enumerable data properties");
        }
        return `${JSON.stringify(key)}:${canonicalize(descriptor.value, ancestors)}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set());
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256(value: string | Uint8Array): string {
  return typeof value === "string" ? sha256Text(value) : sha256Bytes(value);
}

export function digestCanonicalJson(value: unknown): string {
  return sha256Text(canonicalJson(value));
}
