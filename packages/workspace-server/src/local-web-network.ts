import { execFileSync } from "node:child_process";

const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const registryKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const readSettings = () => execFileSync("reg.exe", ["query", registryKey], { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 65536 });

function proxyUrl(value: string | undefined): string | undefined {
  if (!value || /[\s\u0000-\u001f]/u.test(value)) return;
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return;
    return url.origin;
  } catch { return; }
}

/** Local web process only. Never change Windows, user config, or an explicit proxy environment. */
export function configureLocalWebProxy(options: { environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; readWindowsSettings?: () => string } = {}): "explicit" | "windows" | "unchanged" {
  const environment = options.environment ?? process.env;
  if (proxyKeys.some(key => environment[key]?.trim())) return "explicit";
  if ((options.platform ?? process.platform) !== "win32") return "unchanged";
  let settings: string;
  try { settings = (options.readWindowsSettings ?? readSettings)(); } catch { return "unchanged"; }
  if (!/^\s*ProxyEnable\s+REG_DWORD\s+0x1\s*$/imu.test(settings)) return "unchanged";
  const server = /^\s*ProxyServer\s+REG_SZ\s+(.+?)\s*$/imu.exec(settings)?.[1];
  if (!server) return "unchanged";
  const protocols = new Map(server.split(";").map(part => { const [key, value] = part.trim().split("=", 2); return [key!, value] as const; }));
  const http = proxyUrl(server.includes("=") ? protocols.get("http") : server);
  const https = proxyUrl(server.includes("=") ? protocols.get("https") : server);
  if (!http && !https) return "unchanged";
  if (http) environment.HTTP_PROXY = http;
  if (https) environment.HTTPS_PROXY = https;
  const bypass = [environment.NO_PROXY, environment.no_proxy, "localhost", "127.0.0.1", "::1"].filter(Boolean).join(",");
  environment.NO_PROXY = bypass;
  environment.no_proxy = bypass;
  return "windows";
}
