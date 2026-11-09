import { useUiStore } from "../store/uiStore";
import { terminalManager } from "../terminal/TerminalManager";
import { resolvePaste, type ClipboardSnapshot } from "../terminal/clipboard";
import { ipc, quotePath } from "./ipc";

/**
 * ⌘V / Ctrl+V con archivos o una imagen en el portapapeles: se pega su ruta
 * (escapada, con un espacio detrás, igual que al arrastrarlos al panel).
 */
export async function pasteFromClipboard(paneId: string, clip: ClipboardSnapshot) {
  const toast = useUiStore.getState().showToast;
  const outcome = await resolvePaste(clip, {
    clipboardFiles: ipc.clipboardFiles,
    saveImage: (bytes) => ipc.saveClipboardImage(bytes),
    nativeImage: ipc.clipboardImage,
  });
  switch (outcome.kind) {
    case "text":
      terminalManager.paste(paneId, outcome.text);
      return;
    case "paths":
      terminalManager.paste(paneId, `${outcome.paths.map(quotePath).join(" ")} `);
      if (outcome.failed) toast(`No se pudo pegar alguna imagen: ${outcome.failed}`, "error");
      return;
    case "nothing":
      toast(outcome.failed ?? "El portapapeles no tiene texto, imágenes ni archivos que pegar.", outcome.failed ? "error" : "info");
  }
}
