import { describe, expect, it } from "vitest";

import {
  HostContextExtractor,
  createPublicBindingHandle,
  extractUnverifiedBinding,
} from "./metadata.js";

describe("HostContextExtractor", () => {
  it.each([
    [
      { "openai/threadId": "thr_direct", "openai/turnId": "turn_direct" },
      "thr_direct",
      "turn_direct",
    ],
    [
      {
        "x-codex-turn-metadata": {
          thread_id: "thr_nested",
          turn_id: "turn_nested",
        },
      },
      "thr_nested",
      "turn_nested",
    ],
    [
      { thread: { id: "thr_structured" }, turn: { id: "turn_structured" } },
      "thr_structured",
      "turn_structured",
    ],
  ])("extracts only an allowlisted first-party binding", (meta, threadId, turnId) => {
    expect(extractUnverifiedBinding(meta)).toEqual({
      status: "candidate",
      parentThreadId: threadId,
      parentTurnId: turnId,
      source: "codex-hidden-meta",
    });
  });

  it("never treats an anonymous session value as a task id", () => {
    expect(
      extractUnverifiedBinding({
        "openai/session": "thr_session_looks_real",
        session: { threadId: "thr_recursive" },
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("does not recursively guess identifiers from arbitrary objects", () => {
    expect(
      extractUnverifiedBinding({
        wrapper: {
          "openai/threadId": "thr_buried",
          thread: { id: "thr_also_buried" },
        },
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("accepts only own data properties for every allowlisted representation", () => {
    const inheritedDirect = Object.create({ "openai/threadId": "thr_inherited" });
    expect(extractUnverifiedBinding(inheritedDirect)).toEqual({ status: "unavailable" });

    const inheritedNested = Object.create({ thread_id: "thr_inherited_nested" });
    expect(
      extractUnverifiedBinding({ "x-codex-turn-metadata": inheritedNested }),
    ).toEqual({ status: "unavailable" });

    const inheritedStructured = Object.create({ id: "thr_inherited_structured" });
    expect(extractUnverifiedBinding({ thread: inheritedStructured })).toEqual({
      status: "unavailable",
    });
  });

  it("fails closed without invoking accessor properties", () => {
    let getterCalls = 0;
    const meta = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(meta, "openai/threadId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not execute");
      },
    });

    expect(extractUnverifiedBinding(meta)).toEqual({ status: "unavailable" });
    expect(getterCalls).toBe(0);
  });

  it("fails closed when a proxy rejects metadata inspection", () => {
    const meta = new Proxy(Object.create(null) as Record<string, unknown>, {
      has() {
        throw new Error("host metadata trap");
      },
      getOwnPropertyDescriptor() {
        throw new Error("host metadata descriptor trap");
      },
    });

    expect(() => extractUnverifiedBinding(meta)).not.toThrow();
    expect(extractUnverifiedBinding(meta)).toEqual({ status: "unavailable" });
  });

  it.each(["thr_\u0085hidden", "thr_\ud800", "thr_\u202ereversed"])(
    "rejects non-ASCII opaque host ids: %j",
    (threadId) => {
      expect(extractUnverifiedBinding({ "openai/threadId": threadId })).toEqual({
        status: "unavailable",
      });
    },
  );

  it("fails closed when allowlisted representations disagree", () => {
    expect(
      extractUnverifiedBinding({
        "openai/threadId": "thr_one",
        "x-codex-turn-metadata": { thread_id: "thr_two" },
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("does not retain unknown raw metadata and exposes only an opaque public id", () => {
    const extractor = new HostContextExtractor();
    const extracted = extractor.extract({
      "openai/threadId": "thr_secret",
      "openai/turnId": "turn_secret",
      prompt: "private question",
      excerpt: "private source excerpt",
    });
    expect(extracted.status).toBe("candidate");
    if (extracted.status !== "candidate") throw new Error("expected candidate");

    const publicHandle = createPublicBindingHandle(extracted, () => "opaque-binding-1");
    const serialized = JSON.stringify(publicHandle);
    expect(publicHandle).toEqual({ bindingId: "opaque-binding-1" });
    expect(serialized).not.toContain("thr_secret");
    expect(serialized).not.toContain("turn_secret");
    expect(JSON.stringify(extracted)).not.toContain("private question");
    expect(JSON.stringify(extracted)).not.toContain("private source excerpt");
  });
});
