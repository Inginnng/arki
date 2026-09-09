import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { createMockReaderHost } from "./mock-host.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("缺少 AIMD Reader 根元素");

createRoot(root).render(
  <StrictMode>
    <App
      host={createMockReaderHost()}
      backendStatus={{
        kind: "mock",
        label: "模拟后端 · 固定数据 · 不会调用 Codex",
        detail: "仅用于界面与浏览器自动化测试。",
      }}
    />
  </StrictMode>,
);
