import React, { useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { X } from "lucide-react";
import {
  DEFAULT_FONT,
  DEFAULT_SETTINGS,
  LIMITS,
  useSettingsStore,
  type EditorId,
  type Settings,
  type ThemeId,
} from "../store/settingsStore";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { cn } from "../lib/layout";
import { IS_TAURI } from "../lib/ipc";
import { checkForUpdate, installUpdate, updatesSupported, type UpdateInfo, type UpdateProgress } from "../lib/updates";
import { IconButton } from "./ui";
import { LogoMark } from "./Logo";
import { CLICK_MOD, IS_MAC, IS_WINDOWS, shortcutLabel } from "../lib/shortcuts";

/** Fuentes monoespaciadas comunes; solo se ofrecen las que el sistema tiene. */
const FONT_CANDIDATES: Array<{ label: string; family: string; bundled?: boolean }> = [
  { label: "JetBrains Mono (incluida)", family: DEFAULT_FONT, bundled: true },
  { label: "SF Mono", family: '"SF Mono", ui-monospace, Menlo, monospace' },
  { label: "Menlo", family: "Menlo, monospace" },
  { label: "Monaco", family: "Monaco, monospace" },
  { label: "Fira Code", family: '"Fira Code", monospace' },
  { label: "Cascadia Code", family: '"Cascadia Code", monospace' },
  { label: "Iosevka", family: "Iosevka, monospace" },
  { label: "IBM Plex Mono", family: '"IBM Plex Mono", monospace' },
  { label: "Hack", family: "Hack, monospace" },
  { label: "Berkeley Mono", family: '"Berkeley Mono", monospace' },
];

const THEMES: Array<{ id: ThemeId; name: string; swatch: [string, string, string] }> = [
  { id: "neon", name: "Neón", swatch: ["#0a0d0c", "#e6f1ea", "#00e356"] },
  { id: "fosforo", name: "Fósforo", swatch: ["#0f0e0c", "#e6dfd2", "#ffb224"] },
  { id: "fosforo-verde", name: "Fósforo verde", swatch: ["#0d0f0d", "#d8f0dc", "#6fe39a"] },
  { id: "papel", name: "Papel", swatch: ["#f6f3ec", "#1d1a15", "#8c4b00"] },
];

const EDITOR_NAMES: Record<string, string> = { cursor: "Cursor", code: "VS Code", zed: "Zed", subl: "Sublime Text" };
const isEditorId = (e: string): e is EditorId => e in EDITOR_NAMES;
/** Referencia estable: un `[]` nuevo en cada lectura del store provoca un bucle de renders. */
const NO_EDITORS: string[] = [];

export const SettingsDialog: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const isOpen = useUiStore((s) => s.isSettingsOpen);
  if (!isOpen) return null;
  return <SettingsPanel onClosed={onClosed} />;
};

