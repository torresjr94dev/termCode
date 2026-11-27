/**
 * Fondo del tema «Vidrio líquido»: elegir la imagen, guardarla (el backend
 * guarda su propia copia), cargarla como URL `blob:` y decidir qué tan opaco
 * tiene que ser el vidrio para que el texto se lea encima.
 *
 * Legibilidad: el vidrio es un velo oscuro (#0c0e16) sobre la imagen. Con una
 * foto clara, un velo ligero deja el texto gris claro a 2:1. Se mide la
 * imagen (el 90.º percentil de su luminosidad, ya reducida a 48×48, que es lo
 * que deja ver el desenfoque) y se calcula el velo mínimo para que el texto
 * secundario (`ink-3`) quede ≥ 4.5:1. Tu ajuste manda solo si es más opaco.
 */
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { LIMITS, useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import { IS_TAURI } from "./ipc";

/** Lo mismo que acepta el backend (backdrop.rs). */
const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif";
/** Velo del vidrio (sRGB, 0–1): `rgb(12 14 22)`. */
const TINT_VALUE = 14 / 255;
/** Valor sRGB de gris más claro que deja a `ink-3` (#aab2c3) en 4.5:1. */
const MAX_BACKGROUND_VALUE = 0.27;

interface BackdropState {
  /** URL `blob:` de la imagen cargada; null = el degradado de fábrica. */
  url: string | null;
  /** Opacidad mínima del vidrio para esta imagen. */
  floor: number;
  loading: boolean;
}

export const useBackdropStore = create<BackdropState>(() => ({ url: null, floor: LIMITS.glassTint.min, loading: false }));

/**
 * Velo mínimo para un fondo cuyo gris más claro relevante es `value` (sRGB
 * 0–1). La mezcla del velo ocurre en sRGB: `(1-t)·v + t·tinte ≤ máximo`.
 */
export function tintFloor(value: number): number {
  const { min, max } = LIMITS.glassTint;
  if (value <= MAX_BACKGROUND_VALUE) return min;
  const needed = (value - MAX_BACKGROUND_VALUE) / (value - TINT_VALUE);
  return Math.min(max, Math.max(min, Math.ceil(needed * 100) / 100));
}

/** Luminancia relativa (WCAG) → valor sRGB de un gris con esa luminancia. */
function toSrgb(luminance: number): number {
  return luminance <= 0.0031308 ? luminance * 12.92 : 1.055 * luminance ** (1 / 2.4) - 0.055;
}
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** 90.º percentil del gris equivalente de los pixeles (RGBA, 0–255). */
export function brightValue(pixels: Uint8ClampedArray): number {
  const values: number[] = [];
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 16) continue;
    const y = 0.2126 * linear(pixels[i] / 255) + 0.7152 * linear(pixels[i + 1] / 255) + 0.0722 * linear(pixels[i + 2] / 255);
    values.push(toSrgb(y));
  }
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(values.length * 0.9))];
}

async function measure(url: string): Promise<number> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 48;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return LIMITS.glassTint.max;
  ctx.drawImage(img, 0, 0, 48, 48);
  return tintFloor(brightValue(ctx.getImageData(0, 0, 48, 48).data));
}

let loadSeq = 0;

/** Carga el fondo guardado (o vuelve al degradado si `name` es null). */
export async function loadBackdrop(name: string | null): Promise<void> {
  const seq = ++loadSeq;
  const previous = useBackdropStore.getState().url;
  if (!name || !IS_TAURI) {
    useBackdropStore.setState({ url: null, floor: LIMITS.glassTint.min, loading: false });
    if (previous) URL.revokeObjectURL(previous);
    return;
  }
  useBackdropStore.setState({ loading: true });
  try {
    const bytes = await invoke<ArrayBuffer>("backdrop_load", { name });
    if (seq !== loadSeq) return;
    const url = URL.createObjectURL(new Blob([bytes]));
    // Si no se puede medir, se asume lo peor (fondo blanco): mejor oscuro que ilegible.
    const floor = await measure(url).catch(() => LIMITS.glassTint.max);
    if (seq !== loadSeq) {
      URL.revokeObjectURL(url);
      return;
    }
    useBackdropStore.setState({ url, floor, loading: false });
    if (previous) URL.revokeObjectURL(previous);
  } catch (err) {
    if (seq !== loadSeq) return;
    useBackdropStore.setState({ url: null, floor: LIMITS.glassTint.min, loading: false });
    if (previous) URL.revokeObjectURL(previous);
    useUiStore.getState().showToast(`No se pudo cargar tu fondo: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

/** Abre el selector de archivos del sistema. `null` si se cancela. */
function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT;
    input.style.display = "none";
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/** Elegir una imagen, guardarla y ponerla de fondo. */
export async function chooseBackdrop(): Promise<void> {
  const toast = useUiStore.getState().showToast;
  if (!IS_TAURI) {
    toast("Solo disponible en la app de escritorio.", "error");
    return;
  }
  const file = await pickImage();
  if (!file) return;
  if (file.size > MAX_BYTES) {
    toast(`La imagen pesa ${(file.size / (1024 * 1024)).toFixed(0)} MB: el máximo es 25 MB.`, "error");
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = await invoke<string>("backdrop_save", bytes);
    useSettingsStore.getState().update({ glassImage: name });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

/** Quitar tu imagen: vuelve el degradado de fábrica. */
export async function clearBackdrop(): Promise<void> {
  useSettingsStore.getState().update({ glassImage: null });
  if (!IS_TAURI) return;
  try {
    await invoke("backdrop_clear");
  } catch (err) {
    useUiStore.getState().showToast(`No se pudo borrar la imagen guardada: ${String(err)}`, "error");
  }
}
