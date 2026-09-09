import type {
  Disposition,
  EditIntent,
  EditIntentBatch,
  SourceAnchor,
} from "@aimd/contracts";
import { describe, expect, it } from "vitest";

import {
  validateSynthesisOutput,
  type SynthesisValidationInput,
  type TrustedSynthesisAnnotation,
} from "./synthesis.js";

const DOCUMENT_PATH = "docs/design.md";
const DOCUMENT_HASH = "a".repeat(64);

function anchor(
  startOffset = 10,
  endOffset = 20,
  documentPath = DOCUMENT_PATH,
  documentHash = DOCUMENT_HASH,
): SourceAnchor {
  return {
    documentPath,
    documentHash,
    headingPath: ["Architecture"],
    selectedText: `selection-${startOffset}`,
    prefix: "before ",
    suffix: " after",
    startOffset,
    endOffset,
  };
}

function annotation(
  overrides: Partial<TrustedSynthesisAnnotation> = {},
): TrustedSynthesisAnnotation {
  return {
    annotationId: "ann-1",
    selected: true,
    disposition: "inline",
    anchor: anchor(),
    evidenceIds: ["ev-1"],
    ...overrides,
  };
}

function trustedInput(
  acceptedAnnotations: readonly TrustedSynthesisAnnotation[],
  overrides: Partial<SynthesisValidationInput> = {},
): SynthesisValidationInput {
  return {
    acceptedAnnotations,
    currentDocumentPath: DOCUMENT_PATH,
    currentDocumentHash: DOCUMENT_HASH,
    ...overrides,
  };
}

function operationFor(disposition: Disposition): EditIntent["operation"] {
  if (disposition === "inline") return "insert_after";
  if (disposition === "replace") return "replace";
  return "append_section";
}

function intent(
  accepted = annotation(),
  overrides: Partial<EditIntent> = {},
): EditIntent {
  return {
    annotationId: accepted.annotationId,
    operation: operationFor(accepted.disposition),
    targetAnchor: accepted.anchor,
    markdown: "> **Explanation:** The queue decouples intake from execution.",
    rationale: "Clarify the selected architecture.",
    evidenceIds: [accepted.evidenceIds[0] ?? "ev-1"],
    ...overrides,
  };
}

function batch(
  accepted = annotation(),
  overrides: Partial<EditIntentBatch> = {},
): EditIntentBatch {
  return {
    intents: [intent(accepted)],
    conflicts: [],
    ...overrides,
  };
}

