import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("缺少 AIMD Reader 根元素");

createRoot(root).render(<StrictMode><App /></StrictMode>);