const SettingsPanel: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const replace = useSettingsStore((s) => s.replace);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const askConfirm = useUiStore((s) => s.askConfirm);
  const editors = useTerminalStore((s) => s.agents?.editors ?? NO_EDITORS);
  const shells = useTerminalStore((s) => s.shells);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const fonts = useMemo(
    () =>
      FONT_CANDIDATES.filter((f) => {
        if (f.bundled) return true;
        const name = f.family.split(",")[0].replace(/"/g, "");
        try {
          return document.fonts.check(`12px "${name}"`) && name !== "monospace";
        } catch {
          return false;
        }
      }),
    [],
  );

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const close = () => {
    setOpen(false);
    onClosed();
  };
  const set = <K extends keyof Settings>(key: K) => (value: Settings[K]) => update({ [key]: value } as Partial<Settings>);

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
      className="fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-canvas/60 px-4 pt-[7vh]"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex max-h-[84vh] w-full max-w-[640px] animate-pop-in flex-col overflow-hidden rounded-lg border border-[var(--glass-border)] glass outline-none"
      >
        <div className="flex h-11 shrink-0 items-center border-b border-line pl-4 pr-2">
          <h2 id="settings-title" className="flex-1 text-[13px] font-medium text-ink">
            Ajustes
          </h2>
          <IconButton icon={X} label="Cerrar ajustes" shortcut="esc" size="sm" onClick={close} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          <Section title="Apariencia">
            <Row label="Tema">
              <div role="radiogroup" aria-label="Tema" className="flex gap-2">
                {THEMES.map((theme) => (
                  <button
                    key={theme.id}
                    type="button"
                    role="radio"
                    aria-checked={settings.theme === theme.id}
                    onClick={() => set("theme")(theme.id)}
                    className={cn(
                      "flex flex-col items-start gap-1.5 rounded-md border p-2 text-[12px] transition-colors duration-150",
                      settings.theme === theme.id ? "border-accent text-ink" : "border-line text-ink-2 hover:border-line-strong",
                    )}
                  >
                    <span className="flex h-7 w-24 overflow-hidden rounded-sm border border-line" aria-hidden="true">
                      <span className="flex-[3]" style={{ background: theme.swatch[0] }} />
                      <span className="flex-1" style={{ background: theme.swatch[1] }} />
                      <span className="flex-1" style={{ background: theme.swatch[2] }} />
                    </span>
                    {theme.name}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="Fuente">
              <Select
                value={fonts.some((f) => f.family === settings.fontFamily) ? settings.fontFamily : DEFAULT_FONT}
                onChange={set("fontFamily")}
                options={fonts.map((f) => ({ value: f.family, label: f.label }))}
              />
            </Row>
            <Row label="Tamaño" hint={`También con ${shortcutLabel("fontBigger")} / ${shortcutLabel("fontSmaller")} / ${shortcutLabel("fontReset")}`}>
              <Stepper value={settings.fontSize} {...LIMITS.fontSize} step={1} suffix="px" onChange={set("fontSize")} />
            </Row>
            <Row label="Interlineado">
              <Stepper value={settings.lineHeight} {...LIMITS.lineHeight} step={0.05} onChange={set("lineHeight")} format={(v) => v.toFixed(2)} />
            </Row>
            <Row label="Cursor">
              <Segmented
                value={settings.cursorStyle}
                onChange={set("cursorStyle")}
                options={[
                  { value: "block", label: "Bloque" },
                  { value: "bar", label: "Barra" },
                  { value: "underline", label: "Subrayado" },
                ]}
              />
            </Row>
            <Toggle label="Cursor parpadeante" checked={settings.cursorBlink} onChange={set("cursorBlink")} />
            <Toggle label="Atenuar paneles inactivos" checked={settings.dimInactivePanes} onChange={set("dimInactivePanes")} />
          </Section>

          <Section title="Terminal">
            <Row label="Bienvenida en terminales nuevas" hint="El logo, tus agentes y los atajos en cada shell nueva (pestaña, división o rápida) y tras `clear`. Nunca en agentes">
              <Segmented
                value={settings.welcomeBanner}
                onChange={set("welcomeBanner")}
                options={[
                  { value: "full", label: "Completa" },
                  { value: "compact", label: "Compacta" },
                  { value: "off", label: "No" },
                ]}
              />
            </Row>
            <Toggle
              label={`Integración con ${IS_WINDOWS ? "PowerShell" : "zsh"}`}
              hint={`Marcas de comando, ${shortcutLabel("prevCommand")}/${shortcutLabel("nextCommand")}, avisos y carpeta en vivo. Aplica a terminales nuevas.`}
              checked={settings.shellIntegration}
              onChange={set("shellIntegration")}
            />
            {shells && shells.length > 1 && (
              <Row label="Shell de las pestañas nuevas" hint="Las divisiones usan la de su panel. Solo zsh trae la integración (marcas de comando, carpeta en vivo)">
                <Select
                  value={settings.defaultShell && shells.some((sh) => sh.path === settings.defaultShell) ? settings.defaultShell : ""}
                  onChange={set("defaultShell")}
                  options={[
                    { value: "", label: `La del sistema (${shells.find((sh) => sh.default)?.name ?? "predeterminada"})` },
                    ...shells.filter((sh) => !sh.default).map((sh) => ({ value: sh.path, label: `${sh.name} · ${sh.path}` })),
                  ]}
                />
              </Row>
            )}
            <Toggle
              label="Restaurar lo que había en cada terminal"
              hint="Al reabrir termCode, cada panel vuelve con sus últimas 1000 líneas. Se guardan solo en tu equipo; desactívalo si imprimes secretos en la terminal"
              checked={settings.restoreScrollback}
              onChange={set("restoreScrollback")}
            />
            <Row label="Historial" hint="Líneas que se guardan por panel">
              <Stepper value={settings.scrollback} {...LIMITS.scrollback} step={1000} onChange={set("scrollback")} format={(v) => v.toLocaleString("es-MX")} />
            </Row>
            <Toggle label="Confirmar al cerrar con procesos en ejecución" checked={settings.confirmClose} onChange={set("confirmClose")} />
            <Toggle
              label="Avisar cuando termina un comando largo"
              hint="Solo si no estabas mirando ese panel"
              checked={settings.notifyLongCommands}
              onChange={set("notifyLongCommands")}
            />
            {settings.notifyLongCommands && (
              <Row label="Considerar largo a partir de">
                <Stepper value={settings.longCommandSeconds} {...LIMITS.longCommandSeconds} step={5} suffix="s" onChange={set("longCommandSeconds")} />
              </Row>
            )}
          </Section>

          <Section title="Rutas y editor">
            <Row label={`${CLICK_MOD}-clic en una ruta abre`}>
              <Segmented
                value={settings.openPathsIn}
                onChange={set("openPathsIn")}
                options={[
                  { value: "editor", label: "Tu editor" },
                  { value: "viewer", label: "Visor de termCode" },
                ]}
              />
            </Row>
            <Row label="Editor">
              <Select
                value={settings.editor}
                onChange={set("editor")}
                options={[
                  { value: "auto", label: editors.length ? `Automático (${EDITOR_NAMES[editors[0]]})` : "Automático" },
                  ...editors.filter(isEditorId).map((e) => ({ value: e, label: EDITOR_NAMES[e] ?? e })),
                  { value: "system", label: "App predeterminada del sistema" },
                ]}
              />
            </Row>
          </Section>

          <Section title="Terminal rápida">
            <Toggle
              label="Activar con un atajo global"
              hint="Baja una terminal desde arriba sobre cualquier app"
              checked={settings.quickTerminal}
              onChange={set("quickTerminal")}
            />
            {settings.quickTerminal && (
              <>
                <Row label="Atajo" hint={IS_MAC ? "Formato: Alt+Space, Cmd+Shift+T…" : "Formato: Ctrl+Alt+Space, Ctrl+Shift+T…"}>
                  <ShortcutInput value={settings.quickShortcut} onChange={set("quickShortcut")} />
                </Row>
                <Toggle label="Ocultar al perder el foco" checked={settings.quickHideOnBlur} onChange={set("quickHideOnBlur")} />
              </>
            )}
          </Section>

          <Section title="Agentes">
            <Toggle
              label="Avisar si la cuota de 5 h está casi agotada"
              hint="Antes de lanzar Claude Code o Codex con la sesión al 90 % o más"
              checked={settings.quotaGuard}
              onChange={set("quotaGuard")}
            />
            <Toggle
              label="Claude puede leer otros paneles"
              hint="Herramientas MCP de solo lectura: list_panes y read_pane. Aplica a agentes nuevos"
              checked={settings.agentsReadPanes}
              onChange={set("agentsReadPanes")}
            />
            <Toggle
              label="Aprobar permisos desde la bandeja"
              hint="Los permisos de Claude aparecen abajo a la derecha, estés donde estés. Si no respondes en 90 s, Claude te pregunta en su panel"
              checked={settings.approvalsInApp}
              onChange={set("approvalsInApp")}
            />
          </Section>

          <Section title="Accesibilidad">
            <Toggle
              label="Modo lector de pantalla"
              hint={`Expone el contenido del terminal a ${IS_MAC ? "VoiceOver" : "tu lector de pantalla"} (más lento con mucha salida)`}
              checked={settings.screenReader}
              onChange={set("screenReader")}
            />
            {IS_MAC && (
              <Toggle
                label="Mostrar atajos al mantener ⌘"
                hint="Medio segundo con ⌘ presionada (sin otra tecla) abre la hoja de atajos"
                checked={settings.holdHints}
                onChange={set("holdHints")}
              />
            )}
          </Section>

          <AboutSection />
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-line bg-chrome px-4 py-2.5">
          <button
            type="button"
            onClick={() =>
              askConfirm({
                title: "¿Restablecer todos los ajustes?",
                body: "Vuelven los valores de fábrica (tema, fuente, atajos…).",
                confirmLabel: "Restablecer",
                onConfirm: () => replace({ ...DEFAULT_SETTINGS, onboardingDone: settings.onboardingDone }),
              })
            }
            className="text-[12px] text-ink-3 hover:text-signal"
          >
            Restablecer valores de fábrica
          </button>
          <span className="text-[11px] text-ink-3">Los cambios se guardan solos.</span>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="border-b border-line py-3 last:border-b-0">
    <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">{title}</h3>
    <div className="flex flex-col gap-2.5">{children}</div>
  </section>
);

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="flex items-center justify-between gap-4">
    <div className="min-w-0">
      <p className="text-[13px] text-ink">{label}</p>
      {hint && <p className="text-[11.5px] text-ink-3">{hint}</p>}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

export const Toggle: React.FC<{ label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }> = ({
  label,
  hint,
  checked,
  onChange,
}) => (
  <Row label={label} hint={hint}>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 rounded-full border transition-colors duration-150",
        checked ? "border-accent bg-accent" : "border-line-strong bg-press",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-1/2 size-3.5 -translate-y-1/2 rounded-full transition-[left] duration-150",
          checked ? "left-[18px] bg-on-accent" : "left-[2px] bg-ink-3",
        )}
      />
    </button>
  </Row>
);

function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-8 max-w-[260px] rounded-md border border-line bg-canvas px-2 text-[12.5px] text-ink outline-none focus:border-line-strong"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div role="radiogroup" className="flex rounded-md border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 rounded-[4px] px-2.5 text-[12px] transition-colors duration-150",
            value === o.value ? "bg-press text-ink" : "text-ink-3 hover:text-ink-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const Stepper: React.FC<{
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}> = ({ value, min, max, step, suffix, format, onChange }) => {
  const round = (v: number) => Math.round(v * 100) / 100;
  return (
    <div className="flex h-8 items-center rounded-md border border-line">
      <button
        type="button"
        aria-label="Reducir"
        disabled={value <= min}
        onClick={() => onChange(round(Math.max(min, value - step)))}
        className="h-full w-8 text-ink-2 hover:bg-hover disabled:opacity-40"
      >
        −
      </button>
      <span className="w-20 text-center font-mono text-[12px] tabular-nums text-ink">
        {format ? format(value) : value}
        {suffix ? ` ${suffix}` : ""}
      </span>
      <button
        type="button"
        aria-label="Aumentar"
        disabled={value >= max}
        onClick={() => onChange(round(Math.min(max, value + step)))}
        className="h-full w-8 text-ink-2 hover:bg-hover disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
};

/** Se valida al confirmar (Enter o al salir del campo). */
const ShortcutInput: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const commit = (raw: string) => {
    const clean = raw.replace(/\s+/g, "");
    if (/^[\w+]{3,40}$/.test(clean) && clean !== value) onChange(clean);
  };
  return (
    <input
      defaultValue={value}
      key={value}
      spellCheck={false}
      aria-label="Atajo de la terminal rápida"
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
      }}
      className="h-8 w-44 select-text rounded-md border border-line bg-canvas px-2.5 font-mono text-[12px] text-ink outline-none focus:border-line-strong"
    />
  );
};

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo; progress: UpdateProgress | null }
  | { kind: "error"; message: string };

const formatMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Versión y actualizaciones (solo en compilaciones firmadas para actualizarse). */
const AboutSection: React.FC = () => {
  const [version, setVersion] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const askConfirm = useUiStore((s) => s.askConfirm);

  useEffect(() => {
    if (!IS_TAURI) return;
    let alive = true;
    void Promise.all([getVersion().catch(() => null), updatesSupported()]).then(([v, ok]) => {
      if (!alive) return;
      setVersion(v);
      setSupported(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  const check = async () => {
    setState({ kind: "checking" });
    try {
      const info = await checkForUpdate();
      setState(info ? { kind: "available", info } : { kind: "current" });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const install = (info: UpdateInfo) =>
    askConfirm({
      title: `¿Instalar termCode ${info.version} y reiniciar?`,
      body: "termCode se cierra y vuelve a abrir: tus pestañas y carpetas se restauran, pero los procesos que estén corriendo en las terminales terminan.",
      confirmLabel: "Instalar y reiniciar",
      onConfirm: () => {
        setState({ kind: "installing", info, progress: null });
        installUpdate((progress) => setState({ kind: "installing", info, progress })).catch((err: unknown) =>
          setState({ kind: "error", message: err instanceof Error ? err.message : String(err) }),
        );
      },
    });

  const percent =
    state.kind === "installing" && state.progress?.total ? Math.round((state.progress.downloaded / state.progress.total) * 100) : null;

  return (
    <Section title="Acerca de">
      <div className="flex items-center gap-3 py-1">
        <LogoMark title="termCode" className="h-6 w-auto text-ink" />
        <span className="text-[11.5px] text-ink-3">by CODERGENIUS MX</span>
      </div>
      <Row label="termCode" hint={version ? `Versión ${version}` : "Versión de desarrollo"}>
        {supported ? (
          <button
            type="button"
            onClick={() => void check()}
            disabled={state.kind === "checking" || state.kind === "installing"}
            className="h-7 rounded-md border border-line px-2.5 text-[12px] text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-50"
          >
            {state.kind === "checking" ? "Buscando…" : "Buscar actualizaciones"}
          </button>
        ) : (
          <span className="text-[11.5px] text-ink-3">{supported === null ? "" : "Sin actualizaciones automáticas en esta compilación"}</span>
        )}
      </Row>
      {state.kind === "current" && <p className="text-[12px] text-ink-3">Ya tienes la última versión.</p>}
      {state.kind === "error" && (
        <p role="alert" className="text-[12px] text-signal">
          {state.message}
        </p>
      )}
      {(state.kind === "available" || state.kind === "installing") && (
        <div className="rounded-md border border-accent/50 bg-accent/[0.06] p-3">
          <p className="text-[13px] text-ink">
            termCode {state.info.version} disponible
            <span className="text-ink-3"> · tienes {state.info.currentVersion}</span>
          </p>
          {state.info.notes && (
            <p className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-ink-2">{state.info.notes}</p>
          )}
          <div className="mt-2.5 flex items-center gap-3">
            {state.kind === "available" ? (
              <button
                type="button"
                onClick={() => install(state.info)}
                className="h-7 rounded-md bg-accent px-3 text-[12px] font-medium text-on-accent hover:opacity-90"
              >
                Instalar y reiniciar
              </button>
            ) : (
              <span className="font-mono text-[12px] text-ink-2" aria-live="polite">
                {state.progress
                  ? percent !== null
                    ? `Descargando… ${percent} %`
                    : `Descargando… ${formatMb(state.progress.downloaded)}`
                  : "Preparando…"}
              </span>
            )}
          </div>
        </div>
      )}
    </Section>
  );
};
