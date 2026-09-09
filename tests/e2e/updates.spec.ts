import { expect,test } from "@playwright/test";
test("按需检查版本、展示官方链接，断网不误报最新版",async({page})=>{
 let calls=0;let offline=false;
 await page.route("**/api/health",route=>route.fulfill({json:{ok:true}}));
 await page.route("**/api/reader",route=>route.fulfill({json:{structuredContent:route.request().postDataJSON().name==="aimd_list_roots"?{roots:[{rootId:"updates",workspaceLabel:"更新功能示例",storageKey:"e".repeat(64)}]}:{documents:[]}}}));
 await page.route("**/api/updates",route=>{calls++;return offline?route.abort():route.fulfill({json:{currentVersion:"0.3.0",latestVersion:"0.4.0",status:"available",reason:null,releaseUrl:"https://github.com/Inginnng/arki/releases/tag/v0.4.0",checkedAt:"2026-09-09T00:00:00.000Z"}});});
 await page.goto("/web.html#documents");await page.getByLabel("版本与更新",{exact:true}).click();expect(calls).toBe(0);
 await page.getByRole("button",{name:"检查更新",exact:true}).click();await expect(page.getByText("发现新版本 v0.4.0",{exact:true})).toBeVisible();
 await expect(page.getByRole("link",{name:/查看更新说明与下载/})).toHaveAttribute("href","https://github.com/Inginnng/arki/releases/tag/v0.4.0");
 offline=true;await page.getByRole("button",{name:"检查更新",exact:true}).click();await expect(page.getByText(/暂时无法检查更新/)).toBeVisible();await expect(page.getByRole("link",{name:/查看更新说明与下载/})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
