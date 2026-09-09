import { fileURLToPath } from "node:url";

import {
  defaultExecutableResolverDependencies,
  parseCodexVersionOutput,
  resolveCodexExecutable,
} from "../packages/app-server-bridge/src/executable.js";
import { runAppServerTypeGeneration } from "../packages/app-server-bridge/src/generator.js";

async function detectPathCliVersion(): Promise<string | undefined> {
  const dependencies = defaultExecutableResolverDependencies;
  const candidate = await dependencies.findOnPath("codex");
  if (!candidate || !(await dependencies.isFile(candidate))) return undefined;
  let executable: string;
  try {
    executable = await dependencies.realpath(candidate);
  } catch {
    return undefined;
  }
  const probe = await dependencies.run(executable, ["--version"]);
  return probe.status === 0 ? parseCodexVersionOutput(probe.stdout) : undefined;
}

async function main(): Promise<void> {
  const hostPath = process.env.AIMD_CODEX_HOST_BIN;
  const hostVersion = process.env.AIMD_CODEX_HOST_VERSION;
  const resolution = await resolveCodexExecutable({
    env: process.env,
    ...(hostPath && process.env.AIMD_CODEX_HOST_HINT_VERIFIED === "1"
      ? {
          verifiedHostHint: {
            path: hostPath,
            ...(hostVersion ? { version: hostVersion } : {}),
            verified: true,
          },
        }
      : {}),
    ...(process.env.AIMD_CODEX_DESKTOP_VERSION
      ? { desktopVersion: process.env.AIMD_CODEX_DESKTOP_VERSION }
      : {}),
  });
  if (resolution.status !== "resolved") throw new Error(resolution.code);

  const outputDirectory = fileURLToPath(
    new URL("../packages/app-server-bridge/generated", import.meta.url),
  );
  const pathCliVersion = process.env.AIMD_CODEX_PATH_VERSION ?? await detectPathCliVersion();
  await runAppServerTypeGeneration({
    executablePath: resolution.executablePath,
    outputDirectory,
    manifest: {
      executableBasename: resolution.executableBasename,
      schemaCliVersion: resolution.version,
      ...(process.env.AIMD_CODEX_DESKTOP_VERSION
        ? { desktopVersion: process.env.AIMD_CODEX_DESKTOP_VERSION }
        : {}),
      ...(pathCliVersion ? { pathCliVersion } : {}),
      generatedAt: new Date().toISOString(),
    },
  });
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : "APP_SERVER_SCHEMA_GENERATION_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
