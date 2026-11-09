import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { BookOpenText, Check, Code2, Copy, CornerDownLeft, FolderOpen, Minus, Plus, SquarePen } from "lucide-react";
import { useProjectStore, type Viewer as ViewerState } from "../../../store/projectStore";
import { useUiStore } from "../../../store/uiStore";
import {
  absolutePath,
  fileChangedOnDisk,
  findFileTab,
  isMarkdownPath,
  peekEditorSession,
  openInEditor,
  pastePath,
  projectRoot,
  reloadFile,
  saveFile,
  setTabDirty,
  setTabMarkdown,
  storeEditorSession,
  takeEditorSession,
} from "../../../lib/project";
import type { FilePreview } from "../../../lib/git";
import { IS_TAURI } from "../../../lib/ipc";
import { cn } from "../../../lib/layout";
import { IconButton, Kbd } from "../../ui";
import { Body, Header, Notice } from "./parts";
import { IS_MAC, sysLabel } from "../../../lib/shortcuts";
// markdown-it llega bajo demanda, como CodeMirror: no pesa en el arranque.
const MarkdownPreview = lazy(() => import("./MarkdownPreview").then((m) => ({ default: m.MarkdownPreview })));

/** Acciones comunes de un archivo: tu editor, pegar/copiar la ruta, Finder. */
const FileActions: React.FC<{ path: string; absolute: string | null; line?: number }> = ({ path, absolute, line }) => {
  const toast = useUiStore((s) => s.showToast);
  if (!absolute) return null;
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(absolute);
      toast("Ruta copiada.");
    } catch {
      toast("No se pudo copiar la ruta.", "error");
    }
  };
  return (
    <>
      <IconButton icon={SquarePen} label="Abrir en tu editor (Cursor, VS Code…)" size="sm" onClick={() => void openInEditor(path, line)} />
      <IconButton icon={CornerDownLeft} label="Pegar la ruta en la terminal" size="sm" onClick={() => pastePath(absolute)} />
      <IconButton icon={Copy} label="Copiar ruta" size="sm" onClick={() => void copyPath()} />
      {IS_TAURI && (
        <IconButton
          icon={FolderOpen}
          label="Mostrar en Finder"
          size="sm"
          onClick={() => void revealItemInDir(absolute).catch(() => toast("No se pudo abrir Finder.", "error"))}
        />
      )}
    </>
  );
};

const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

