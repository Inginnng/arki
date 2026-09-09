import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_SAFE_WRITE_CONTENT_BYTES,
  MAX_SAFE_WRITE_STDIN_BYTES,
  PACKAGED_SAFE_WRITE_HELPER_SHA256,
  SafeOutputWriteError,
  SafeOutputWriter,
  createPackagedSafeOutputWriter,
  type SafeWriteHelperInvocation,
  type SafeWriterDependencies,
} from "./safe-writer.js";

const HELPER_TEXT = "# trusted helper fixture\n";
const HELPER_BYTES = new TextEncoder().encode(HELPER_TEXT);
const HELPER_HASH = createHash("sha256").update(HELPER_BYTES).digest("hex");
const POWERSHELL_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const HELPER_PATH = "C:\\Program Files\\AIMD Reader\\safe-write-windows.ps1";
const SOURCE = {
  canonicalRoot: "C:\\repo",
  canonicalSourcePath: "C:\\repo\\docs\\guide.md",
  sourceContentSha256: "a".repeat(64),
} as const;

function created(): { exitCode: number; stdout: string } {
  return { exitCode: 0, stdout: '{"version":1,"status":"created"}\n' };
}

function fakeDependencies(
  overrides: Partial<SafeWriterDependencies> = {},
): SafeWriterDependencies {
  return {
    platform: "win32",
    async inspectOrdinaryFile(path) {
      return { canonicalPath: path, ordinaryFile: true };
    },
    async readFileBytes() {
      return HELPER_BYTES;
    },
    async runHelper() {
      return created();
    },
    ...overrides,
  };
}

function writer(
  dependencies: SafeWriterDependencies,
  overrides: Partial<ConstructorParameters<typeof SafeOutputWriter>[0]> = {},
): SafeOutputWriter {
  return new SafeOutputWriter(
    {
      powershellExecutablePath: POWERSHELL_PATH,
      helperScriptPath: HELPER_PATH,
      expectedHelperSha256: HELPER_HASH,
      ...overrides,
    },
    dependencies,
  );
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "SafeOutputWriteError",
    code,
    message: code,
  });
}

