import React, { useEffect, useMemo, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { imageKind, lineFromFragment, linkKind, parseMarkdown, resolveRelative, type MdNode } from "../../../lib/markdown";
import { gitApi } from "../../../lib/git";
import { imageMime, openExternal, openFile, projectRoot } from "../../../lib/project";
import { useHighlighter } from "../../../lib/highlight";
import { cn } from "../../../lib/layout";
import { Segments } from "./parts";

/** Imágenes relativas que se cargan como máximo (un README con cien capturas no traba el visor). */
const MAX_IMAGES = 30;

/** ```ts, ```bash… → una ruta ficticia para el resaltador (que elige por extensión). */
const FENCE_EXT: Record<string, string> = {
  typescript: "ts", javascript: "js", python: "py", rust: "rs", shell: "sh", console: "sh", zsh: "sh",
  golang: "go", yml: "yaml", jsonc: "json", html: "html", ruby: "rb", kotlin: "kt", csharp: "cs",
};

const CodeBlock: React.FC<{ lang?: string; code: string }> = ({ lang, code }) => {
  const key = lang?.toLowerCase();
  const highlight = useHighlighter(key ? `bloque.${FENCE_EXT[key] ?? key}` : null);
  const lines = useMemo(() => highlight?.(code) ?? null, [highlight, code]);
  return (
    <pre className="my-3 overflow-x-auto rounded-md border border-line bg-raised px-3.5 py-3 font-mono text-[12px] leading-[1.6] text-ink">
      <code>
        {lines
          ? lines.map((segments, i) => (
              <React.Fragment key={i}>
                {i > 0 && "\n"}
                <Segments segments={segments} />
              </React.Fragment>
            ))
          : code}
      </code>
    </pre>
  );
};

/** Imágenes relativas del Markdown: se leen del proyecto (el CSP no deja cargar otras rutas). */
function useProjectImages(nodes: MdNode[], fromFile: string) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const sources = useMemo(() => {
    const found = new Set<string>();
    const walk = (list: MdNode[]) => {
      for (const node of list) {
        if (node.type !== "element") continue;
        if (node.tag === "img" && node.attrs.src && imageKind(node.attrs.src) === "relative") found.add(node.attrs.src);
        walk(node.children);
      }
    };
    walk(nodes);
    return [...found].slice(0, MAX_IMAGES);
  }, [nodes]);

  useEffect(() => {
    const root = projectRoot();
    if (!root || !sources.length) return;
    let alive = true;
    const created: string[] = [];
    void (async () => {
      for (const src of sources) {
        const target = resolveRelative(fromFile, src);
        const mime = target ? imageMime(target.path) : null;
        if (!target || !mime) continue;
        try {
          const bytes = await gitApi.readImage(root, target.path);
          if (!alive) return;
          const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
          created.push(url);
          setUrls((current) => ({ ...current, [src]: url }));
        } catch {
          // Imagen que no está o no se puede mostrar: queda su texto alternativo.
        }
      }
    })();
    return () => {
      alive = false;
      created.forEach((url) => URL.revokeObjectURL(url));
      setUrls({});
    };
  }, [sources, fromFile]);

  return urls;
}

/**
 * Markdown renderizado con elementos de React (nada de HTML inyectado). Los
 * enlaces nunca navegan el webview: los externos van al navegador, las anclas
 * se desplazan y las rutas relativas abren el archivo en el visor.
 */
