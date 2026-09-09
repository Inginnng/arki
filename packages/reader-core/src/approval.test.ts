import { describe, expect, it } from "vitest";

import { createApprovalAuthority } from "./approval.js";

const SOURCE_HASH = "a".repeat(64);
const DIFF_HASH = "b".repeat(64);

const input = {
  sessionId: "s1",
  sourceHash: SOURCE_HASH,
  diffHash: DIFF_HASH,
  targetPath: "docs/guide.explained.md",
};

describe("approval authority", () => {
  it("binds an opaque 256-bit approval to the exact source, diff, and target", () => {
    const approvals = createApprovalAuthority();

    const token = approvals.issue(input);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(approvals.verify(token, input)).toBe(true);
    expect(approvals.verify(token, { ...input, sourceHash: "c".repeat(64) })).toBe(false);
    expect(approvals.verify(token, { ...input, diffHash: "d".repeat(64) })).toBe(false);
    expect(approvals.verify(token, { ...input, targetPath: "README.md" })).toBe(false);
  });

  it("consumes an approval only once", () => {
    const approvals = createApprovalAuthority();
    const token = approvals.issue(input);

    expect(approvals.consume(token, input)).toBe(true);
    expect(approvals.consume(token, input)).toBe(false);
    expect(approvals.verify(token, input)).toBe(false);
  });

  it("reserves an approval atomically and commits it after its TTL", () => {
    let now = 1_000;
    const approvals = createApprovalAuthority({ now: () => now, ttlMs: 25 } as never);
    const token = approvals.issue(input);

    const reservation = approvals.reserve(token, input);

    expect(reservation).not.toBe(false);
    if (reservation === false) throw new Error("reservation fixture was not issued");
    expect(approvals.verify(token, input)).toBe(false);
    expect(approvals.reserve(token, input)).toBe(false);
    expect(approvals.consume(token, input)).toBe(false);

    now = 1_025;
    expect(approvals.verify(token, input)).toBe(false);
    expect(approvals.commit(reservation)).toBe(true);
    expect(approvals.commit(reservation)).toBe(false);
    expect(approvals.verify(token, input)).toBe(false);
  });

  it("releases a failed write reservation back to the unconsumed token", () => {
    const approvals = createApprovalAuthority();
    const token = approvals.issue(input);
    const reservation = approvals.reserve(token, input);

    expect(reservation).not.toBe(false);
    if (reservation === false) throw new Error("reservation fixture was not issued");
    expect(approvals.release(reservation)).toBe(true);
    expect(approvals.release(reservation)).toBe(false);
    expect(approvals.verify(token, input)).toBe(true);
    expect(approvals.consume(token, input)).toBe(true);
  });

  it("does not revive a token released after its TTL", () => {
    let now = 500;
    const approvals = createApprovalAuthority({ now: () => now, ttlMs: 25 } as never);
    const token = approvals.issue(input);
    const reservation = approvals.reserve(token, input);

    expect(reservation).not.toBe(false);
    if (reservation === false) throw new Error("reservation fixture was not issued");
    now = 525;
    expect(approvals.release(reservation)).toBe(true);
    expect(approvals.verify(token, input)).toBe(false);
    expect(approvals.reserve(token, input)).toBe(false);
    expect(approvals.consume(token, input)).toBe(false);
  });

  it("binds a reservation to the exact token and approval binding", () => {
    const approvals = createApprovalAuthority();
    const token = approvals.issue(input);

    expect(approvals.reserve(token, { ...input, diffHash: "c".repeat(64) })).toBe(false);
    expect(approvals.verify(token, input)).toBe(true);
  });

  it("fails closed for forged, proxied, accessor-shaped, and foreign reservations", () => {
    const approvals = createApprovalAuthority();
    const otherApprovals = createApprovalAuthority();
    const token = approvals.issue(input);
    const reservation = approvals.reserve(token, input);
    expect(reservation).not.toBe(false);
    if (reservation === false) throw new Error("reservation fixture was not issued");

    let traps = 0;
    const proxied = new Proxy(reservation, {
      get() {
        traps += 1;
        return true;
      },
      getPrototypeOf() {
        traps += 1;
        return null;
      },
    });
    const accessor = {};
    Object.defineProperty(accessor, "record", {
      enumerable: true,
      get() {
        traps += 1;
        return reservation;
      },
    });

    expect(approvals.commit({} as never)).toBe(false);
    expect(approvals.release(accessor as never)).toBe(false);
    expect(approvals.commit(proxied)).toBe(false);
    expect(otherApprovals.commit(reservation)).toBe(false);
    expect(traps).toBe(0);
    expect(approvals.commit(reservation)).toBe(true);
  });

  it("expires approvals after ten minutes without extending them on verification", () => {
    let now = 1_000;
    const approvals = createApprovalAuthority({ now: () => now } as never);
    const token = approvals.issue(input);

    now += 10 * 60 * 1_000 - 1;
    expect(approvals.verify(token, input)).toBe(true);
    now += 1;
    expect(approvals.verify(token, input)).toBe(false);
    expect(approvals.consume(token, input)).toBe(false);
  });

  it("supports a shorter injected TTL for deterministic tests", () => {
    let now = 50;
    const approvals = createApprovalAuthority({
      now: () => now,
      ttlMs: 25,
    } as never);
    const token = approvals.issue(input);

    now = 74;
    expect(approvals.verify(token, input)).toBe(true);
    now = 75;
    expect(approvals.verify(token, input)).toBe(false);
  });

  it.each([
    { ...input, sessionId: "bad session" },
    { ...input, sourceHash: "A".repeat(64) },
    { ...input, diffHash: "short" },
    { ...input, targetPath: "../guide.explained.md" },
    { ...input, targetPath: "/docs/guide.explained.md" },
    { ...input, targetPath: "docs\\guide.explained.md" },
  ])("rejects an invalid approval binding", (invalid) => {
    const approvals = createApprovalAuthority();
    expect(() => approvals.issue(invalid)).toThrow(/approval binding is invalid/i);
  });

  it("rejects unexpected binding fields", () => {
    const approvals = createApprovalAuthority();
    expect(() =>
      approvals.issue({ ...input, parentThreadId: "must-not-cross" } as typeof input),
    ).toThrow(/approval binding is invalid/i);
  });

  it("rejects non-enumerable extra binding fields", () => {
    const approvals = createApprovalAuthority();
    const hiddenExtra = { ...input };
    Object.defineProperty(hiddenExtra, "parentThreadId", {
      enumerable: false,
      value: "must-not-cross",
    });

    expect(() => approvals.issue(hiddenExtra)).toThrow(/approval binding is invalid/i);
  });

  it("rejects Proxy-shaped bindings without triggering traps", () => {
    const approvals = createApprovalAuthority();
    let traps = 0;
    const proxy = new Proxy({ ...input }, {
      getOwnPropertyDescriptor(target, key) {
        traps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf(target) {
        traps += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        traps += 1;
        return Reflect.ownKeys(target);
      },
    });

    expect(() => approvals.issue(proxy)).toThrow(/approval binding is invalid/i);
    expect(traps).toBe(0);
  });

  it("normalizes a revoked Proxy binding to the typed approval error", () => {
    const approvals = createApprovalAuthority();
    const revoked = Proxy.revocable({ ...input }, {});
    revoked.revoke();

    expect(() => approvals.issue(revoked.proxy)).toThrow(/approval binding is invalid/i);
  });

  it("does not invoke accessor-shaped approval input", () => {
    const approvals = createApprovalAuthority();
    let reads = 0;
    const accessorInput = {
      sessionId: input.sessionId,
      sourceHash: input.sourceHash,
      diffHash: input.diffHash,
    };
    Object.defineProperty(accessorInput, "targetPath", {
      enumerable: true,
      get() {
        reads += 1;
        return input.targetPath;
      },
    });

    expect(() => approvals.issue(accessorInput as typeof input)).toThrow(
      /approval binding is invalid/i,
    );
    expect(reads).toBe(0);
  });

  it("snapshots an issued binding instead of rereading mutable caller data", () => {
    const approvals = createApprovalAuthority();
    const mutable = { ...input };
    const token = approvals.issue(mutable);
    mutable.targetPath = "docs/other.explained.md";

    expect(approvals.verify(token, input)).toBe(true);
    expect(approvals.verify(token, mutable)).toBe(false);
  });

  it("rejects malformed tokens and malformed verification bindings without throwing", () => {
    const approvals = createApprovalAuthority();
    const token = approvals.issue(input);

    expect(approvals.verify("not a token", input)).toBe(false);
    expect(approvals.consume("x".repeat(10_000), input)).toBe(false);
    expect(approvals.verify(token, { ...input, targetPath: "../escape.md" })).toBe(false);
    expect(approvals.consume(token, { ...input, diffHash: "bad" })).toBe(false);
    expect(approvals.verify(token, input)).toBe(true);
  });

  it("enforces a bounded live approval set after pruning expired records", () => {
    let now = 0;
    const approvals = createApprovalAuthority({
      now: () => now,
      maxRecords: 1,
    } as never);
    approvals.issue(input);

    expect(() =>
      approvals.issue({ ...input, sessionId: "s2" }),
    ).toThrow(/approval capacity/i);

    now = 10 * 60 * 1_000;
    expect(() => approvals.issue({ ...input, sessionId: "s2" })).not.toThrow();
  });

  it("never reissues a live or consumed token when randomness collides", () => {
    const approvals = createApprovalAuthority({
      randomBytes: () => new Uint8Array(32),
    } as never);
    const token = approvals.issue(input);
    expect(approvals.consume(token, input)).toBe(true);

    expect(() => approvals.issue({ ...input, sessionId: "s2" })).toThrow(
      /unique approval token/i,
    );
  });
});
