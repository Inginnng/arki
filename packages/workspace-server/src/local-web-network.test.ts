import { describe, expect, it, vi } from "vitest";
import { configureLocalWebProxy } from "./local-web-network.js";
const settings = (server = "127.0.0.1:7890", enabled = "0x1") => `\r\n    ProxyEnable    REG_DWORD    ${enabled}\r\n    ProxyServer    REG_SZ    ${server}\r\n`;
describe("local web child proxy configuration", () => {
  it("inherits the enabled Windows proxy and preserves loopback access in this process", () => {
    const environment = { no_proxy: "example.test" } as NodeJS.ProcessEnv;
    expect(configureLocalWebProxy({ environment, platform: "win32", readWindowsSettings: () => settings() })).toBe("windows");
    expect(environment.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(environment.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(environment.NO_PROXY).toContain("example.test,localhost,127.0.0.1,::1");
  });
  it.each(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "https_proxy"])("preserves explicit %s without reading Windows settings", key => {
    const environment = { [key]: "http://explicit.test:8080" }; const readWindowsSettings = vi.fn();
    expect(configureLocalWebProxy({ environment, platform: "win32", readWindowsSettings })).toBe("explicit");
    expect(environment).toEqual({ [key]: "http://explicit.test:8080" }); expect(readWindowsSettings).not.toHaveBeenCalled();
  });
  it("respects per-protocol proxy settings", () => {
    const environment = {} as NodeJS.ProcessEnv;
    configureLocalWebProxy({ environment, platform: "win32", readWindowsSettings: () => settings("http=proxy.test:80;https=secure.test:8080;socks=127.0.0.1:1080") });
    expect(environment.HTTP_PROXY).toBe("http://proxy.test"); expect(environment.HTTPS_PROXY).toBe("http://secure.test:8080");
  });
  it.each([settings("", "0x0"), settings("user:password@proxy.test:80"), settings("socks=127.0.0.1:1080"), settings("proxy.test:80/path"), ""])("ignores disabled, unsupported or malformed proxy settings", raw => {
    const environment = {}; expect(configureLocalWebProxy({ environment, platform: "win32", readWindowsSettings: () => raw })).toBe("unchanged"); expect(environment).toEqual({});
  });
  it("does not query Windows settings on other platforms or fail startup on registry errors", () => {
    const readWindowsSettings = vi.fn(() => { throw Error("unavailable"); });
    expect(configureLocalWebProxy({ environment: {}, platform: "linux", readWindowsSettings })).toBe("unchanged"); expect(readWindowsSettings).not.toHaveBeenCalled();
    expect(configureLocalWebProxy({ environment: {}, platform: "win32", readWindowsSettings })).toBe("unchanged");
  });
});
