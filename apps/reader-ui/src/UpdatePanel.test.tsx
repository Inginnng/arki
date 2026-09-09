import { cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { afterEach,expect,it,vi } from "vitest";
import { UpdatePanel } from "./UpdatePanel.js";
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it("contacts no server until requested, then shows an official release link",async()=>{
 const fetcher=vi.fn(async()=>({ok:true,json:async()=>({currentVersion:"0.3.0",latestVersion:"0.4.0",status:"available",reason:null,releaseUrl:"https://github.com/Inginnng/arki/releases/tag/v0.4.0",checkedAt:"2026-09-09T00:00:00.000Z"})}));vi.stubGlobal("fetch",fetcher);
 render(<UpdatePanel/>);expect(fetcher).not.toHaveBeenCalled();fireEvent.click(screen.getByLabelText("版本与更新"));fireEvent.click(screen.getByRole("button",{name:"检查更新"}));
 expect((await screen.findByRole("link",{name:/查看更新说明与下载/})).getAttribute("href")).toBe("https://github.com/Inginnng/arki/releases/tag/v0.4.0");expect(fetcher).toHaveBeenCalledTimes(1);
});
it("retains a useful error and allows retry when the backend is offline",async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>{throw Error("offline");}));render(<UpdatePanel/>);fireEvent.click(screen.getByLabelText("版本与更新"));fireEvent.click(screen.getByRole("button",{name:"检查更新"}));
 await screen.findByText(/暂时无法检查更新/);await waitFor(()=>expect((screen.getByRole("button",{name:"检查更新"}) as HTMLButtonElement).disabled).toBe(false));expect(screen.queryByText("当前已是最新正式版")).toBeNull();
});
