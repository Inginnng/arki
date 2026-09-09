import { createServer } from "node:http";
import { afterEach,expect,it,vi } from "vitest";
import { createUpdateApi } from "./update-check.js";
const servers:ReturnType<typeof createServer>[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));}));});
it("rejects foreign origins and unsupported methods before checking releases",async()=>{
 const check=vi.fn(async()=>({currentVersion:"0.3.0",latestVersion:null,status:"no_release" as const,reason:null,releaseUrl:null,checkedAt:new Date().toISOString()}));
 const api=createUpdateApi(check),server=createServer((request,response)=>{void api.handle(request,response).then(handled=>{if(!handled)response.writeHead(404).end();});});servers.push(server);
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw Error();const url=`http://127.0.0.1:${address.port}`;
 expect((await fetch(url+"/api/updates",{headers:{origin:"https://example.com"}})).status).toBe(403);
 expect((await fetch(url+"/api/updates",{method:"POST"})).status).toBe(405);expect(check).not.toHaveBeenCalled();
 const response=await fetch(url+"/api/updates");expect(response.headers.get("cache-control")).toBe("no-store");expect(await response.json()).toMatchObject({status:"no_release"});expect(check).toHaveBeenCalledOnce();
 expect((await fetch(url+"/unrelated")).status).toBe(404);
});
