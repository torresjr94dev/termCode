/**
 * Actualizaciones de la app. La firma la verifica el backend (tauri-plugin-
 * updater) contra la llave pública con la que se compiló la release; aquí
 * solo se decide cuándo preguntar y qué mostrar.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { IS_TAURI } from "./ipc";
import { useUiStore } from "../store/uiStore";

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
  /** Segundos Unix. */
  date: number | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function updatesSupported(): Promise<boolean> {
  if (!IS_TAURI) return false;
  try {
    return await invoke<boolean>("update_supported");
  } catch {
    return false;
  }
}

/** Lanza un Error legible (sin red, manifiesto inválido…). */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    return await invoke<UpdateInfo | null>("update_check");
  } catch (err) {
    throw new Error(errorText(err), { cause: err });
  }
}

/** Descarga, verifica, instala y reinicia. Solo vuelve si algo falla. */
export async function installUpdate(onProgress: (p: UpdateProgress) => void): Promise<void> {
  let unlisten: UnlistenFn | undefined;
  try {
    unlisten = await listen<UpdateProgress>("update-progress", (e) => onProgress(e.payload));
    await invoke("update_install");
  } catch (err) {
    throw new Error(errorText(err), { cause: err });
  } finally {
    unlisten?.();
  }
}

const LAST_CHECK_KEY = "termcode.updateCheckedAt";
const DAY_MS = 24 * 60 * 60 * 1000;

function lastCheck(): number {
  try {
    return Number(localStorage.getItem(LAST_CHECK_KEY)) || 0;
  } catch {
    return 0;
  }
}

function rememberCheck(at: number) {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(at));
  } catch {
    // Sin almacenamiento: se volverá a consultar en el próximo arranque.
  }
}

/** Una consulta al día, en silencio salvo que haya versión nueva. */
export function startUpdateChecks(): () => void {
  const timer = setTimeout(async () => {
    if (Date.now() - lastCheck() < DAY_MS || !(await updatesSupported())) return;
    try {
      const update = await checkForUpdate();
      rememberCheck(Date.now());
      if (update) {
        useUiStore
          .getState()
          .showToast(`termCode ${update.version} está disponible: instálala desde Ajustes → Acerca de.`);
      }
    } catch {
      // Sin red al arrancar: no vale la pena molestar; se reintenta en el próximo arranque.
    }
  }, 15_000);
  return () => clearTimeout(timer);
}
