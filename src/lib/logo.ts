/**
 * La marca `t»c_` en vectores, con las proporciones del logo: la `t` y la
 * `c` en tinta; los dos chevrones y el guion bajo (el cursor) en el color de
 * marca. Una sola fuente para la interfaz y para el ícono de la app
 * (`src-tauri/icons/icon.svg`).
 */
export const LOGO_VIEWBOX = { width: 846, height: 282 } as const;

/** `t` con remate curvo abajo a la izquierda. */
export const LOGO_T =
  "M42 22Q42 10 54 10H100Q112 10 112 22V102H152Q164 102 164 114V146Q164 158 152 158H112V212H152Q164 212 164 224V260Q164 272 152 272H90Q42 272 42 224V158H12Q0 158 0 146V114Q0 102 12 102H42Z";

/** `c`: esquinas exteriores amplias, boca abierta a la derecha. */
export const LOGO_C =
  "M549 52H683Q695 52 695 64V110Q695 122 683 122H577Q563 122 563 136V198Q563 212 577 212H683Q695 212 695 224V270Q695 282 683 282H549Q495 282 495 228V106Q495 52 549 52Z";

/** Los chevrones `»` (polígonos; las esquinas se redondean con el trazo). */
export const LOGO_CHEVRONS = [
  "200,52 272,52 350,167 272,282 200,282 278,167",
  "315,52 387,52 465,167 387,282 315,282 393,167",
] as const;

/** El cursor `_`. */
export const LOGO_CURSOR = { x: 722, y: 248, width: 124, height: 34, rx: 7 } as const;
