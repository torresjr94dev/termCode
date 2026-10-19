import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and Rust build output
      ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"],
    },
  },

  // Dependencias que solo se cargan bajo demanda (editor, resaltado): se
  // pre-empaquetan al arrancar para que Vite no las descubra a mitad de sesión
  // y recargue la página (en Tauri eso reinicia las terminales).
  optimizeDeps: {
    include: [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/search",
      "@codemirror/autocomplete",
      "@lezer/highlight",
      "highlight.js/lib/core",
      "@codemirror/lang-css",
      "@codemirror/lang-html",
      "@codemirror/lang-javascript",
      "@codemirror/lang-json",
      "@codemirror/lang-markdown",
      "@codemirror/lang-python",
      "@codemirror/lang-rust",
      "@codemirror/lang-yaml",
      "@codemirror/legacy-modes/mode/dockerfile",
      "@codemirror/legacy-modes/mode/go",
      "@codemirror/legacy-modes/mode/shell",
      "@codemirror/legacy-modes/mode/sql",
      "@codemirror/legacy-modes/mode/swift",
      "@codemirror/legacy-modes/mode/toml",
      "highlight.js/lib/languages/bash",
      "highlight.js/lib/languages/c",
      "highlight.js/lib/languages/cpp",
      "highlight.js/lib/languages/csharp",
      "highlight.js/lib/languages/css",
      "highlight.js/lib/languages/dockerfile",
      "highlight.js/lib/languages/go",
      "highlight.js/lib/languages/ini",
      "highlight.js/lib/languages/java",
      "highlight.js/lib/languages/javascript",
      "highlight.js/lib/languages/json",
      "highlight.js/lib/languages/kotlin",
      "highlight.js/lib/languages/makefile",
      "highlight.js/lib/languages/markdown",
      "highlight.js/lib/languages/php",
      "highlight.js/lib/languages/python",
      "highlight.js/lib/languages/ruby",
      "highlight.js/lib/languages/rust",
      "highlight.js/lib/languages/scss",
      "highlight.js/lib/languages/sql",
      "highlight.js/lib/languages/swift",
      "highlight.js/lib/languages/typescript",
      "highlight.js/lib/languages/xml",
      "highlight.js/lib/languages/yaml",
    ],
  },

  build: {
    // System webviews: WKWebView (Safari 16.4+), WebView2 (Chromium), WebKitGTK.
    target: ["safari16.4", "chrome111"],
    cssMinify: "lightningcss" as const,
    reportCompressedSize: false,
  },
}));
