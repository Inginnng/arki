import { useEffect, useRef, useState } from "react";
import { ARKI_VERSION, ARKI_REPOSITORY_URL, UpdateCheckSchema, type UpdateCheck } from "@aimd/contracts";
import "./update-panel.css";

export function UpdatePanel() {
  const [result,setResult]=useState<UpdateCheck|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const pending=useRef<AbortController|null>(null);
  useEffect(()=>()=>pending.current?.abort(),[]);
  const check=async()=>{
    if(pending.current)return;
    const controller=new AbortController();pending.current=controller;setBusy(true);setError("");
    try{
      const response=await fetch("/api/updates",{cache:"no-store",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])});
      if(!response.ok)throw Error();
      const next=UpdateCheckSchema.parse(await response.json());
      if(!controller.signal.aborted)setResult(next);
    }catch{if(!controller.signal.aborted){setResult(null);setError("暂时无法检查更新。请确认本地后台已启动，或直接查看 GitHub 发行版。");}}
    finally{if(!controller.signal.aborted)setBusy(false);pending.current=null;}
  };
  const status=result?.status;
  const message=status==="available"?`发现新版本 v${result?.latestVersion}`:status==="up_to_date"?"当前已是最新正式版":status==="ahead"?`当前版本高于最新正式版 v${result?.latestVersion}`:status==="no_release"?"尚未找到公开正式版，或仓库暂不可访问。":status==="unavailable"?(result?.reason==="rate_limited"?"GitHub 请求额度暂时受限，请稍后再试。":result?.reason==="invalid_response"?"发行版信息未通过检查，请直接查看 GitHub。":"无法连接 GitHub，暂时不能确认是否有更新。"):"按需检查 GitHub 正式发行版。";
  return <details className="arki-updates">
    <summary aria-label="版本与更新">v{ARKI_VERSION}</summary>
    <section className="arki-update-panel" aria-label="Arki 版本与更新">
      <strong>Arki · 一览 <span>v{ARKI_VERSION}</span></strong>
      <p aria-live="polite">{busy?"正在检查…":error||message}</p>
      {result&&result.currentVersion!==ARKI_VERSION?<p className="arki-update-warning">后台版本为 v{result.currentVersion}，请保存阅读进度后刷新页面。</p>:null}
      {result?.releaseUrl?<a className="arki-release-link" href={result.releaseUrl} target="_blank" rel="noopener noreferrer">{status==="available"?"查看更新说明与下载":"查看发行说明"} ↗</a>:null}
      <button type="button" disabled={busy} onClick={()=>void check()}>{busy?"检查中…":"检查更新"}</button>
      <small>只读取公开版本信息，不发送项目内容。检查结果缓存 10 分钟；不会自动安装或重启。</small>
      <footer><a href={ARKI_REPOSITORY_URL} target="_blank" rel="noopener noreferrer">GitHub</a><a href={`${ARKI_REPOSITORY_URL}/blob/main/docs/updates.md`} target="_blank" rel="noopener noreferrer">更新指南</a>{result?<time dateTime={result.checkedAt}>检查于 {new Date(result.checkedAt).toLocaleTimeString()}</time>:null}</footer>
    </section>
  </details>;
}
