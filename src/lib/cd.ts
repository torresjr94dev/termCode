import { powershellQuote, shellQuote } from "./ipc";
import { IS_WINDOWS } from "./shortcuts";

/**
 * Lo que se teclea en la shell del panel para ir a `path` (sin el Enter).
 * Antes se quita lo que hubiera a medio escribir, para que el `cd` no se
 * pegue al final de un comando tuyo: Ctrl+E y Ctrl+U en zsh/bash/fish (fin de
 * línea y borrar hasta el inicio) y Esc en PowerShell (PSReadLine la vacía).
 * Las rutas son absolutas, así que nunca empiezan con `-`.
 */
export function cdKeystrokes(path: string, windows = IS_WINDOWS): string {
  return windows ? lineKeystrokes(`Set-Location -LiteralPath ${powershellQuote(path)}`, true) : lineKeystrokes(`cd ${shellQuote(path)}`, false);
}

/** `line` tecleada en la shell sobre lo que hubiera a medio escribir (sin el Enter). */
export function lineKeystrokes(line: string, windows = IS_WINDOWS): string {
  return `${windows ? "\x1b" : "\x05\x15"}${line}`;
}

/** Carpeta que contiene a `path` (`/a/b` → `/a`, `C:\a` → `C:\`), o null en la raíz. */
export function parentDir(path: string): string | null {
  const windows = /^[A-Za-z]:/.test(path);
  const trimmed = path.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  const cut = windows ? Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/")) : trimmed.lastIndexOf("/");
  if (cut < 0 || trimmed === "" || /^[A-Za-z]:$/.test(trimmed)) return null;
  if (windows) return cut <= 2 ? `${trimmed.slice(0, 2)}\\` : trimmed.slice(0, cut);
  return cut === 0 ? "/" : trimmed.slice(0, cut);
}

/**
 * Migas de pan de una carpeta: cada tramo con la ruta a la que lleva. Dentro
 * de tu carpeta de inicio empieza en `~`.
 */
export function breadcrumbs(path: string, home: string | null): Array<{ label: string; path: string }> {
  const windows = /^[A-Za-z]:/.test(path);
  const sep = windows ? "\\" : "/";
  const norm = (p: string) => p.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  const full = norm(path);
  const base = home ? norm(home) : null;
  const inside = base && (windows ? full.toLowerCase() : full).startsWith(windows ? base.toLowerCase() : base) &&
    (full.length === base.length || /[\\/]/.test(full[base.length]));

  const crumbs: Array<{ label: string; path: string }> = [];
  let current: string;
  let rest: string;
  if (inside && base) {
    crumbs.push({ label: "~", path: base });
    current = base;
    rest = full.slice(base.length);
  } else if (windows) {
    current = `${full.slice(0, 2)}\\`;
    crumbs.push({ label: full.slice(0, 2), path: current });
    rest = full.slice(2);
  } else {
    current = "/";
    crumbs.push({ label: "/", path: "/" });
    rest = full;
  }
  for (const part of rest.split(/[\\/]/).filter(Boolean)) {
    current = current.endsWith(sep) ? `${current}${part}` : `${current}${sep}${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}
