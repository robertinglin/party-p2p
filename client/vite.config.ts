import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ command }) => ({
  root: path.resolve(__dirname),
  base: command === "build" ? process.env.VITE_BASE || "/party-p2p/" : "/",
  plugins: [react()],
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    port: 42729,
    allowedHosts: ["robertinglin.github.io"]
  }
}));
