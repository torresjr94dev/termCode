/**
 * Rutas de macOS/Linux (`/Users/x`) y de Windows (`C:\Users\x`). Las de Windows
 * se reconocen por la unidad, aceptan `\` y `/` y no distinguen mayúsculas
 * (PowerShell conserva lo que escribiste: `cd c:\USERS` deja `C:\USERS`).
 */

const DRIVE = /^[A-Za-z]:(?=[\\/]|$)/;

export function isWindowsPath(path: string): boolean {
  return DRIVE.test(path);
}

function separatorOf(path: string): "\\" | "/" {
  return isWindowsPath(path) ? "\\" : "/";
}

function trimEnd(path: string): string {
  return path.replace(isWindowsPath(path) ? /[\\/]+$/ : /\/+$/, "");
}

/** Último componente: `/a/b` → `b`, `C:\a\b\` → `b`, `/` → `/`. */
export function basename(path: string): string {
  const trimmed = trimEnd(path);
  const cut = isWindowsPath(trimmed) ? Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/")) : trimmed.lastIndexOf("/");
  return trimmed.slice(cut + 1) || trimmed || "/";
}

/** Lo que queda de `path` dentro de `root` (`""` si es la misma), o `null` si está fuera. */
export function relativeInside(path: string, root: string): string | null {
  const [p, r] = [trimEnd(path), trimEnd(root)];
  const windows = isWindowsPath(r);
  if (windows !== isWindowsPath(p)) return null;
  const comparable = (s: string) => (windows ? s.replace(/\//g, "\\").toLowerCase() : s);
  const [cp, cr] = [comparable(p), comparable(r)];
  if (cp === cr) return "";
  return cp.startsWith(`${cr}${separatorOf(r)}`) ? p.slice(r.length + 1) : null;
}

/** `~/proyecto` (o `~\proyecto`) si está dentro de tu carpeta de inicio. */
export function tildify(path: string, home: string | null | undefined): string {
  if (!home) return path;
  const rest = relativeInside(path, home);
  if (rest === null) return path;
  return rest ? `~${separatorOf(home)}${rest}` : "~";
}

/** Une y resuelve `.` y `..` con los separadores de la plataforma de `base`. */
export function joinPath(base: string, relative: string): string {
  return normalizePath(`${base}${separatorOf(base)}${relative}`);
}

export function normalizePath(path: string): string {
  const windows = isWindowsPath(path);
  const drive = windows ? path.slice(0, 2).toUpperCase() : "";
  const parts: string[] = [];
  for (const part of path.slice(drive.length).split(windows ? /[\\/]/ : "/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return windows ? `${drive}\\${parts.join("\\")}` : `/${parts.join("/")}`;
}
