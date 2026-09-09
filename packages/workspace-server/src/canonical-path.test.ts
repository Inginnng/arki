import { describe, expect, it } from "vitest";

import { isCanonicalPathContained, sameCanonicalPath } from "./canonical-path.js";

describe("canonical path component comparison", () => {
  it("treats the Windows volume root as case-insensitive but preserves component case", () => {
    expect(isCanonicalPathContained("C:\\Root", "c:\\Root\\docs\\guide.md", "win32")).toBe(true);
    expect(sameCanonicalPath("C:\\Root", "c:\\Root", "win32")).toBe(true);

    expect(isCanonicalPathContained("C:\\Root", "C:\\root\\outside.md", "win32")).toBe(false);
    expect(sameCanonicalPath("C:\\Root", "C:\\root", "win32")).toBe(false);
  });

  it("rejects sibling-prefix and parent escapes on Windows", () => {
    expect(isCanonicalPathContained("C:\\Project", "C:\\ProjectOther\\file.md", "win32")).toBe(false);
    expect(isCanonicalPathContained("C:\\Project", "C:\\Project\\..\\outside.md", "win32")).toBe(false);
  });

  it("normalizes extended Windows drive prefixes without weakening component comparison", () => {
    expect(isCanonicalPathContained("\\\\?\\C:\\Root", "C:\\Root\\child.md", "win32")).toBe(true);
    expect(isCanonicalPathContained("\\\\?\\C:\\Root", "C:\\root\\child.md", "win32")).toBe(false);
  });

  it("keeps every POSIX component case-sensitive", () => {
    expect(isCanonicalPathContained("/workspace/Root", "/workspace/Root/file.md", "linux")).toBe(true);
    expect(isCanonicalPathContained("/workspace/Root", "/workspace/root/file.md", "linux")).toBe(false);
    expect(sameCanonicalPath("/workspace/Root", "/workspace/root", "linux")).toBe(false);
  });
});
