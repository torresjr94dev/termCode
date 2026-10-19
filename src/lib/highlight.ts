/**
 * Resaltado de sintaxis con highlight.js, cargado bajo demanda (núcleo y cada
 * lenguaje en su propio chunk).
 *
 * La salida HTML de highlight.js nunca llega al DOM: se convierte en
 * segmentos `{text, cls}` que React escapa al pintar. Si la salida no tiene
 * la forma esperada, se pinta sin color.
 */
import { useEffect, useState } from "react";
import type { HLJSApi, LanguageFn } from "highlight.js";

export interface Segment {
  text: string;
  cls?: string;
}

export type Highlighter = (code: string) => Segment[][] | null;

type Loader = () => Promise<{ default: LanguageFn }>;

const LANGUAGES: Record<string, Loader> = {
  typescript: () => import("highlight.js/lib/languages/typescript"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  rust: () => import("highlight.js/lib/languages/rust"),
  python: () => import("highlight.js/lib/languages/python"),
  go: () => import("highlight.js/lib/languages/go"),
  json: () => import("highlight.js/lib/languages/json"),
  css: () => import("highlight.js/lib/languages/css"),
  scss: () => import("highlight.js/lib/languages/scss"),
  xml: () => import("highlight.js/lib/languages/xml"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  ini: () => import("highlight.js/lib/languages/ini"),
  bash: () => import("highlight.js/lib/languages/bash"),
  sql: () => import("highlight.js/lib/languages/sql"),
  java: () => import("highlight.js/lib/languages/java"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  swift: () => import("highlight.js/lib/languages/swift"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  php: () => import("highlight.js/lib/languages/php"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
};

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  rs: "rust", py: "python", go: "go",
  json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "scss", sass: "scss", less: "scss",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", plist: "xml",
  md: "markdown", mdx: "markdown",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", env: "ini",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", m: "c", mm: "cpp",
  cs: "csharp", rb: "ruby", php: "php",
};

const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  ".zshrc": "bash",
  ".bashrc": "bash",
  ".zprofile": "bash",
  ".gitconfig": "ini",
  ".editorconfig": "ini",
  "cargo.lock": "ini",
};

/** Lenguaje de highlight.js para una ruta, o null si no lo conocemos. */
export function languageFor(path: string): string | null {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith("dockerfile")) return "dockerfile";
  if (name.startsWith(".env")) return "ini";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (BY_EXTENSION[name.slice(dot + 1)] ?? null) : null;
}

let core: Promise<HLJSApi> | null = null;
const loading = new Map<string, Promise<void>>();

function loadCore(): Promise<HLJSApi> {
  core ??= import("highlight.js/lib/core").then((m) => m.default);
  return core;
}

function loadLanguage(hljs: HLJSApi, language: string): Promise<void> {
  let pending = loading.get(language);
  if (!pending) {
    const loader = LANGUAGES[language];
    pending = loader
      ? loader().then((m) => hljs.registerLanguage(language, m.default))
      : Promise.reject(new Error(`Lenguaje sin cargador: ${language}`));
    loading.set(language, pending);
  }
  return pending;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const decode = (text: string) => text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e]);

/** `hljs-title function_` → `tok-title`. */
const tokenClass = (classes: string) => {
  const first = classes.split(" ")[0];
  return first.startsWith("hljs-") ? `tok-${first.slice(5)}` : undefined;
};

/**
 * Convierte la salida de highlight.js en líneas de segmentos. Solo acepta
 * `<span class="…">`, `</span>` y texto escapado; cualquier otra cosa → null.
 */
export function toLines(html: string): Segment[][] | null {
  const lines: Segment[][] = [[]];
  const stack: Array<string | undefined> = [];
  const token = /<span class="([\w\- ]+)">|<\/span>|([^<]+)/g;
  let expected = 0;
  for (let m = token.exec(html); m; m = token.exec(html)) {
    if (m.index !== expected) return null;
    expected = token.lastIndex;
    if (m[1] !== undefined) {
      stack.push(tokenClass(m[1]));
    } else if (m[2] === undefined) {
      if (!stack.length) return null;
      stack.pop();
    } else {
      const cls = stack[stack.length - 1];
      decode(m[2])
        .split("\n")
        .forEach((part, i) => {
          if (i > 0) lines.push([]);
          if (part) lines[lines.length - 1].push(cls ? { text: part, cls } : { text: part });
        });
    }
  }
  return expected === html.length && !stack.length ? lines : null;
}

/**
 * Resaltador síncrono para la ruta dada, disponible cuando su lenguaje
 * terminó de cargar (antes: null, y se pinta sin color).
 */
export function useHighlighter(path: string | null): Highlighter | null {
  const language = path ? languageFor(path) : null;
  const [ready, setReady] = useState<{ language: string; run: Highlighter } | null>(null);

  useEffect(() => {
    if (!language) return;
    let alive = true;
    loadCore()
      .then(async (hljs) => {
        await loadLanguage(hljs, language);
        const run: Highlighter = (code) => {
          try {
            return toLines(hljs.highlight(code, { language, ignoreIllegals: true }).value);
          } catch {
            return null;
          }
        };
        if (alive) setReady({ language, run });
      })
      .catch(() => {
        // Sin resaltado: el visor sigue funcionando en texto plano.
      });
    return () => {
      alive = false;
    };
  }, [language]);

  return ready && ready.language === language ? ready.run : null;
}
