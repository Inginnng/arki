import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    target: "es2022",
    cssMinify: true,
    assetsInlineLimit: 100_000_000,
    outDir: "dist",
    emptyOutDir: true,
  },
});
