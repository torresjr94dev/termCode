import { IS_MAC, IS_WINDOWS } from "./shortcuts";

/** «Mostrar en Finder» con el nombre del gestor de archivos de cada sistema. */
export function revealLabel(): string {
  return IS_MAC ? "Mostrar en Finder" : IS_WINDOWS ? "Mostrar en el Explorador" : "Mostrar en la carpeta";
}