export const MarkdownPreview: React.FC<{ path: string; text: string }> = ({ path, text }) => {
  const nodes = useMemo(() => parseMarkdown(text), [text]);
  const images = useProjectImages(nodes, path);
  const container = useRef<HTMLDivElement | null>(null);

  const follow = (href: string) => {
    const kind = linkKind(href);
    if (kind === "external") {
      openExternal(href);
    } else if (kind === "anchor") {
      const id = decodeURIComponent(href.slice(1));
      container.current?.querySelector(`[id="md-${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    } else if (kind === "relative") {
      const target = resolveRelative(path, href);
      if (target?.path) void openFile(target.path, { line: lineFromFragment(target.fragment) });
    }
  };

  const render = (list: MdNode[], keyPrefix: string): React.ReactNode[] =>
    list.map((node, i) => {
      const key = `${keyPrefix}${i}`;
      if (node.type === "text") return node.text;
      const kids = () => render(node.children, `${key}.`);
      const { attrs } = node;
      switch (node.tag) {
        case "h1":
          return <h1 key={key} id={attrs.id && `md-${attrs.id}`} className="mb-3 mt-7 border-b border-line pb-2 text-[22px] font-semibold leading-tight text-ink first:mt-0">{kids()}</h1>;
        case "h2":
          return <h2 key={key} id={attrs.id && `md-${attrs.id}`} className="mb-2.5 mt-7 border-b border-line pb-1.5 text-[17px] font-semibold leading-tight text-ink first:mt-0">{kids()}</h2>;
        case "h3":
          return <h3 key={key} id={attrs.id && `md-${attrs.id}`} className="mb-2 mt-5 text-[14.5px] font-semibold text-ink first:mt-0">{kids()}</h3>;
        case "h4":
        case "h5":
        case "h6":
          return React.createElement(node.tag, { key, id: attrs.id && `md-${attrs.id}`, className: "mb-1.5 mt-4 text-[13.5px] font-semibold text-ink" }, kids());
        case "p":
          return <p key={key} className="my-2.5 leading-[1.7]">{kids()}</p>;
        case "blockquote":
          return <blockquote key={key} className="my-3 border-l-2 border-accent/50 pl-3.5 text-ink-3">{kids()}</blockquote>;
        case "ul":
          return <ul key={key} className="my-2.5 list-disc pl-6 marker:text-ink-3">{kids()}</ul>;
        case "ol":
          return <ol key={key} start={attrs.start} className="my-2.5 list-decimal pl-6 marker:text-ink-3">{kids()}</ol>;
        case "li": {
          const task = node.children[0]?.type === "element" && node.children[0].tag === "input";
          return <li key={key} className={cn("my-1 leading-[1.65]", task && "-ml-5 list-none")}>{kids()}</li>;
        }
        case "input":
          return <input key={key} type="checkbox" checked={Boolean(attrs.checked)} disabled readOnly className="mr-2 align-middle accent-[var(--color-accent)]" />;
        case "pre": {
          const code = node.children[0];
          const source = code?.type === "element" ? code.children.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
          return <CodeBlock key={key} lang={code?.type === "element" ? code.attrs.lang : undefined} code={source} />;
        }
        case "code":
          return <code key={key} className="rounded bg-raised px-1 py-px font-mono text-[0.88em] text-ink">{kids()}</code>;
        case "em":
          return <em key={key}>{kids()}</em>;
        case "strong":
          return <strong key={key} className="font-semibold text-ink">{kids()}</strong>;
        case "s":
          return <s key={key}>{kids()}</s>;
        case "a": {
          const href = attrs.href;
          if (!href) return <span key={key}>{kids()}</span>;
          // Sin `href` real: el webview no tiene nada que abrir, arrastrar ni navegar.
          return (
            <a
              key={key}
              role="link"
              tabIndex={0}
              data-href={href}
              title={attrs.title ?? href}
              onClick={(e) => {
                e.preventDefault();
                follow(href);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                follow(href);
              }}
              className="cursor-pointer text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              {kids()}
            </a>
          );
        }
        case "img": {
          const src = attrs.src;
          const kind = src ? imageKind(src) : "blocked";
          const url = src ? (kind === "data" ? src : images[src]) : undefined;
          if (url) return <img key={key} src={url} alt={attrs.alt ?? ""} title={attrs.title} draggable={false} className="my-2 inline-block max-w-full rounded" />;
          return (
            <span key={key} title={kind === "remote" ? `Imagen remota (no se descarga): ${src}` : src} className="inline-flex items-center gap-1 rounded border border-dashed border-line px-1.5 py-0.5 text-[12px] text-ink-3">
              <ImageOff size={12} strokeWidth={1.75} aria-hidden="true" />
              {attrs.alt || "imagen"}
            </span>
          );
        }
        case "hr":
          return <hr key={key} className="my-6 border-line" />;
        case "br":
          return <br key={key} />;
        case "table":
          return (
            <div key={key} className="my-3 overflow-x-auto">
              <table className="border-collapse text-[12.5px]">{kids()}</table>
            </div>
          );
        case "thead":
          return <thead key={key}>{kids()}</thead>;
        case "tbody":
          return <tbody key={key}>{kids()}</tbody>;
        case "tr":
          return <tr key={key} className="even:bg-raised/60">{kids()}</tr>;
        case "th":
          return <th key={key} style={{ textAlign: attrs.align }} className="border border-line bg-raised px-2.5 py-1.5 font-semibold text-ink">{kids()}</th>;
        case "td":
          return <td key={key} style={{ textAlign: attrs.align }} className="border border-line px-2.5 py-1.5">{kids()}</td>;
        default:
          return <React.Fragment key={key}>{kids()}</React.Fragment>;
      }
    });

  return (
    <div ref={container} className="mx-auto w-full max-w-[860px] select-text px-8 py-6 font-sans text-[13.5px] text-ink-2">
      {nodes.length ? render(nodes, "") : <p className="text-ink-3">Archivo vacío.</p>}
    </div>
  );
};
