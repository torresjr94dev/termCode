import { useSyncExternalStore } from "react";
import { IS_TAURI } from "./ipc";
import { IS_MAC } from "./shortcuts";

/**
 * Pantalla completa de macOS: los semáforos se esconden con la barra de
 * menús, así que el hueco que se les reserva a la izquierda sobra (quedaba
 * una franja vacía antes de la barra lateral y la campana).
 */
let fullscreen = false;
let started = false;
const listeners = new Set<() => void>();

function start() {
  if (started || !IS_TAURI || !IS_MAC) return;
  started = true;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      let settle: ReturnType<typeof setTimeout> | undefined;
      const check = () =>
        void win
          .isFullscreen()
          .then((value) => {
            if (value === fullscreen) return;
            fullscreen = value;
            listeners.forEach((listener) => listener());
          })
          .catch(() => {});
      // La animación de entrar o salir dura ~0.5 s: se pregunta al momento y al acabar.
      const onResize = () => {
        check();
        clearTimeout(settle);
        settle = setTimeout(check, 700);
      };
      check();
      // Vive lo que la ventana: no hay que dejar de escuchar.
      return win.onResized(onResize);
    })
    .catch((err) => console.warn("[termCode] pantalla completa:", err));
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useIsFullscreen(): boolean {
  return useSyncExternalStore(subscribe, () => fullscreen);
}

/** Hay semáforos de macOS que esquivar (ventana normal, no a pantalla completa). */
export function useTrafficLights(): boolean {
  const isFullscreen = useIsFullscreen();
  return IS_MAC && !isFullscreen;
}
