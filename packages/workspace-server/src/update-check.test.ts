import { describe, expect, it, vi } from "vitest";
import { createUpdateChecker } from "./update-check.js";
const release=(tag="v0.4.0")=>({tag_name:tag,html_url:`https://github.com/Inginnng/arki/releases/tag/${tag}`,draft:false,prerelease:false});
describe("public release checks",()=>{
 it("checks only the fixed public repository and shares cached concurrent requests",async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify(release())));
  const check=createUpdateChecker({fetch:fetcher,currentVersion:"0.3.0"});
  const [first,second]=await Promise.all([check(),check()]);
  expect(first).toMatchObject({status:"available",currentVersion:"0.3.0",latestVersion:"0.4.0"});expect(second).toEqual(first);
  await check();expect(fetcher).toHaveBeenCalledTimes(1);
  const [url,options]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe("https://api.github.com/repos/Inginnng/arki/releases/latest");expect(options.body).toBeUndefined();expect(options.headers).not.toHaveProperty("authorization");
 });
 it.each([["0.10.0","v0.9.0","ahead"],["0.3.0","v0.3.0","up_to_date"],["0.3.0","v0.10.0","available"]])("compares %s with %s numerically",async(currentVersion,tag,status)=>{
  expect(await createUpdateChecker({currentVersion,fetch:async()=>new Response(JSON.stringify(release(tag)))})()).toMatchObject({status});
 });
 it.each([404,403,429,500])("distinguishes missing releases, throttling and errors (%s)",async status=>{
  const result=await createUpdateChecker({currentVersion:"0.3.0",fetch:async()=>new Response("",{status})})();
  expect(result.status).toBe(status===404?"no_release":"unavailable");expect(result.latestVersion).toBeNull();
 });
 it.each([{...release(),html_url:"https://example.com/update.exe"},{...release(),prerelease:true},{...release(),draft:true},release("v0.4.0-rc.1"),release("bad")])("rejects untrusted or non-stable release metadata",async data=>{
  expect(await createUpdateChecker({currentVersion:"0.3.0",fetch:async()=>new Response(JSON.stringify(data))})()).toMatchObject({status:"unavailable",reason:"invalid_response",releaseUrl:null});
 });
 it("does not call a network failure up-to-date and retries after its cache expires",async()=>{
  let now=0;const fetcher=vi.fn(async()=>{throw Error("offline");});const check=createUpdateChecker({fetch:fetcher,currentVersion:"0.3.0",now:()=>now});
  expect(await check()).toMatchObject({status:"unavailable",reason:"network"});await check();expect(fetcher).toHaveBeenCalledTimes(1);now=61000;await check();expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it("bounds the response before parsing",async()=>{
  expect(await createUpdateChecker({currentVersion:"0.3.0",fetch:async()=>new Response(" ".repeat(524289))})()).toMatchObject({status:"unavailable",reason:"invalid_response"});
 });
});
