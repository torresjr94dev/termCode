/**
 * Markdown → árbol de nodos que la vista pinta con React.
 *
 * markdown-it solo parsea (con `html: false`: el HTML del archivo queda como
 * texto). Su salida HTML nunca llega al DOM: los tokens se convierten en
 * nodos con una lista cerrada de etiquetas y atributos, y React escapa el
 * texto. Los enlaces solo pueden ser http(s), mailto, anclas o rutas
 * relativas; las imágenes, rutas relativas (se leen del proyecto) o data:.
 */
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";

export type MdNode =
  | { type: "text"; text: string }
  | { type: "element"; tag: MdTag; attrs: MdAttrs; children: MdNode[] };

export type MdTag =
  | "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "ul" | "ol" | "li"
  | "pre" | "code" | "em" | "strong" | "s" | "a" | "img" | "hr" | "br"
  | "table" | "thead" | "tbody" | "tr" | "th" | "td" | "input";

export interface MdAttrs {
  href?: string;
  src?: string;
  alt?: string;
  title?: string;
  id?: string;
  start?: number;
  align?: "left" | "right" | "center";
  /** Lenguaje de un bloque de código (```ts). */
  lang?: string;
  /** Lista de tareas: `- [x] hecho`. */
  checked?: boolean;
}

const TAGS = new Set<string>([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "pre", "code", "em", "strong", "s",
  "a", "img", "hr", "br", "table", "thead", "tbody", "tr", "th", "td",
]);

let parser: MarkdownIt | null = null;
const md = () => (parser ??= new MarkdownIt({ html: false, linkify: true, typographer: false }));

const text = (value: string): MdNode => ({ type: "text", text: value });
const element = (tag: MdTag, attrs: MdAttrs = {}, children: MdNode[] = []): MdNode => ({ type: "element", tag, attrs, children });

export type LinkKind = "external" | "anchor" | "relative" | "blocked";

/** Qué es un enlace (y si se puede seguir). */
export function linkKind(href: string): LinkKind {
  const value = href.trim();
  if (!value) return "blocked";
  if (value.startsWith("#")) return "anchor";
  if (/^(https?:|mailto:)/i.test(value)) return "external";
  // Cualquier otro esquema (javascript:, file:, data:, vbscript:…) no se sigue.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return "blocked";
  return "relative";
}

/** Imagen que se puede mostrar: relativa (se lee del proyecto) o data: de un formato de imagen. */
export function imageKind(src: string): "relative" | "data" | "remote" | "blocked" {
  const value = src.trim();
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(value)) return "data";
  if (/^https?:/i.test(value)) return "remote";
  return linkKind(value) === "relative" ? "relative" : "blocked";
}

/** `## Cómo instalar` → `cómo-instalar` (como las anclas de GitHub). */
export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function plain(nodes: MdNode[]): string {
  return nodes.map((n) => (n.type === "text" ? n.text : plain(n.children))).join("");
}

function attrsOf(token: Token): MdAttrs {
  const attrs: MdAttrs = {};
  const get = (name: string) => token.attrGet(name) ?? undefined;
  const href = get("href");
  if (href !== undefined) attrs.href = linkKind(href) === "blocked" ? undefined : href;
  const title = get("title");
  if (title) attrs.title = title;
  const start = Number(get("start"));
  if (token.tag === "ol" && Number.isInteger(start) && start !== 1) attrs.start = start;
  const align = /text-align:\s*(left|right|center)/.exec(get("style") ?? "")?.[1];
  if (align) attrs.align = align as MdAttrs["align"];
  return attrs;
}

/** `[ ] ` / `[x] ` al principio de un elemento de lista: casilla de tarea. */
function taskify(item: MdNode) {
  if (item.type !== "element") return;
  let holder: MdNode | undefined = item;
  while (holder?.type === "element" && holder.children[0]?.type === "element" && holder.children[0].tag === "p") holder = holder.children[0];
  const first = holder?.type === "element" ? holder.children[0] : undefined;
  if (holder?.type !== "element" || first?.type !== "text") return;
  const match = /^\[([ xX])\]\s+/.exec(first.text);
  if (!match) return;
  holder.children[0] = text(first.text.slice(match[0].length));
  holder.children.unshift(element("input", { checked: match[1] !== " " }));
}

function build(tokens: Token[], slugs: Map<string, number>): MdNode[] {
  const root: MdNode[] = [];
  const stack: MdNode[][] = [root];
  const current = () => stack[stack.length - 1];

  for (const token of tokens) {
    if (token.nesting === 1) {
      // Párrafos de listas compactas: sin <p>, el texto va directo al elemento.
      if (token.hidden || !TAGS.has(token.tag)) {
        stack.push(current());
        continue;
      }
      const node = element(token.tag as MdTag, attrsOf(token));
      current().push(node);
      stack.push(node.type === "element" ? node.children : []);
      continue;
    }
    if (token.nesting === -1) {
      const children = stack.pop();
      const parent = current();
      const node = parent[parent.length - 1];
      if (node?.type === "element" && node.children === children) {
        if (/^h[1-6]$/.test(node.tag)) {
          const base = slugify(plain(node.children)) || "seccion";
          const seen = slugs.get(base) ?? 0;
          slugs.set(base, seen + 1);
          node.attrs.id = seen ? `${base}-${seen}` : base;
        } else if (node.tag === "li") {
          taskify(node);
        }
      }
      continue;
    }
    switch (token.type) {
      case "inline":
        current().push(...build(token.children ?? [], slugs));
        break;
      case "code_inline":
        current().push(element("code", {}, [text(token.content)]));
        break;
      case "softbreak":
        current().push(text("\n"));
        break;
      case "hardbreak":
        current().push(element("br"));
        break;
      case "fence":
      case "code_block": {
        const lang = token.info.trim().split(/\s+/)[0] || undefined;
        current().push(element("pre", {}, [element("code", { lang }, [text(token.content.replace(/\n$/, ""))])]));
        break;
      }
      case "hr":
        current().push(element("hr"));
        break;
      case "image": {
        const alt = plain(build(token.children ?? [], slugs));
        const src = token.attrGet("src") ?? "";
        current().push(element("img", { src: imageKind(src) === "blocked" ? undefined : src, alt, title: token.attrGet("title") ?? undefined }));
        break;
      }
      default:
        // text, html_inline/html_block (con html:false no aparecen) y lo que venga: como texto.
        if (token.content) current().push(text(token.content));
    }
  }
  return root;
}

export function parseMarkdown(source: string): MdNode[] {
  return build(md().parse(source, {}), new Map());
}

/** Línea `#L12` de un enlace relativo a la manera de GitHub. */
export function lineFromFragment(fragment: string): number | undefined {
  const match = /^L(\d+)$/.exec(fragment);
  return match ? Number(match[1]) : undefined;
}

/**
 * Un enlace relativo dentro del proyecto: `../docs/a.md#L3` desde `src/x.md`
 * → `{ path: "docs/a.md", fragment: "L3" }`. Fuera de la raíz: null.
 */
export function resolveRelative(fromFile: string, href: string): { path: string; fragment: string } | null {
  const [rawPath, ...rest] = href.split("#");
  const fragment = rest.join("#");
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath.split("?")[0]);
  } catch {
    return null;
  }
  const base = decoded.startsWith("/") ? [] : fromFile.split("/").slice(0, -1);
  const parts = [...base];
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return { path: parts.join("/"), fragment };
}
