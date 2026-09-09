import { describe, expect, it } from "vitest";

import { mapDomRangeToSource, SelectionMappingError } from "./selection.js";

function rangeWithin(element: HTMLElement, start: number, end: number): Range {
  const text = element.firstChild;
  if (!text) throw new Error("missing text node");
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  return range;
}

describe("mapDomRangeToSource", () => {
  it.each([
    ["repeated phrase", "alpha target omega\n\ntarget again", "<p data-source-start='0' data-source-end='18'>alpha target omega</p>", 6, 12, 6, 12],
    ["emphasis", "The **gateway** routes.", "<p data-source-start='0' data-source-end='23'>The gateway routes.</p>", 4, 11, 6, 13],
    ["list item", "- inspect gateway", "<li data-source-start='0' data-source-end='17'>inspect gateway</li>", 8, 15, 10, 17],
    ["table cell", "| API | gateway |", "<table><tbody><tr><td data-source-start='6' data-source-end='15'>gateway</td></tr></tbody></table>", 0, 7, 8, 15],
    ["fenced code", "```ts\ngateway()\n```", "<code data-source-start='0' data-source-end='19'>gateway()</code>", 0, 7, 6, 13],
  ])("maps %s through parser-owned source bounds", (_name, markdown, html, domStart, domEnd, sourceStart, sourceEnd) => {
    const root = document.createElement("div");
    root.innerHTML = html;
    const element = root.querySelector<HTMLElement>("[data-source-start]")!;
    const result = mapDomRangeToSource(rangeWithin(element, domStart as number, domEnd as number), markdown as string);
    expect(result).toEqual({ startOffset: sourceStart, endOffset: sourceEnd, renderedText: element.textContent!.slice(domStart as number, domEnd as number) });
  });

  it("maps a range crossing adjacent positioned blocks without global text search", () => {
    const markdown = "Alpha starts here.\n\nBeta ends here.";
    const root = document.createElement("div");
    root.innerHTML = "<p data-source-start='0' data-source-end='18'>Alpha starts here.</p><p data-source-start='20' data-source-end='35'>Beta ends here.</p>";
    const first = root.children[0] as HTMLElement;
    const second = root.children[1] as HTMLElement;
    const range = document.createRange();
    range.setStart(first.firstChild!, 6);
    range.setEnd(second.firstChild!, 4);

    expect(mapDomRangeToSource(range, markdown)).toEqual({
      startOffset: 6,
      endOffset: 24,
      renderedText: "starts here.Beta",
    });
  });

  it("maps the second repeated plain-text word using the actual DOM offset", () => {
    const markdown = "target and target";
    const element = document.createElement("p");
    element.dataset.sourceStart = "0";
    element.dataset.sourceEnd = String(markdown.length);
    element.textContent = markdown;
    expect(mapDomRangeToSource(rangeWithin(element, 11, 17), markdown)).toEqual({ startOffset: 11, endOffset: 17, renderedText: "target" });
  });

  it("maps repeated formatted words from their parser positions and actual DOM offset", () => {
    const markdown = "**target** and target";
    const element = document.createElement("p");
    element.dataset.sourceStart = "0";
    element.dataset.sourceEnd = String(markdown.length);
    element.textContent = "target and target";
    expect(mapDomRangeToSource(rangeWithin(element, 11, 17), markdown)).toEqual({ startOffset: 15, endOffset: 21, renderedText: "target" });
  });

  it("never substitutes a hidden link destination for the selected formatted word", () => {
    const markdown = "[label](target) tar**get**";
    const element = document.createElement("p");
    element.dataset.sourceStart = "0"; element.dataset.sourceEnd = String(markdown.length);
    element.innerHTML = '<a href="target">label</a> tar<strong>get</strong>';
    const range = document.createRange();
    range.setStart(element.childNodes[1]!, 1); range.setEnd(element.lastChild!.firstChild!, 3);
    expect(mapDomRangeToSource(range, markdown)).toEqual({ startOffset: 16, endOffset: 24, renderedText: "target" });
  });

  it.each(["start", "end"])("uses proven visible leaf positions for the %s endpoint across blocks", endpoint => {
    const formatted = "[label](target) tar**get**";
    const markdown = endpoint === "start" ? `${formatted}\n\nNext.` : `First.\n\n${formatted}`;
    const root = document.createElement("div");
    const formattedStart = markdown.indexOf(formatted);
    const formatHtml = `<p data-source-start="${formattedStart}" data-source-end="${formattedStart + formatted.length}"><a href="target">label</a> tar<strong>get</strong></p>`;
    root.innerHTML = endpoint === "start" ? `${formatHtml}<p data-source-start="28" data-source-end="33">Next.</p>` : `<p data-source-start="0" data-source-end="6">First.</p>${formatHtml}`;
    const range = document.createRange();
    if (endpoint === "start") { range.setStart(root.firstChild!.childNodes[1]!, 1); range.setEnd(root.lastChild!.firstChild!, 4); }
    else { range.setStart(root.firstChild!.firstChild!, 0); range.setEnd(root.lastChild!.lastChild!.firstChild!, 3); }
    const mapped = mapDomRangeToSource(range, markdown);
    expect(mapped.startOffset).toBe(endpoint === "start" ? 16 : 0);
    expect(mapped.endOffset).toBe(32);
  });

  it.each([
    ["[label](target \"target\") tar**get**", "label target"],
    ["![target](image.png) tar**get**", " target"],
    ["[label][ref] tar**get**\n\n[ref]: target", "label target"],
  ])("does not map rendered words through hidden metadata: %s", (markdown, text) => {
    const end = markdown.indexOf("\n\n") < 0 ? markdown.length : markdown.indexOf("\n\n");
    const element = document.createElement("p");
    element.dataset.sourceStart = "0"; element.dataset.sourceEnd = String(end); element.textContent = text;
    const result = mapDomRangeToSource(rangeWithin(element, text.length - 6, text.length), markdown);
    expect(result.startOffset).toBe(markdown.indexOf("tar**get"));
  });

  it("rejects normalized entity text when an exact character mapping is unavailable", () => {
    const markdown = "a &amp; b";
    const element = document.createElement("p");
    element.dataset.sourceStart = "0"; element.dataset.sourceEnd = String(markdown.length); element.textContent = "a & b";
    expect(() => mapDomRangeToSource(rangeWithin(element, 2, 3), markdown)).toThrow(SelectionMappingError);
  });
});
