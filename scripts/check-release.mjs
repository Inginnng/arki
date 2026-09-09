import { readFile,stat } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function checkRelease(workspace=root,tag=process.env.ARKI_RELEASE_TAG){
 const json=async path=>JSON.parse(await readFile(resolve(workspace,path),'utf8'));
 const manifest=await json('plugins/aimd-reader/.codex-plugin/plugin.json'),pkg=await json('package.json');
 const version=(await readFile(resolve(workspace,'packages/contracts/src/release.ts'),'utf8')).match(/ARKI_VERSION = "([^"]+)"/)?.[1];
 if(!version||!/^\d+\.\d+\.\d+$/.test(version)||version!==manifest.version||version!==pkg.version)throw Error('Release versions disagree');
 if(tag&&tag!==`v${version}`)throw Error(`Tag ${tag} does not match v${version}`);
 if(pkg.repository?.url!=='https://github.com/Inginnng/arki.git')throw Error('Unexpected release repository');
 const pages=['README.md','README.en.md','LICENSE','THIRD_PARTY_NOTICES.md','CONTRIBUTING.md','SECURITY.md','CODE_OF_CONDUCT.md','CHANGELOG.md','docs/README.md','docs/getting-started.md','docs/user-guide.md','docs/updates.md','docs/development.md','docs/releasing.md','docs/troubleshooting.md','docs/roadmap.md',`docs/releases/v${version}.md`];
 for(const page of pages){
  const content=await readFile(resolve(workspace,page),'utf8');
  for(const match of content.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)){
   const link=match[1];if(/^(?:https?:|mailto:|#)/.test(link))continue;
   const target=decodeURIComponent(link.split('#')[0]);if(target&&!(await stat(resolve(workspace,dirname(page),target)).catch(()=>null)))throw Error(`Missing link in ${page}: ${target}`);
  }
 }
 const required=['dist/arki.mjs','dist/web-server.mjs','dist/web/web.html','dist/server.mjs','dist/reader.html','dist/third-party-licenses.txt','.mcp.json'];
 for(const file of required)if(!(await stat(resolve(workspace,'plugins/aimd-reader',file))).isFile())throw Error(`Missing artifact: ${file}`);
 return {version,documents:pages.length};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(await checkRelease()));
