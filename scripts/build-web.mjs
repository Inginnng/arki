import { build as bundle } from "esbuild";
import { build as viteBuild } from "vite";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { builtinModules } from "node:module";
import { assertArtifactHasNoKnownLocalPath } from "./package-plugin.mjs";

export async function buildWeb({ workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."), outDir = join(workspaceRoot, "plugins/aimd-reader/dist") } = {}) {
  await mkdir(outDir, { recursive: true });
  const uiRoot = join(workspaceRoot, "apps/reader-ui");
  await viteBuild({ root: uiRoot, configFile: join(uiRoot, "vite.config.ts"), build: { outDir: join(outDir, "web"), emptyOutDir: true, rollupOptions: { input: join(uiRoot, "web.html") } } });
  const aliases = Object.fromEntries(["contracts", "reader-core", "app-server-bridge"].map(name => [`@aimd/${name}`, join(workspaceRoot, `packages/${name}/src/index.ts`)]));
  const helper = await readFile(join(workspaceRoot, "scripts/safe-write-windows.ps1"));
  const result = await bundle({ entryPoints: [join(workspaceRoot, "scripts/start-web.mts")], outfile: join(outDir, "web-server.mjs"), alias: aliases, bundle: true, platform: "node", target: "node20", format: "esm", minify: true, sourcemap: false, legalComments: "none", metafile: true, define: { ARKI_PACKAGED: "true", __AIMD_SAFE_WRITE_HELPER_SHA256__: JSON.stringify(createHash("sha256").update(helper).digest("hex")) } });
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  for (const output of Object.values(result.metafile.outputs)) for (const item of output.imports) if (item.external && !builtins.has(item.path)) throw Error(`Arki bundle retains runtime dependency: ${item.path}`);
  const graphLicenses = await Promise.all(["@xyflow/react/LICENSE", "elkjs/LICENSE.md"].map(async path => "## " + path + "\n\n" + await readFile(join(uiRoot, "node_modules", path), "utf8")));
  const notices = "Arki web graph dependencies\nReact Flow: https://github.com/xyflow/xyflow (MIT)\nELK.js: https://github.com/kieler/elkjs (EPL-2.0, used unmodified)\nCorresponding source: https://github.com/kieler/elkjs/releases/tag/v0.12.0\n\n" + graphLicenses.join("\n\n");
  await writeFile(join(outDir, "third-party-licenses.txt"), notices);
  const webPath = join(outDir, "web/web.html");
  const escapedNotices = notices.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  await writeFile(webPath, (await readFile(webPath, "utf8")).replace("</body>", '<template id="arki-third-party-licenses"><pre>' + escapedNotices + '</pre></template></body>'));
  const web = await readFile(join(outDir, "web/web.html"), "utf8");
  const server = await readFile(join(outDir, "web-server.mjs"), "utf8");
  assertArtifactHasNoKnownLocalPath(web, [workspaceRoot]); assertArtifactHasNoKnownLocalPath(server, [workspaceRoot]);
  await cp(join(workspaceRoot, "third_party/archify"), join(outDir, "archify"), { recursive: true });
  await cp(join(workspaceRoot, "scripts/arki.mjs"), join(outDir, "arki.mjs"));
  await cp(join(workspaceRoot, "scripts/safe-write-windows.ps1"), join(outDir, "safe-write-windows.ps1"));
  process.stdout.write("Arki production web bundle ready.\n");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await buildWeb();
