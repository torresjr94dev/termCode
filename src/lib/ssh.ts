import { shellQuote } from "./ipc";

/** Un servidor de `~/.ssh/config` (ver src-tauri/src/ssh.rs). */
export interface SshHost {
  alias: string;
  hostName: string | null;
  user: string | null;
  port: number | null;
}

/** Un servidor guardado en termCode. Nunca contraseñas: la autenticación es de ssh. */
export interface SavedServer {
  id: string;
  name: string;
  user: string;
  host: string;
  port: number;
  /** Llave privada (ruta), opcional: sin ella, ssh usa tu agente y tus llaves de siempre. */
  identityFile: string;
}

export type ServerFields = Omit<SavedServer, "id">;
export type ServerErrors = Partial<Record<keyof ServerFields, string>>;

/** Lo que ssh no lea como una opción ni la shell como otra cosa. */
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?|\[[0-9A-Fa-f:.%]+\]|[0-9A-Fa-f:.]+)$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const ALIAS = /^[A-Za-z0-9._@:][A-Za-z0-9._@:-]{0,254}$/;

/** Errores por campo (vacío = válido), para mostrarlos junto a cada uno. */
export function validateServer(fields: ServerFields): ServerErrors {
  const errors: ServerErrors = {};
  if (!fields.name.trim()) errors.name = "Ponle un nombre para reconocerlo.";
  else if (fields.name.length > 60) errors.name = "Máximo 60 caracteres.";
  if (!HOST.test(fields.host.trim())) errors.host = "Un dominio (servidor.ejemplo.mx) o una IP (10.0.0.5, [::1]).";
  if (fields.user.trim() && !USER.test(fields.user.trim())) errors.user = "Solo letras, números, punto, guion y guion bajo.";
  if (!Number.isInteger(fields.port) || fields.port < 1 || fields.port > 65535) errors.port = "Entre 1 y 65535.";
  const key = fields.identityFile.trim();
  if (key && !/^(?:~\/|\/|[A-Za-z]:[\\/])/.test(key)) errors.identityFile = "Una ruta completa (~/.ssh/id_ed25519).";
  return errors;
}

/** Línea de `ssh` para un alias de tu config: `--` antes del destino, nada se lee como opción. */
export function sshAliasCommand(alias: string): string | null {
  return ALIAS.test(alias) ? `ssh -- ${shellQuote(alias)}` : null;
}

/** Línea de `ssh` para un servidor guardado (validado antes de guardarse). */
export function sshServerCommand(server: ServerFields): string | null {
  if (Object.keys(validateServer(server)).length) return null;
  const target = server.user.trim() ? `${server.user.trim()}@${server.host.trim()}` : server.host.trim();
  const parts = ["ssh"];
  if (server.port !== 22) parts.push("-p", String(server.port));
  // `~` no se expande entre comillas: la shell lo expande fuera de ellas.
  const key = server.identityFile.trim();
  if (key) parts.push("-i", key.startsWith("~/") ? `~/${shellQuote(key.slice(2))}` : shellQuote(key));
  parts.push("--", shellQuote(target));
  return parts.join(" ");
}

/** `deploy@10.0.0.5:2222`: lo que se muestra bajo el nombre. */
export function describeServer(user: string | null, host: string | null, port: number | null): string {
  const target = user ? `${user}@${host ?? ""}` : (host ?? "");
  return port && port !== 22 ? `${target}:${port}` : target;
}
