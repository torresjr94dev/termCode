/**
 * Editor de archivos (CodeMirror 6). Este módulo se importa bajo demanda: no
 * pesa en el arranque de la app. Colores y fuente salen de las variables CSS
 * del tema activo, así que cambia de tema junto con todo lo demás.
 */
import { Compartment, EditorSelection, EditorState, type Extension, type Text } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";

type LanguageLoader = () => Promise<Extension>;

const LANGUAGES: Record<string, LanguageLoader> = {
  ts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
  tsx: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
  js: async () => (await import("@codemirror/lang-javascript")).javascript(),
  jsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  rs: async () => (await import("@codemirror/lang-rust")).rust(),
  py: async () => (await import("@codemirror/lang-python")).python(),
  json: async () => (await import("@codemirror/lang-json")).json(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  md: async () => (await import("@codemirror/lang-markdown")).markdown(),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  sh: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell),
  toml: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml),
  go: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/go")).go),
  sql: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/sql")).standardSQL),
  swift: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/swift")).swift),
  dockerfile: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile),
};

const ALIASES: Record<string, string> = {
  mts: "ts", cts: "ts", mjs: "js", cjs: "js", jsonc: "json", json5: "json",
  scss: "css", less: "css", htm: "html", vue: "html", svg: "html", xml: "html",
  markdown: "md", mdx: "md", yml: "yaml", bash: "sh", zsh: "sh", env: "sh",
};

function languageKey(path: string): string | null {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if ([".zshrc", ".bashrc", ".zprofile", ".profile"].includes(name) || name.startsWith(".env")) return "sh";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const key = ALIASES[ext] ?? ext;
  return key in LANGUAGES ? key : null;
}

/** Mismos tonos que el resto del visor (index.css → --syn-*). */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.url], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.heading], color: "var(--syn-title)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: "var(--syn-attr)" },
  { tag: [t.meta, t.tagName, t.processingInstruction, t.annotation], color: "var(--syn-meta)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--color-ink-3)", fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.invalid, color: "var(--color-signal)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--color-canvas)", color: "var(--color-ink)", fontSize: "12px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "20px" },
  ".cm-content": { caretColor: "var(--color-accent)", paddingBottom: "40vh" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 24%, transparent)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--color-hover) 55%, transparent)" },
  ".cm-gutters": { backgroundColor: "var(--color-canvas)", color: "var(--color-ink-3)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-ink-2)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px", minWidth: "48px" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--color-accent) 22%, transparent)", outline: "none" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--color-ink) 10%, transparent)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--color-accent) 22%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--color-accent) 45%, transparent)" },
  ".cm-panels": { backgroundColor: "var(--color-chrome)", color: "var(--color-ink-2)", fontFamily: "var(--font-sans)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--color-line)" },
  ".cm-panel.cm-search": { padding: "6px 10px", fontSize: "12px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "12px" },
  ".cm-textfield": {
    backgroundColor: "var(--color-canvas)",
    color: "var(--color-ink)",
    border: "1px solid var(--color-line-strong)",
    borderRadius: "4px",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--color-raised)",
    color: "var(--color-ink-2)",
    border: "1px solid var(--color-line)",
    borderRadius: "4px",
  },
  ".cm-flash-line": { backgroundColor: "color-mix(in srgb, var(--color-accent) 18%, transparent)" },
});

export interface EditorOptions {
  doc: string;
  path: string;
  readOnly: boolean;
  /** Línea a la que saltar al abrir (1 = primera). */
  line?: number;
  onDirtyChange: (dirty: boolean) => void;
  onSave: () => void;
}

/** Foto inmutable del documento: lo que se manda a guardar. */
export interface Snapshot {
  text: string;
  doc: Text;
}

export interface EditorHandle {
  snapshot(): Snapshot;
  /** Reemplaza el contenido (recarga desde disco) conservando el cursor si se puede. */
  replaceText(text: string): void;
  /**
   * Esa foto ya está en disco. Si se siguió escribiendo mientras se guardaba,
   * el editor sigue marcado con cambios.
   */
  markSaved(snapshot: Snapshot): void;
  isDirty(): boolean;
  goToLine(line: number): void;
  setReadOnly(readOnly: boolean): void;
  focus(): void;
  destroy(): void;
}

export function createEditor(parent: HTMLElement, options: EditorOptions): EditorHandle {
  const language = new Compartment();
  const editable = new Compartment();
  let saved: Text | null = null;
  let dirty = false;

  const setDirty = (next: boolean) => {
    if (next === dirty) return;
    dirty = next;
    options.onDirtyChange(next);
  };

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: options.doc,
      extensions: [
        // Un archivo CRLF se guarda CRLF: sin esto CodeMirror lo normalizaría a LF.
        options.doc.includes("\r\n") ? EditorState.lineSeparator.of("\r\n") : [],
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(highlight),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (options.onSave(), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        theme,
        language.of([]),
        editable.of([EditorState.readOnly.of(options.readOnly), EditorView.editable.of(!options.readOnly)]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && saved) setDirty(!update.state.doc.eq(saved));
        }),
        EditorView.contentAttributes.of({ "aria-label": `Editor de ${options.path}` }),
      ],
    }),
  });
  saved = view.state.doc;

  const key = languageKey(options.path);
  if (key) {
    LANGUAGES[key]()
      .then((ext) => view.dispatch({ effects: language.reconfigure(ext) }))
      .catch(() => {
        // Sin resaltado: el editor funciona igual.
      });
  }

  const goToLine = (line: number) => {
    const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
    view.dispatch({
      selection: EditorSelection.cursor(target.from),
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
  };
  if (options.line) goToLine(options.line);

  return {
    snapshot: () => ({ text: view.state.doc.toString(), doc: view.state.doc }),
    replaceText(text) {
      const head = view.state.selection.main.head;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: EditorSelection.cursor(Math.min(head, text.length)),
      });
      saved = view.state.doc;
      setDirty(false);
    },
    markSaved(snapshot) {
      saved = snapshot.doc;
      setDirty(!view.state.doc.eq(snapshot.doc));
    },
    isDirty: () => dirty,
    goToLine,
    setReadOnly(readOnly) {
      view.dispatch({
        effects: editable.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
