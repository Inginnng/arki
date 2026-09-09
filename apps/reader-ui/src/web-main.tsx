import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Workbench } from "./Workbench.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("缺少 AIMD Reader 根元素");

createRoot(root).render(
  <StrictMode>
    <Workbench />
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/arki-sw.js").catch(() => undefined);
}
