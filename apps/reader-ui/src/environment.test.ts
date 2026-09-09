import { describe, expect, it } from "vitest";

describe("reader UI test environment", () => {
  it("provides browser DOM globals", () => {
    const element = document.createElement("main");
    element.textContent = "AIMD Reader";

    expect(element).toBeInstanceOf(HTMLElement);
    expect(element.textContent).toBe("AIMD Reader");
  });
});