export const FileView: React.FC<{
  viewer: Extract<ViewerState, { kind: "file" }>;
  bodyRef: React.RefObject<HTMLDivElement | null>;
}> = ({ viewer, bodyRef }) => {
  if (viewer.image) return <ImageFile viewer={viewer} image={viewer.image} bodyRef={bodyRef} />;
  const root = projectRoot();
  if (viewer.preview && !viewer.preview.binary && root) {
    return <TextFile key={`${root}\u0000${viewer.path}`} viewer={viewer} preview={viewer.preview} root={root} bodyRef={bodyRef} />;
  }
  return (
    <>
      <Header path={viewer.path} badge={viewer.preview ? formatBytes(viewer.preview.size) : "Archivo"}>
        <FileActions path={viewer.path} absolute={viewer.preview?.absolute ?? absolutePath(viewer.path)} />
      </Header>
      <Body bodyRef={bodyRef}>
        {viewer.error && <Notice tone="error">{viewer.error}</Notice>}
        {!viewer.error && !viewer.preview && <Notice>Abriendo…</Notice>}
        {viewer.preview?.binary && <Notice>Archivo binario: no se puede mostrar aquí. Ábrelo con su aplicación desde Finder.</Notice>}
      </Body>
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Imagen                                                              */
/* ------------------------------------------------------------------ */

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

const ImageFile: React.FC<{
  viewer: Extract<ViewerState, { kind: "file" }>;
  image: { url: string; bytes: number };
  bodyRef: React.RefObject<HTMLDivElement | null>;
}> = ({ viewer, image, bodyRef }) => {
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // La imagen llega después de abrir el visor: el foco vuelve aquí para que
  // Esc y +/− funcionen sin hacer clic.
  useEffect(() => {
    bodyRef.current?.focus();
  }, [bodyRef, image.url]);

  /** Escala real que se ve ahora (para saber desde dónde acercar o alejar). */
  const currentScale = () => {
    if (zoom !== "fit") return zoom;
    const img = imgRef.current;
    return img && natural?.w ? img.clientWidth / natural.w : 1;
  };
  const step = (dir: 1 | -1) => {
    const scale = currentScale();
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > scale + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.001);
    setZoom(next ?? (dir > 0 ? ZOOM_STEPS[ZOOM_STEPS.length - 1] : ZOOM_STEPS[0]));
  };
  const label = zoom === "fit" ? "Ajustada" : `${Math.round(zoom * 100)} %`;
  const isSvg = viewer.path.toLowerCase().endsWith(".svg");

  return (
    <>
      <Header
        path={viewer.path}
        badge={[natural?.w ? `${natural.w}×${natural.h}` : isSvg ? "SVG" : null, formatBytes(image.bytes)].filter(Boolean).join(" · ")}
      >
        <span className="flex items-center gap-0.5 font-sans text-[12px]">
          <IconButton icon={Minus} label="Alejar" shortcut="−" size="sm" onClick={() => step(-1)} />
          <button
            type="button"
            onClick={() => setZoom(zoom === "fit" ? 1 : "fit")}
            title={zoom === "fit" ? "Tamaño real (1)" : "Ajustar a la ventana (0)"}
            className="w-[74px] rounded px-1.5 text-center font-mono text-[11.5px] tabular-nums text-ink-2 hover:bg-hover"
          >
            {label}
          </button>
          <IconButton icon={Plus} label="Acercar" shortcut="+" size="sm" onClick={() => step(1)} />
        </span>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
        <FileActions path={viewer.path} absolute={absolutePath(viewer.path)} />
      </Header>
      <div
        ref={bodyRef}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key === "+" || e.key === "=") step(1);
          else if (e.key === "-" || e.key === "_") step(-1);
          else if (e.key === "0") setZoom("fit");
          else if (e.key === "1") setZoom(1);
          else return;
          e.preventDefault();
        }}
        className="checkerboard grid min-h-0 flex-1 place-items-center overflow-auto p-6 outline-none"
      >
        {failed ? (
          <Notice tone="error">El visor no pudo dibujar esta imagen (¿formato no soportado por el sistema?).</Notice>
        ) : (
          <img
            ref={imgRef}
            src={image.url}
            alt={viewer.path}
            draggable={false}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
            style={zoom === "fit" || !natural?.w ? undefined : { width: natural.w * zoom, maxWidth: "none", maxHeight: "none" }}
            className={cn(
              "select-none shadow-[0_8px_32px_-8px_rgb(0_0_0/0.5)]",
              zoom === "fit" && "max-h-full max-w-full object-contain",
              // Pixel art y capturas pequeñas: sin difuminar al ampliar.
              zoom !== "fit" && zoom > 1 && "[image-rendering:pixelated]",
            )}
          />
        )}
      </div>
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Texto: editor (y vista previa de Markdown)                          */
/* ------------------------------------------------------------------ */

type EditorModule = typeof import("../../../editor/codemirror");
type EditorHandle = ReturnType<EditorModule["createEditor"]>;
type EditorSession = import("../../../editor/codemirror").EditorSession;

