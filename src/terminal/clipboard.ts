/**
 * Pegar en la terminal lo que no es texto (⌘V / Ctrl+V y «Pegar» del menú):
 * archivos copiados en Finder o el Explorador y capturas o imágenes copiadas.
 * xterm solo lee `text/plain`, así que con una captura en el portapapeles
 * pegar no hacía nada. Ahora se pega una ruta: la del archivo copiado, o la de
 * la imagen guardada en un archivo (Claude Code y Codex la adjuntan al verla).
 */

/** Lo que trae el evento, leído en el momento: el `DataTransfer` caduca al terminar el evento. */
export interface ClipboardSnapshot {
  text: string;
  /** `text/uri-list` (Linux: Nautilus y Dolphin ponen ahí los archivos copiados). */
  uriList: string;
  /** Imágenes que entrega el webview (capturas, «Copiar imagen» del navegador). */
  images: File[];
  /** El portapapeles trae archivos (el webview no da sus rutas). */
  hasFiles: boolean;
}

/** Imágenes de un solo pegado como máximo. */
export const MAX_PASTED_IMAGES = 10;

export function snapshotClipboard(data: DataTransfer): ClipboardSnapshot {
  const files = Array.from(data.files ?? []);
  const types = Array.from(data.types ?? []);
  return {
    text: data.getData("text/plain"),
    uriList: types.includes("text/uri-list") ? data.getData("text/uri-list") : "",
    images: files.filter((f) => f.type.startsWith("image/")).slice(0, MAX_PASTED_IMAGES),
    hasFiles: files.length > 0 || types.includes("Files"),
  };
}

/**
 * ¿Se encarga termCode? Solo si hay archivos o no hay texto: con texto normal
 * xterm pega como siempre (y con bracketed paste), sin esperar a nadie.
 */
export function needsRichPaste(clip: ClipboardSnapshot): boolean {
  return clip.hasFiles || !clip.text || fileUrisToPaths(clip.uriList).length > 0;
}

/** `file:///home/a/b%20c.png` → `/home/a/b c.png`; `file:///C:/x` → `C:\x`. Lo demás se ignora. */
export function fileUrisToPaths(uriList: string): string[] {
  const paths: string[] = [];
  for (const raw of uriList.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !/^file:/i.test(line)) continue;
    try {
      const url = new URL(line);
      if (url.host && url.host !== "localhost") continue;
      const path = decodeURIComponent(url.pathname);
      paths.push(/^\/[A-Za-z]:\//.test(path) ? path.slice(1).replace(/\//g, "\\") : path);
    } catch {
      // URI mal formada: no se pega.
    }
  }
  return paths;
}

export type PasteOutcome =
  | { kind: "paths"; paths: string[]; savedImages: number; failed: string | null }
  | { kind: "text"; text: string }
  | { kind: "nothing"; failed: string | null };

export interface PasteDeps {
  /** Rutas de lo copiado en el gestor de archivos (portapapeles del sistema). */
  clipboardFiles: () => Promise<string[] | null>;
  /** Guarda una imagen y devuelve su ruta (lanza un error legible). */
  saveImage: (bytes: Uint8Array) => Promise<string>;
  /** Respaldo (macOS): la imagen del portapapeles del sistema ya guardada, si el webview no la dio. */
  nativeImage: () => Promise<string | null>;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Qué pegar, en orden: archivos copiados (sus rutas), texto (una tabla de una
 * hoja de cálculo trae texto *e* imagen: manda el texto) y, al final, las
 * imágenes guardadas en archivos: las que dio el webview o, si no dio
 * ninguna, la del portapapeles del sistema.
 */
export async function resolvePaste(clip: ClipboardSnapshot, deps: PasteDeps): Promise<PasteOutcome> {
  const native = (await deps.clipboardFiles().catch(() => null)) ?? [];
  if (native.length) return { kind: "paths", paths: native, savedImages: 0, failed: null };
  const fromUris = fileUrisToPaths(clip.uriList);
  if (fromUris.length) return { kind: "paths", paths: fromUris, savedImages: 0, failed: null };
  if (clip.text) return { kind: "text", text: clip.text };

  const paths: string[] = [];
  let failed: string | null = null;
  for (const image of clip.images) {
    try {
      paths.push(await deps.saveImage(new Uint8Array(await image.arrayBuffer())));
    } catch (err) {
      failed = errorText(err);
    }
  }
  if (paths.length) return { kind: "paths", paths, savedImages: paths.length, failed };
  if (!clip.images.length) {
    try {
      const saved = await deps.nativeImage();
      if (saved) return { kind: "paths", paths: [saved], savedImages: 1, failed: null };
    } catch (err) {
      failed = errorText(err);
    }
  }
  return { kind: "nothing", failed };
}
