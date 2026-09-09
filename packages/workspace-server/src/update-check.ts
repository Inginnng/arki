import { ARKI_VERSION, ARKI_REPOSITORY, ARKI_REPOSITORY_URL, type UpdateCheck } from "@aimd/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";

function versionParts(value: string): number[] | null {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) return null;
  const parts=value.split(".").map(Number);return parts.every(Number.isSafeInteger)?parts:null;
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader=response.body?.getReader();if(!reader)throw Error("invalid_response");
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>524288)throw Error("invalid_response");chunks.push(next.value);}}finally{await reader.cancel().catch(()=>undefined);}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function createUpdateChecker(options:{fetch?:typeof fetch;currentVersion?:string;now?:()=>number}={}) {
  const fetcher=options.fetch??fetch,currentVersion=options.currentVersion??ARKI_VERSION,now=options.now??Date.now;
  const current=versionParts(currentVersion);if(!current)throw Error("Invalid current release version");
  let cached:{value:UpdateCheck;expires:number}|undefined,pending:Promise<UpdateCheck>|undefined;
  async function request():Promise<UpdateCheck>{
    const base={currentVersion,latestVersion:null,releaseUrl:null,reason:null,checkedAt:new Date(now()).toISOString()} as const;
    try{
      const response=await fetcher(`https://api.github.com/repos/${ARKI_REPOSITORY}/releases/latest`,{headers:{accept:"application/vnd.github+json","user-agent":`Arki/${currentVersion}`,"x-github-api-version":"2026-03-10"},redirect:"error",signal:AbortSignal.timeout(10000)});
      if(response.status===404){await response.body?.cancel();return {...base,status:"no_release"};}
      if(response.status===403||response.status===429){await response.body?.cancel();return {...base,status:"unavailable",reason:"rate_limited"};}
      if(!response.ok){await response.body?.cancel();return {...base,status:"unavailable",reason:"network"};}
      let data:unknown;try{data=await boundedJson(response);}catch{return {...base,status:"unavailable",reason:"invalid_response"};}
      if(!data||typeof data!=="object")return {...base,status:"unavailable",reason:"invalid_response"};
      const item=data as Record<string,unknown>,tag=item.tag_name;
      if(typeof tag!=="string"||item.draft!==false||item.prerelease!==false||item.html_url!==`${ARKI_REPOSITORY_URL}/releases/tag/${tag}`)return {...base,status:"unavailable",reason:"invalid_response"};
      const latestVersion=tag.replace(/^v/u,""),latest=versionParts(latestVersion);
      if(!latest)return {...base,status:"unavailable",reason:"invalid_response"};
      const difference=latest.map((part,index)=>part-current![index]!).find(value=>value!==0)??0;
      return {...base,latestVersion,releaseUrl:item.html_url as string,status:difference>0?"available":difference<0?"ahead":"up_to_date"};
    }catch{return {...base,status:"unavailable",reason:"network"};}
  }
  return async():Promise<UpdateCheck>=>{
    if(cached&&cached.expires>now())return cached.value;
    if(!pending)pending=request().then(value=>{cached={value,expires:now()+(value.status==="unavailable"?60000:600000)};return value;}).finally(()=>{pending=undefined;});
    return pending;
  };
}
export function createUpdateApi(check=createUpdateChecker()){
  return {async handle(request:IncomingMessage,response:ServerResponse){
    if(request.url?.split("?",1)[0]!=="/api/updates")return false;
    const send=(status:number,body:unknown)=>{if(!response.destroyed)response.writeHead(status,{"content-type":"application/json;charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}).end(JSON.stringify(body));};
    try{const host=new URL("http://"+(request.headers.host??""));if(!["127.0.0.1","localhost","[::1]"].includes(host.hostname)||request.headers["sec-fetch-site"]==="cross-site"||(request.headers.origin&&request.headers.origin!==host.origin))throw Error();}catch{send(403,{error:"ORIGIN_FORBIDDEN"});return true;}
    if(request.method!=="GET"){send(405,{error:"METHOD_INVALID"});return true;}
    send(200,await check());return true;
  }};
}