/** ⌘⇧V / Ctrl+Shift+V: alternar vista previa y texto (como en VS Code). */
const isPreviewToggle = (e: React.KeyboardEvent) =>
  (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "v";

const TextFile: React.FC<{
  viewer: Extract<ViewerState, { kind: "file" }>;
  preview: FilePreview;
  root: string;
  bodyRef: React.RefObject<HTMLDivElement | null>;
}> = ({ viewer, preview, root, bodyRef }) => {
  const path = viewer.path;
  const editable = preview.utf8 && !preview.truncated;
  const markdown = isMarkdownPath(path);
  const tabMode = useProjectStore((s) => s.fileTabs.find((t) => t.root === root && t.path === path)?.markdown);
  const mode = markdown ? (tabMode ?? "preview") : "source";
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  const busyRef = useRef(false);
  /** Versión de disco sobre la que se edita: la que se exige al guardar. */
  const baseVersion = useRef(preview.version);
  // Solo lo que había al abrir: el componente se monta de nuevo por archivo.
  const initial = useRef({ text: preview.text, version: preview.version, readOnly: !editable, stored: takeEditorSession(root, path) });
  const saveRef = useRef<(force?: boolean) => void>(() => {});
  /** Un guardado puede terminar después de cambiar de pestaña. */
  const mounted = useRef(true);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [diskChanged, setDiskChanged] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState(preview.text);

  // El editor se crea una vez por archivo (CodeMirror llega bajo demanda). Si la
  // pestaña ya estaba abierta, retoma su texto, cursor y deshacer.
  useEffect(() => {
    let disposed = false;
    mounted.current = true;
    // StrictMode monta dos veces: la sesión que devolvió la primera limpieza se retoma aquí.
    const pending = takeEditorSession(root, path) ?? initial.current.stored;
    import("../../../editor/codemirror")
      .then(({ createEditor }) => {
        if (disposed || !hostRef.current) return;
        const { text, version, readOnly } = initial.current;
        const stored = pending;
        // Sin cambios y con el archivo igual en disco se retoma; si alguien lo cambió, se abre lo nuevo.
        const resume = stored && (stored.dirty || stored.version === version) ? stored : undefined;
        if (resume) baseVersion.current = resume.version;
        const handle = createEditor(hostRef.current, {
          doc: text,
          path,
          readOnly,
          session: resume?.session as EditorSession | undefined,
          onDirtyChange: (next) => {
            setDirty(next);
            setTabDirty(root, path, next);
          },
          onSave: () => saveRef.current(),
        });
        editorRef.current = handle;
        if (resume?.dirty && resume.version !== version) setDiskChanged(true);
        setPreviewText(handle.snapshot().text);
        setReady(true);
        if (mode === "source") handle.focus();
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
    return () => {
      disposed = true;
      mounted.current = false;
      const editor = editorRef.current;
      // La pestaña sigue abierta (se cambió a otra, Esc, otro repo): se guarda tal cual.
      if (findFileTab(root, path)) {
        if (editor) storeEditorSession(root, path, { session: editor.session(), version: baseVersion.current, dirty: editor.isDirty() });
        // El editor no llegó a crearse (se fue antes de que cargara CodeMirror): la sesión vuelve a su sitio.
        else if (pending) storeEditorSession(root, path, pending);
      }
      editor?.destroy();
      editorRef.current = null;
    };
    // `mode` solo decide el foco inicial: cambiarlo no recrea el editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, root]);

  // Saltos pedidos (⌘-clic en una ruta, un resultado de búsqueda): línea y coincidencia.
  useEffect(() => {
    if (ready && viewer.jump && viewer.line) editorRef.current?.goTo(viewer.line, viewer.column, viewer.length);
  }, [ready, viewer.jump, viewer.line, viewer.column, viewer.length]);

  const switchMode = (next: "preview" | "source") => {
    if (next === mode) return;
    if (next === "preview") setPreviewText(editorRef.current?.snapshot().text ?? previewText);
    setTabMarkdown(path, next);
    if (next === "source") requestAnimationFrame(() => editorRef.current?.focus());
    else requestAnimationFrame(() => bodyRef.current?.focus());
  };

  const save = async (force = false) => {
    const editor = editorRef.current;
    if (!editor || !editable || busyRef.current) return;
    busyRef.current = true;
    setSaving(true);
    const snapshot = editor.snapshot();
    const result = await saveFile(root, path, snapshot.text, force ? null : baseVersion.current);
    busyRef.current = false;
    if (!mounted.current) {
      // Se cambió de pestaña mientras guardaba: la sesión que quedó esperando pasa a esta
      // versión (si no, al volver avisaría de un «cambio en disco» que fue el tuyo).
      const stored = peekEditorSession(root, path);
      if (result.status === "saved" && stored) {
        const session = stored.session as EditorSession;
        const doc = (session.json as { doc?: unknown }).doc;
        const dirty = doc !== snapshot.text;
        storeEditorSession(root, path, { session: { ...session, saved: snapshot.text }, version: result.version, dirty });
        setTabDirty(root, path, dirty);
      }
      return;
    }
    setSaving(false);
    if (result.status === "saved") {
      baseVersion.current = result.version;
      editor.markSaved(snapshot);
      setDiskChanged(false);
      setSavedAt(Date.now());
    } else if (result.status === "conflict") {
      setDiskChanged(true);
    }
  };
  useEffect(() => {
    saveRef.current = (force) => void save(force);
  });

  const reload = async () => {
    const fresh = await reloadFile(root, path);
    if (!fresh) return;
    editorRef.current?.replaceText(fresh.text);
    baseVersion.current = fresh.version;
    setPreviewText(fresh.text);
    setDiskChanged(false);
  };

  // Un agente (u otra app) cambió el archivo: si no hay cambios tuyos se recarga
  // solo; si los hay, se avisa y tú decides.
  useEffect(() => {
    if (!ready) return;
    const check = async () => {
      if (document.visibilityState !== "visible" || busyRef.current) return;
      const changed = await fileChangedOnDisk(root, path, baseVersion.current);
      const editor = editorRef.current;
      if (!changed || !editor || busyRef.current) return;
      if (editor.isDirty()) {
        setDiskChanged(true);
        return;
      }
      const fresh = await reloadFile(root, path);
      if (fresh && !editor.isDirty()) {
        editor.replaceText(fresh.text);
        baseVersion.current = fresh.version;
        setPreviewText(fresh.text);
      }
    };
    const timer = setInterval(() => void check(), 2000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [ready, path, root]);

  // "Guardado" se ve un momento y se va.
  useEffect(() => {
    if (!savedAt) return;
    const timer = setTimeout(() => setSavedAt(null), 1600);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const badge = !editable ? "Solo lectura" : dirty ? "● Sin guardar" : savedAt ? "Guardado" : formatBytes(preview.size);

  return (
    <>
      <Header path={path} badge={badge} badgeTone={dirty ? "accent" : undefined}>
        {editable && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            title={`Guardar  ${sysLabel("S")}`}
            className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 font-sans text-[12px] font-medium text-on-accent transition-opacity duration-150 disabled:opacity-0"
          >
            <Check size={13} strokeWidth={2} aria-hidden="true" />
            {saving ? "Guardando…" : "Guardar"}
            <Kbd className="text-on-accent/70">{sysLabel("S")}</Kbd>
          </button>
        )}
        {markdown && (
          <span role="group" aria-label="Cómo ver el Markdown" className="flex rounded-md border border-line p-0.5 font-sans text-[11.5px]">
            {(
              [
                ["preview", "Vista previa", BookOpenText],
                ["source", "Texto", Code2],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                aria-pressed={mode === id}
                title={`${label}  ${IS_MAC ? "⇧⌘V" : "Ctrl+Shift+V"}`}
                onClick={() => switchMode(id)}
                className={cn(
                  "flex h-[22px] items-center gap-1 rounded px-1.5 transition-colors duration-150",
                  mode === id ? "bg-press text-ink" : "text-ink-3 hover:text-ink-2",
                )}
              >
                <Icon size={12} strokeWidth={1.9} aria-hidden="true" />
                {label}
              </button>
            ))}
          </span>
        )}
        <FileActions path={path} absolute={preview.absolute} line={viewer.line} />
      </Header>
      {diskChanged && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-accent/40 bg-accent/[0.08] px-4 py-2 text-[12.5px]">
          <span className="text-ink">El archivo cambió en disco mientras lo editabas (¿un agente?).</span>
          <span className="flex-1" />
          <button type="button" onClick={() => void reload()} className="rounded border border-line px-2 leading-6 text-ink-2 hover:bg-hover">
            Recargar (pierdes tus cambios)
          </button>
          <button type="button" onClick={() => void save(true)} className="rounded bg-accent px-2 leading-6 font-medium text-on-accent hover:opacity-90">
            Sobrescribir con lo mío
          </button>
        </div>
      )}
      {!editable && (
        <p className="shrink-0 border-b border-line bg-raised px-4 py-1.5 text-[12px] text-ink-3">
          {preview.truncated
            ? "Archivo de más de 2 MB: aquí solo ves el principio y no se puede editar. Ábrelo en tu editor."
            : "No está en UTF-8: editarlo aquí lo dañaría. Ábrelo en tu editor."}
        </p>
      )}
      {loadError && <Notice tone="error">No se pudo cargar el editor: {loadError}</Notice>}
      <div
        ref={bodyRef}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (markdown && isPreviewToggle(e)) {
            e.preventDefault();
            switchMode(mode === "preview" ? "source" : "preview");
          }
        }}
        className="relative min-h-0 flex-1 outline-none"
      >
        <div ref={hostRef} className="absolute inset-0" hidden={mode === "preview"} />
        {mode === "preview" && (
          <div className="absolute inset-0 overflow-y-auto">
            <Suspense fallback={<p className="px-8 py-6 font-sans text-[13px] text-ink-3">Abriendo…</p>}>
              <MarkdownPreview path={path} text={previewText} />
            </Suspense>
          </div>
        )}
        {!ready && !loadError && mode === "source" && <p className="absolute left-4 top-4 font-sans text-[13px] text-ink-3">Abriendo…</p>}
      </div>
    </>
  );
};
