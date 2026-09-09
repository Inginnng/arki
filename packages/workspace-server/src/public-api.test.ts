import { describe, expect, it } from "vitest";

import * as workspaceServer from "./index.js";

describe("workspace-server public API", () => {
  it("exports the guarded Task 5 building blocks from the package entry", () => {
    expect(workspaceServer).toMatchObject({
      loadReaderConfig: expect.any(Function),
      openAnnotationRepository: expect.any(Function),
      createPathGuard: expect.any(Function),
      resolveWorkspaceRoot: expect.any(Function),
      openReadOnlyWorkspace: expect.any(Function),
      ReaderService: expect.any(Function),
      createProductionReaderService: expect.any(Function),
      startProductionReaderServer: expect.any(Function),
      SafeOutputWriter: expect.any(Function),
      startReaderServer: expect.any(Function),
      isCanonicalPathContained: expect.any(Function),
    });
  });
});
