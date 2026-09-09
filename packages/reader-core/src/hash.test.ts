import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  digestCanonicalJson,
  sha256,
  sha256Bytes,
  sha256Text,
} from "./hash.js";

describe("hash helpers", () => {
  it("hashes UTF-8 text and bytes deterministically with SHA-256", () => {
    const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    expect(sha256Text("abc")).toBe(expected);
    expect(sha256Bytes(new Uint8Array([0x61, 0x62, 0x63]))).toBe(expected);
    expect(sha256("abc")).toBe(expected);
  });

  it("canonicalizes JSON object keys recursively without reordering arrays", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [3, 1, 2] })).toBe(
      '{"a":{"x":3,"y":2},"list":[3,1,2],"z":1}',
    );
  });

  it("gives equivalent JSON values the same canonical digest", () => {
    expect(digestCanonicalJson({ b: 2, a: 1 })).toBe(
      digestCanonicalJson({ a: 1, b: 2 }),
    );
  });

  it("rejects values that JSON cannot represent honestly", () => {
    expect(() => canonicalJson({ omitted: undefined })).toThrow(/JSON-safe/i);
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow(/finite/i);
  });
});