describe("validateSynthesisOutput", () => {
  it("accepts one exact typed outcome for an explicitly selected annotation", () => {
    const accepted = annotation();
    const raw = batch(accepted);

    expect(validateSynthesisOutput(raw, trustedInput([accepted]))).toEqual(raw);
  });

  it("ignores annotations that were not selected or have non-editing dispositions", () => {
    const accepted = annotation();
    const unselected = annotation({
      annotationId: "ann-unselected",
      selected: false,
      anchor: anchor(30, 40),
      evidenceIds: ["ev-2"],
    });
    const readingOnly = annotation({
      annotationId: "ann-reading",
      disposition: "reading_only",
      anchor: anchor(50, 60),
      evidenceIds: ["ev-3"],
    });
    const ignored = annotation({
      annotationId: "ann-ignore",
      disposition: "ignore",
      anchor: anchor(70, 80),
      evidenceIds: ["ev-4"],
    });

    expect(
      validateSynthesisOutput(
        batch(accepted),
        trustedInput([accepted, unselected, readingOnly, ignored]),
      ),
    ).toMatchObject({ intents: [{ annotationId: "ann-1" }], conflicts: [] });
  });

  it("rejects untyped free-form Markdown", () => {
    expect(() =>
      validateSynthesisOutput("# rewritten document", trustedInput([annotation()])),
    ).toThrow(/structured edit batch is invalid/i);
  });

  it("requires exact coverage of the selected editable annotation set", () => {
    const first = annotation();
    const second = annotation({
      annotationId: "ann-2",
      anchor: anchor(30, 40),
      evidenceIds: ["ev-2"],
    });

    expect(() =>
      validateSynthesisOutput(batch(first), trustedInput([first, second])),
    ).toThrow(/exact selected annotation set/i);

    expect(() =>
      validateSynthesisOutput(
        {
          intents: [
            intent(first),
            intent(annotation({ annotationId: "ann-invented" })),
          ],
          conflicts: [],
        },
        trustedInput([first, second]),
      ),
    ).toThrow(/exact selected annotation set/i);
  });

  it("rejects a model outcome for an unselected annotation", () => {
    const selected = annotation();
    const unselected = annotation({
      annotationId: "ann-unselected",
      selected: false,
      anchor: anchor(30, 40),
      evidenceIds: ["ev-2"],
    });

    expect(() =>
      validateSynthesisOutput(
        {
          intents: [intent(selected), intent(unselected)],
          conflicts: [],
        },
        trustedInput([selected, unselected]),
      ),
    ).toThrow(/exact selected annotation set/i);
  });

  it("binds every intent to the exact accepted source anchor and current document", () => {
    const accepted = annotation();
    expect(() =>
      validateSynthesisOutput(
        batch(accepted, {
          intents: [
            intent(accepted, {
              targetAnchor: { ...accepted.anchor, startOffset: 11 },
            }),
          ],
        }),
        trustedInput([accepted]),
      ),
    ).toThrow(/changed an accepted source anchor/i);

    expect(() =>
      validateSynthesisOutput(
        batch(accepted),
        trustedInput([accepted], { currentDocumentPath: "docs/other.md" }),
      ),
    ).toThrow(/trusted synthesis input is invalid/i);

    expect(() =>
      validateSynthesisOutput(
        batch(accepted),
        trustedInput([accepted], { currentDocumentHash: "b".repeat(64) }),
      ),
    ).toThrow(/trusted synthesis input is invalid/i);
  });

  it("rejects evidence that was not validated for that annotation", () => {
    const accepted = annotation();
    expect(() =>
      validateSynthesisOutput(
        batch(accepted, {
          intents: [intent(accepted, { evidenceIds: ["ev-invented"] })],
        }),
        trustedInput([accepted]),
      ),
    ).toThrow(/evidence outside its accepted annotation/i);
  });

  it.each([
    ["inline", "replace"],
    ["replace", "insert_after"],
    ["glossary", "insert_after"],
    ["faq", "replace"],
  ] as const)(
    "binds disposition %s to its permitted edit operation",
    (disposition, wrongOperation) => {
      const accepted = annotation({ disposition });
      expect(() =>
        validateSynthesisOutput(
          batch(accepted, {
            intents: [intent(accepted, { operation: wrongOperation })],
          }),
          trustedInput([accepted]),
        ),
      ).toThrow(/operation does not match/i);
    },
  );

  it("accepts a typed conflict as the annotation's exact outcome", () => {
    const accepted = annotation();
    const raw: EditIntentBatch = {
      intents: [],
      conflicts: [{ annotationId: accepted.annotationId, reason: "Needs editorial choice." }],
    };
    expect(validateSynthesisOutput(raw, trustedInput([accepted]))).toEqual(raw);
  });

  it("rejects contradictory intents that overlap without typed conflicts", () => {
    const first = annotation();
    const second = annotation({
      annotationId: "ann-2",
      anchor: { ...first.anchor },
      evidenceIds: ["ev-2"],
    });
    const raw: EditIntentBatch = {
      intents: [
        intent(first, { markdown: "> First." }),
        intent(second, { markdown: "> Second.", evidenceIds: ["ev-2"] }),
      ],
      conflicts: [],
    };

    expect(() =>
      validateSynthesisOutput(raw, trustedInput([first, second])),
    ).toThrow(/overlapping synthesis intents conflict/i);
  });

  it("permits duplicate explanations only when target, disposition, and normalized Markdown agree", () => {
    const first = annotation();
    const second = annotation({
      annotationId: "ann-2",
      anchor: { ...first.anchor },
      evidenceIds: ["ev-2"],
    });
    const raw: EditIntentBatch = {
      intents: [
        intent(first, { markdown: "> Shared.  \r\n", evidenceIds: ["ev-1"] }),
        intent(second, { markdown: "> Shared.\n\n", evidenceIds: ["ev-2"] }),
      ],
      conflicts: [],
    };

    const result = validateSynthesisOutput(raw, trustedInput([first, second]));
    expect(result.intents).toHaveLength(2);
    expect(result.intents[1]?.markdown).toBe(result.intents[0]?.markdown);
    expect(result.intents.map(({ annotationId }) => annotationId)).toEqual(["ann-1", "ann-2"]);
  });

  it("rejects overlapping replace ranges even when the anchors are not identical", () => {
    const first = annotation({
      disposition: "replace",
      anchor: anchor(10, 20),
    });
    const second = annotation({
      annotationId: "ann-2",
      disposition: "replace",
      anchor: anchor(15, 25),
      evidenceIds: ["ev-2"],
    });
    const raw: EditIntentBatch = {
      intents: [
        intent(first, { markdown: "First" }),
        intent(second, { markdown: "Second", evidenceIds: ["ev-2"] }),
      ],
      conflicts: [],
    };

    expect(() =>
      validateSynthesisOutput(raw, trustedInput([first, second])),
    ).toThrow(/overlapping synthesis intents conflict/i);
  });

  it("rejects duplicate trusted annotation ids and an empty eligible set", () => {
    const accepted = annotation();
    expect(() =>
      validateSynthesisOutput(batch(accepted), trustedInput([accepted, { ...accepted }])),
    ).toThrow(/trusted synthesis input is invalid/i);

    const readingOnly = annotation({ disposition: "reading_only" });
    expect(() =>
      validateSynthesisOutput(batch(readingOnly), trustedInput([readingOnly])),
    ).toThrow(/no selected editable annotations/i);
  });

  it("copies and deeply freezes validated model output", () => {
    const accepted = annotation();
    const raw = batch(accepted);
    const result = validateSynthesisOutput(raw, trustedInput([accepted]));

    expect(result).not.toBe(raw);
    expect(result.intents[0]).not.toBe(raw.intents[0]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.intents)).toBe(true);
    expect(Object.isFrozen(result.intents[0]?.targetAnchor.headingPath)).toBe(true);

    raw.intents[0]!.markdown = "mutated later";
    expect(result.intents[0]?.markdown).not.toBe("mutated later");
  });

  it("does not invoke accessor-shaped model or trusted input", () => {
    const accepted = annotation();
    let modelReads = 0;
    let trustedReads = 0;
    const accessorModel = {
      conflicts: [],
      get intents() {
        modelReads += 1;
        return [intent(accepted)];
      },
    };
    const accessorTrusted = {
      currentDocumentPath: DOCUMENT_PATH,
      currentDocumentHash: DOCUMENT_HASH,
      get acceptedAnnotations() {
        trustedReads += 1;
        return [accepted];
      },
    };

    expect(() =>
      validateSynthesisOutput(accessorModel, trustedInput([accepted])),
    ).toThrow(/structured edit batch is invalid/i);
    expect(modelReads).toBe(0);

    expect(() =>
      validateSynthesisOutput(batch(accepted), accessorTrusted as SynthesisValidationInput),
    ).toThrow(/trusted synthesis input is invalid/i);
    expect(trustedReads).toBe(0);
  });

  it("rejects inherited intents smuggled through an own __proto__ property", () => {
    const accepted = annotation();
    const raw = JSON.parse(
      JSON.stringify({
        conflicts: [],
        __proto_payload: { intents: [intent(accepted)] },
      }).replace('"__proto_payload"', '"__proto__"'),
    ) as unknown;

    expect(Object.hasOwn(raw as object, "intents")).toBe(false);
    expect(() => validateSynthesisOutput(raw, trustedInput([accepted]))).toThrow(
      /structured edit batch is invalid/i,
    );
  });
});
