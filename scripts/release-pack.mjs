import { readFile,readdir,lstat,mkdir,writeFile } from 'node:fs/promises';
import { resolve,join,dirname,relative } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync,unzipSync } from 'fflate';
import { checkRelease } from './check-release.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function packRelease(workspace=root,output=join(workspace,'release')){
 const {version}=await checkRelease(workspace);const prefix=`arki-${version}/`,input={};
 async function collect(directory){for(const entry of await readdir(directory,{withFileTypes:true})){
  const path=join(directory,entry.name),info=await lstat(path);if(info.isSymbolicLink())throw Error('Release input contains a symlink');
  if(entry.isDirectory())await collect(path);else if(entry.isFile()){
   const name=relative(join(workspace,'plugins/aimd-reader'),path).replaceAll('\\','/');
   if(name.startsWith('../')||/(^|\/)(node_modules|\.git|\.env)(\/|$)/.test(name))throw Error('Unexpected release input');
   input[prefix+name]=new Uint8Array(await readFile(path));
  }
 }}
 await collect(join(workspace,'plugins/aimd-reader'));
 input[prefix+'LICENSE']=new Uint8Array(await readFile(join(workspace,'LICENSE')));
 input[prefix+'THIRD_PARTY_NOTICES.md']=new TextEncoder().encode((await readFile(join(workspace,'THIRD_PARTY_NOTICES.md'),'utf8')).replaceAll('third_party/archify/','dist/archify/').replaceAll('plugins/aimd-reader/dist/','dist/'));
 const guide=`# Arki ${version}\n\nRequires Node.js 20.19+ and a signed-in Codex CLI.\n\nRun from this directory:\n\n    node dist/arki.mjs --root "YOUR_PROJECT_DIRECTORY" --open\n\nWindows: drag a project directory onto Arki.cmd. Do not double-click without selecting a project.\n\nDocs: https://github.com/Inginnng/arki/blob/main/docs/getting-started.md\nUpdates: https://github.com/Inginnng/arki/blob/main/docs/updates.md\n\nAI analysis sends selected code excerpts to your configured Codex service.\nThis archive includes the compiled application; Node.js and Codex are not bundled.\n\nThird-party license texts: dist/third-party-licenses.txt and dist/archify/LICENSE.\n`;
 input[prefix+'README.md']=new TextEncoder().encode(guide);
 input[prefix+'Arki.cmd']=new TextEncoder().encode('@echo off\r\nsetlocal\r\nif "%~1"=="" (\r\n  echo Drag a project folder onto Arki.cmd, or run: Arki.cmd "PROJECT_DIRECTORY"\r\n  pause\r\n  exit /b 1\r\n)\r\nnode "%~dp0dist\\arki.mjs" --root "%~1" --open\r\n');
 const files=Object.fromEntries(Object.entries(input).sort(([a],[b])=>a.localeCompare(b)));
 const zip=zipSync(files,{level:6,mtime:new Date('2026-01-01T00:00:00Z')});
 const extracted=unzipSync(zip);
 for(const [name,bytes] of Object.entries(files))if(!extracted[name]||hash(extracted[name])!==hash(bytes))throw Error(`ZIP verification failed: ${name}`);
 const archive=`arki-${version}.zip`,sha256=hash(zip);
 const manifest=JSON.stringify({product:'Arki',version,repository:'https://github.com/Inginnng/arki',archive,sha256,files:Object.entries(files).map(([path,bytes])=>({path,bytes:bytes.length,sha256:hash(bytes)}))},null,2)+'\n';
 await mkdir(output,{recursive:true});await writeFile(join(output,archive),zip);await writeFile(join(output,'release-manifest.json'),manifest);
 await writeFile(join(output,'SHA256SUMS.txt'),`${sha256}  ${archive}\n${hash(Buffer.from(manifest))}  release-manifest.json\n`);
 return {version,archive,sha256,files:Object.keys(files).length};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(await packRelease()));
