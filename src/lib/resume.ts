import type { AgentKind } from "../types/layout";

/**
 * Ids de sesión de Claude (UUID hoy). Vienen de un archivo en disco y acaban
 * en una línea de comandos: solo se aceptan caracteres que ninguna shell
 * interpreta. Mismo criterio que `valid_session_id` en el backend.
 */
export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

export interface AgentCommandOptions {
  /** `--settings` de termCode (statusLine + hooks). Solo Claude. */
  settingsPath?: string | null;
  /** `--mcp-config` del MCP de lectura de paneles. Solo Claude. */
  mcpConfigPath?: string | null;
  prompt?: string;
  /** Sesión que se reanuda; `"last"` = la más reciente de la carpeta (Codex). */
  resume?: string | "last";
}

/**
 * Línea de comandos de un agente, con cada argumento entre comillas POSIX.
 * Un `resume` inválido se ignora (sesión nueva) en vez de llegar a la shell.
 */
export function agentCommand(
  agent: AgentKind,
  base: string,
  quote: (value: string) => string,
  opts: AgentCommandOptions = {},
): string {
  const parts = [base];
  const resume = opts.resume === "last" || (opts.resume && isSafeSessionId(opts.resume)) ? opts.resume : undefined;
  if (agent === "claude") {
    if (opts.settingsPath) parts.push("--settings", quote(opts.settingsPath));
    if (opts.mcpConfigPath) parts.push("--mcp-config", quote(opts.mcpConfigPath));
    if (resume === "last") parts.push("--continue");
    else if (resume) parts.push("--resume", quote(resume));
  } else if (resume) {
    parts.splice(1, 0, "resume", resume === "last" ? "--last" : quote(resume));
  }
  if (opts.prompt?.trim()) parts.push("--", quote(opts.prompt.trim()));
  return parts.join(" ");
}