describe("SafeOutputWriter capability boundary", () => {
  it("keeps the packaged factory unavailable until the audited hash is build-injected", async () => {
    const runHelper = vi.fn(async () => created());
    expect(PACKAGED_SAFE_WRITE_HELPER_SHA256).toBe("");

    const packaged = createPackagedSafeOutputWriter(
      {
        powershellExecutablePath: POWERSHELL_PATH,
      },
      fakeDependencies({ runHelper }),
    );
    await expect(packaged.capability()).resolves.toEqual({
      status: "unavailable",
      code: "SAFE_WRITE_UNAVAILABLE",
    });
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("uses literal inspected paths, shell:false, and bounded JSON stdin", async () => {
    let invocation: SafeWriteHelperInvocation | undefined;
    const inspectOrdinaryFile = vi.fn(async (path: string) => ({
      canonicalPath: path,
      ordinaryFile: true,
    }));
    const runHelper = vi.fn(async (value: SafeWriteHelperInvocation) => {
      invocation = value;
      return created();
    });
    const safeWriter = writer(fakeDependencies({ inspectOrdinaryFile, runHelper }));
    const content = new TextEncoder().encode("# Explained\n\nCurrent project evidence.\n");

    await expect(
      safeWriter.createExplainedSibling(
        SOURCE,
        "guide.explained.md",
        content,
      ),
    ).resolves.toEqual({ targetBasename: "guide.explained.md", byteLength: content.byteLength });

    expect(inspectOrdinaryFile).toHaveBeenCalledWith(POWERSHELL_PATH);
    expect(inspectOrdinaryFile).toHaveBeenCalledWith(HELPER_PATH);
    expect(invocation).toBeDefined();
    expect(invocation).toMatchObject({
      executablePath: POWERSHELL_PATH,
      shell: false,
      windowsHide: true,
    });
    expect(invocation?.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      HELPER_PATH,
    ]);
    expect(Buffer.byteLength(invocation?.stdin ?? "", "utf8")).toBeLessThanOrEqual(
      MAX_SAFE_WRITE_STDIN_BYTES,
    );
    const request = JSON.parse(invocation?.stdin ?? "{}") as Record<string, unknown>;
    expect(request).toEqual({
      version: 1,
      operation: "create",
      canonicalRoot: SOURCE.canonicalRoot,
      canonicalSourcePath: SOURCE.canonicalSourcePath,
      sourceContentSha256: SOURCE.sourceContentSha256,
      targetBasename: "guide.explained.md",
      contentBase64: Buffer.from(content).toString("base64"),
    });
  });

  it("derives one basename-only .explained.md sibling and rejects alternate paths", async () => {
    const runHelper = vi.fn(async () => created());
    const safeWriter = writer(fakeDependencies({ runHelper }));
    const bytes = new TextEncoder().encode("safe\n");

    for (const target of [
      "other.explained.md",
      "docs/guide.explained.md",
      "..\\guide.explained.md",
      "guide.explained.md:stream",
      "guide.explained.md.",
      "guide.explained.md ",
    ]) {
      await expectCode(
        safeWriter.createExplainedSibling(SOURCE, target, bytes),
        "UNSAFE_OUTPUT_PATH_CHANGED",
      );
    }
    await expectCode(
      safeWriter.createExplainedSibling(
        { ...SOURCE, canonicalSourcePath: "C:\\outside\\guide.md" },
        "guide.explained.md",
        bytes,
      ),
      "UNSAFE_OUTPUT_PATH_CHANGED",
    );
    for (const [sourceName, target] of [
      ["CONIN$.md", "CONIN$.explained.md"],
      ["COM¹.md", "COM¹.explained.md"],
      ["guide\u0085.md", "guide\u0085.explained.md"],
    ] as const) {
      await expectCode(
        safeWriter.createExplainedSibling(
          { ...SOURCE, canonicalSourcePath: `C:\\repo\\docs\\${sourceName}` },
          target,
          bytes,
        ),
        "UNSAFE_OUTPUT_PATH_CHANGED",
      );
    }
    await expectCode(
      safeWriter.createExplainedSibling(
        { ...SOURCE, sourceContentSha256: "not-a-hash" },
        "guide.explained.md",
        bytes,
      ),
      "UNSAFE_OUTPUT_PATH_CHANGED",
    );
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("supports the stable .markdown source form accepted by the workspace", async () => {
    const runHelper = vi.fn(async () => created());
    const safeWriter = writer(fakeDependencies({ runHelper }));
    const content = new TextEncoder().encode("explained\n");

    await expect(
      safeWriter.createExplainedSibling(
        {
          canonicalRoot: "C:\\repo",
          canonicalSourcePath: "C:\\repo\\docs\\handbook.markdown",
          sourceContentSha256: "b".repeat(64),
        },
        "handbook.explained.md",
        content,
      ),
    ).resolves.toEqual({
      targetBasename: "handbook.explained.md",
      byteLength: content.byteLength,
    });
    expect(runHelper).toHaveBeenCalledOnce();
  });

  it("rejects runtime-malformed source descriptors with a fixed non-leaking code", async () => {
    const runHelper = vi.fn(async () => created());
    const safeWriter = writer(fakeDependencies({ runHelper }));
    const malformed = [
      null,
      {},
      [],
      { ...SOURCE, sourceContentSha256: 42 },
    ];

    for (const source of malformed) {
      await expectCode(
        safeWriter.createExplainedSibling(
          source as unknown as typeof SOURCE,
          "guide.explained.md",
          new Uint8Array([1]),
        ),
        "UNSAFE_OUTPUT_PATH_CHANGED",
      );
    }
    await expectCode(
      safeWriter.createExplainedSibling(
        SOURCE,
        null as unknown as string,
        new Uint8Array([1]),
      ),
      "UNSAFE_OUTPUT_PATH_CHANGED",
    );
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("does not fold canonical path case at an authorization boundary", async () => {
    const runHelper = vi.fn(async () => created());
    const safeWriter = writer(fakeDependencies({ runHelper }));

    await expectCode(
      safeWriter.createExplainedSibling(
        {
          canonicalRoot: "C:\\case-sensitive\\Root",
          canonicalSourcePath: "C:\\case-sensitive\\root\\guide.md",
          sourceContentSha256: "c".repeat(64),
        },
        "guide.explained.md",
        new Uint8Array([1]),
      ),
      "UNSAFE_OUTPUT_PATH_CHANGED",
    );
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("never overwrites an output that already exists", async () => {
    const safeWriter = writer(fakeDependencies({
      async runHelper() {
        return {
          exitCode: 10,
          stdout: '{"version":1,"status":"error","code":"OUTPUT_ALREADY_EXISTS"}\n',
        };
      },
    }));

    await expectCode(
      safeWriter.createExplainedSibling(
        SOURCE,
        "guide.explained.md",
        new TextEncoder().encode("must not replace\n"),
      ),
      "OUTPUT_ALREADY_EXISTS",
    );
  });

  it("fails closed before spawning when the packaged helper hash or file identity is wrong", async () => {
    const runHelper = vi.fn(async () => created());
    const mismatch = writer(fakeDependencies({ runHelper }), {
      expectedHelperSha256: "0".repeat(64),
    });
    await expectCode(
      mismatch.createExplainedSibling(
        SOURCE,
        "guide.explained.md",
        new Uint8Array([1]),
      ),
      "SAFE_WRITE_UNAVAILABLE",
    );

    const linked = writer(fakeDependencies({
      async inspectOrdinaryFile(path) {
        return { canonicalPath: `${path}.elsewhere`, ordinaryFile: true };
      },
      runHelper,
    }));
    await expectCode(
      linked.createExplainedSibling(
        SOURCE,
        "guide.explained.md",
        new Uint8Array([1]),
      ),
      "SAFE_WRITE_UNAVAILABLE",
    );
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("bounds content and complete stdin before invoking PowerShell", async () => {
    let invocation: SafeWriteHelperInvocation | undefined;
    const runHelper = vi.fn(async (value: SafeWriteHelperInvocation) => {
      invocation = value;
      return created();
    });
    const safeWriter = writer(fakeDependencies({ runHelper }));

    await expectCode(
      safeWriter.createExplainedSibling(
        SOURCE,
        "guide.explained.md",
        new Uint8Array(MAX_SAFE_WRITE_CONTENT_BYTES + 1),
      ),
      "SAFE_WRITE_INPUT_TOO_LARGE",
    );
    expect(runHelper).not.toHaveBeenCalled();

    const maximum = new Uint8Array(MAX_SAFE_WRITE_CONTENT_BYTES);
    await safeWriter.createExplainedSibling(SOURCE, "guide.explained.md", maximum);
    expect(runHelper).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(invocation?.stdin ?? "", "utf8")).toBeLessThanOrEqual(
      MAX_SAFE_WRITE_STDIN_BYTES,
    );
  });

  it("maps unsupported platforms, PowerShell policy failures, and malformed output to one unavailable code", async () => {
    const secret = "C:\\Users\\private\\task-secret";
    const cases: SafeWriterDependencies[] = [
      fakeDependencies({ platform: "linux" }),
      fakeDependencies({
        async runHelper() {
          return { exitCode: 1, stdout: "" };
        },
      }),
      fakeDependencies({
        async runHelper() {
          return { exitCode: 0, stdout: `${secret}\n` };
        },
      }),
      fakeDependencies({
        async runHelper() {
          throw new Error(secret);
        },
      }),
    ];

    for (const dependencies of cases) {
      let failure: unknown;
      try {
        await writer(dependencies).createExplainedSibling(
          SOURCE,
          "guide.explained.md",
          new Uint8Array([1]),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SafeOutputWriteError);
      expect(failure).toMatchObject({ code: "SAFE_WRITE_UNAVAILABLE" });
      expect(String(failure)).not.toContain(secret);
    }
  });

  it("does not expose a raw stderr channel at the runner boundary", async () => {
    const runHelper = vi.fn(async () => ({
      exitCode: 12,
      stdout: '{"version":1,"status":"error","code":"SAFE_WRITE_UNAVAILABLE"}\n',
      stderr: "C:\\secret\\source.md",
    }));
    const safeWriter = writer(fakeDependencies({
      runHelper: runHelper as unknown as SafeWriterDependencies["runHelper"],
    }));

    await expectCode(
      safeWriter.createExplainedSibling(
        SOURCE,
        "guide.explained.md",
        new Uint8Array([1]),
      ),
      "SAFE_WRITE_UNAVAILABLE",
    );
    expect(runHelper).toHaveBeenCalledOnce();
  });

  it("reports capability only after an exact helper probe succeeds", async () => {
    const invocations: SafeWriteHelperInvocation[] = [];
    const safeWriter = writer(fakeDependencies({
      async runHelper(invocation) {
        invocations.push(invocation);
        return {
          exitCode: 0,
          stdout: '{"version":1,"status":"capable","capability":"windows_locked_chain_create_new_v1"}\n',
        };
      },
    }));

    await expect(safeWriter.capability()).resolves.toEqual({
      status: "available",
      capability: "windows_locked_chain_create_new_v1",
    });
    expect(JSON.parse(invocations[0]?.stdin ?? "{}")).toEqual({
      version: 1,
      operation: "probe",
    });

    const unavailable = writer(fakeDependencies({
      async runHelper() {
        return { exitCode: 1, stdout: "policy blocked" };
      },
    }));
    await expect(unavailable.capability()).resolves.toEqual({
      status: "unavailable",
      code: "SAFE_WRITE_UNAVAILABLE",
    });
  });

  it("maps a detected directory-chain swap to UNSAFE_OUTPUT_PATH_CHANGED", async () => {
    let swapAttempted = false;
    const safeWriter = writer(fakeDependencies({
      async runHelper() {
        swapAttempted = true;
        return {
          exitCode: 11,
          stdout: '{"version":1,"status":"error","code":"UNSAFE_OUTPUT_PATH_CHANGED"}\n',
        };
      },
    }));

    await expectCode(
      safeWriter.createExplainedSibling(
        SOURCE,
        "guide.explained.md",
        new Uint8Array([1]),
      ),
      "UNSAFE_OUTPUT_PATH_CHANGED",
    );
    expect(swapAttempted).toBe(true);
  });
});

describe("audited Windows safe-write helper", () => {
  const helperPath = fileURLToPath(
    new URL("../../../scripts/safe-write-windows.ps1", import.meta.url),
  );

  it("contains the locked-directory, no-reparse, CreateNew, and durable-flush primitives", async () => {
    const script = await readFile(helperPath, "utf8");

    expect(script).toContain("FILE_FLAG_OPEN_REPARSE_POINT");
    expect(script).toContain("FILE_FLAG_BACKUP_SEMANTICS");
    expect(script).toMatch(/FileShare\.Read\s*\|\s*FileShare\.Write/u);
    expect(script).not.toContain("FileShare.Delete");
    expect(script).toContain("FileMode.CreateNew");
    expect(script).toMatch(/Flush\(true\)/u);
    expect(script).toContain("SafeFileHandle");
    expect(script).not.toMatch(/Invoke-Expression|Start-Process|ExecutionPolicy\s+Bypass/iu);
  });

  it.runIf(process.platform === "win32")(
    "creates once with the real helper and preserves the first file",
    async () => {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot) return;
      const powershellPath = join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const helperBytes = await readFile(helperPath);
      const root = await mkdtemp(join(tmpdir(), "aimd-safe-writer-"));
      const sourcePath = join(root, "guide.md");
      await writeFile(sourcePath, "# Source\n", "utf8");
      const canonicalRoot = await realpath(root);
      const canonicalSourcePath = await realpath(sourcePath);
      const sourceContentSha256 = createHash("sha256").update("# Source\n").digest("hex");
      const safeWriter = new SafeOutputWriter({
        powershellExecutablePath: powershellPath,
        helperScriptPath: helperPath,
        expectedHelperSha256: createHash("sha256").update(helperBytes).digest("hex"),
      });
      const capability = await safeWriter.capability();
      if (capability.status === "unavailable") {
        if (process.env.AIMD_REQUIRE_WINDOWS_SAFE_WRITE === "1") {
          expect(capability.status).toBe("available");
        }
        return;
      }

      const source = { canonicalRoot, canonicalSourcePath, sourceContentSha256 };
      await expectCode(
        safeWriter.createExplainedSibling(
          { ...source, sourceContentSha256: "0".repeat(64) },
          "guide.explained.md",
          new TextEncoder().encode("unbound\n"),
        ),
        "UNSAFE_OUTPUT_PATH_CHANGED",
      );
      const first = new TextEncoder().encode("first\n");
      await safeWriter.createExplainedSibling(
        source,
        "guide.explained.md",
        first,
      );
      await expectCode(
        safeWriter.createExplainedSibling(
          source,
          "guide.explained.md",
          new TextEncoder().encode("second\n"),
        ),
        "OUTPUT_ALREADY_EXISTS",
      );
      await expect(readFile(join(root, "guide.explained.md"), "utf8")).resolves.toBe("first\n");

      const unicodeParent = join(root, "中文-😀");
      const unicodeSourcePath = join(unicodeParent, "说明.markdown");
      const unicodeSource = "# 说明\n";
      await mkdir(unicodeParent);
      await writeFile(unicodeSourcePath, unicodeSource, "utf8");
      const canonicalUnicodeSourcePath = await realpath(unicodeSourcePath);
      await safeWriter.createExplainedSibling(
        {
          canonicalRoot,
          canonicalSourcePath: canonicalUnicodeSourcePath,
          sourceContentSha256: createHash("sha256").update(unicodeSource).digest("hex"),
        },
        "说明.explained.md",
        new TextEncoder().encode("已解释\n"),
      );
      await expect(readFile(join(unicodeParent, "说明.explained.md"), "utf8")).resolves.toBe(
        "已解释\n",
      );
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "refuses a reparse-point source parent without writing outside the root",
    async () => {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot) return;
      const powershellPath = join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const helperBytes = await readFile(helperPath);
      const root = await mkdtemp(join(tmpdir(), "aimd-safe-root-"));
      const outside = await mkdtemp(join(tmpdir(), "aimd-safe-outside-"));
      await writeFile(join(outside, "guide.md"), "# Outside\n", "utf8");
      try {
        await symlink(outside, join(root, "linked"), "junction");
      } catch {
        return;
      }
      const canonicalRoot = await realpath(root);
      const linkedSourcePath = join(canonicalRoot, "linked", "guide.md");
      const sourceContentSha256 = createHash("sha256").update("# Outside\n").digest("hex");
      const safeWriter = new SafeOutputWriter({
        powershellExecutablePath: powershellPath,
        helperScriptPath: helperPath,
        expectedHelperSha256: createHash("sha256").update(helperBytes).digest("hex"),
      });
      const capability = await safeWriter.capability();
      if (capability.status === "unavailable") {
        if (process.env.AIMD_REQUIRE_WINDOWS_SAFE_WRITE === "1") {
          expect(capability.status).toBe("available");
        }
        return;
      }

      await expectCode(
        safeWriter.createExplainedSibling(
          { canonicalRoot, canonicalSourcePath: linkedSourcePath, sourceContentSha256 },
          "guide.explained.md",
          new TextEncoder().encode("must stay inside\n"),
        ),
        "UNSAFE_OUTPUT_PATH_CHANGED",
      );
      await expect(readFile(join(outside, "guide.explained.md"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "blocks or refuses a real concurrent parent junction swap without writing outside",
    async () => {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot) return;
      const powershellPath = join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const helperBytes = await readFile(helperPath);
      const root = await mkdtemp(join(tmpdir(), "aimd-safe-race-root-"));
      const outside = await mkdtemp(join(tmpdir(), "aimd-safe-race-outside-"));
      const sourceParent = join(root, "docs");
      const movedParent = join(root, "docs-before-swap");
      const sourcePath = join(sourceParent, "guide.md");
      const sourceText = "# Source\n";
      const explainedBasename = "guide.explained.md";
      await mkdir(sourceParent);
      await writeFile(sourcePath, sourceText, "utf8");

      const canonicalRoot = await realpath(root);
      const canonicalSourcePath = await realpath(sourcePath);
      const sourceContentSha256 = createHash("sha256").update(sourceText).digest("hex");
      const safeWriter = new SafeOutputWriter({
        powershellExecutablePath: powershellPath,
        helperScriptPath: helperPath,
        expectedHelperSha256: createHash("sha256").update(helperBytes).digest("hex"),
        timeoutMs: 30_000,
      });
      const capability = await safeWriter.capability();
      if (capability.status === "unavailable") {
        if (process.env.AIMD_REQUIRE_WINDOWS_SAFE_WRITE === "1") {
          expect(capability.status).toBe("available");
        }
        return;
      }

      let writerSettled = false;
      let sawBlockedRename = false;
      let swapSucceeded = false;
      let junctionUnavailable = false;
      const content = new Uint8Array(MAX_SAFE_WRITE_CONTENT_BYTES);
      content.fill(0x78);
      const writeOutcome = safeWriter.createExplainedSibling(
        { canonicalRoot, canonicalSourcePath, sourceContentSha256 },
        explainedBasename,
        content,
      ).then(
        () => "created" as const,
        (error: unknown) => {
          expect(error).toMatchObject({
            name: "SafeOutputWriteError",
            code: "UNSAFE_OUTPUT_PATH_CHANGED",
          });
          return "refused" as const;
        },
      ).finally(() => {
        writerSettled = true;
      });

      const swapRace = (async () => {
        const deadline = Date.now() + 20_000;
        while (!writerSettled && !swapSucceeded && Date.now() < deadline) {
          try {
            await rename(sourceParent, movedParent);
            try {
              await symlink(outside, sourceParent, "junction");
              swapSucceeded = true;
            } catch {
              junctionUnavailable = true;
              try {
                await rename(movedParent, sourceParent);
              } catch {
                // The writer may briefly hold the restored path. The strong gate
                // below turns an unavailable junction capability into a failure.
              }
            }
          } catch {
            sawBlockedRename = true;
          }
          if (!writerSettled && !swapSucceeded) await delay(0);
        }
      })();

      const [outcome] = await Promise.all([writeOutcome, swapRace]);
      if (junctionUnavailable) {
        if (process.env.AIMD_REQUIRE_WINDOWS_SAFE_WRITE === "1") {
          expect(junctionUnavailable).toBe(false);
        }
        return;
      }

      expect(outcome === "refused" || sawBlockedRename).toBe(true);
      await expect(readFile(join(outside, explainedBasename))).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (outcome === "created") {
        const outputParent = swapSucceeded ? movedParent : sourceParent;
        await expect(readFile(join(outputParent, explainedBasename))).resolves.toEqual(
          Buffer.from(content),
        );
      }
    },
    45_000,
  );
});
