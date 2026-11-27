import React, { useEffect, useMemo, useRef } from "react";
import { ImagePlus, Trash2, X } from "lucide-react";
import {
  DEFAULT_FONT,
  DEFAULT_SETTINGS,
  LIMITS,
  NEW_THEMES,
  useSettingsStore,
  type EditorId,
  type Settings,
  type ThemeId,
} from "../store/settingsStore";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { cn } from "../lib/layout";
import { IconButton } from "./ui";
import { LogoMark } from "./Logo";
import { UpdateControls } from "./About";
import { PixelSprite } from "./festive/PixelSprite";
import { chooseBackdrop, clearBackdrop, useBackdropStore } from "../lib/backdrop";
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
  { id: "navidad", name: "Navidad", swatch: ["#0b1512", "#eef4f0", "#ff4d6d"] },
  { id: "vidrio", name: "Vidrio líquido", swatch: ["#0c0e16", "#f4f6fb", "#7cc4ff"] },
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
            <div>
              <p className="mb-2 text-[13px] text-ink">Tema</p>
              <div role="radiogroup" aria-label="Tema" className="grid grid-cols-3 gap-2">
                {THEMES.map((theme) => (
                  <ThemeCard
                    key={theme.id}
                    theme={theme}
                    selected={settings.theme === theme.id}
                    isNew={NEW_THEMES.includes(theme.id) && !settings.themesTried.includes(theme.id)}
                    onSelect={() => set("theme")(theme.id)}
                  />
                ))}
              </div>
            </div>
            {settings.theme === "navidad" && (
              <Toggle
                label="Nieve y trineo"
                hint="Copos de pixeles y, de vez en cuando, Santa cruzando el cielo. Los foquitos y adornos se quedan. Con «reducir movimiento» del sistema no se mueve nada"
                checked={settings.festiveSnow}
                onChange={set("festiveSnow")}
              />
            )}
            {settings.theme === "vidrio" && <GlassOptions />}
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
            <Toggle
              label="Barra en cada terminal"
              hint="Carpeta, rama y Claude Code o Codex para abrirlos ahí mismo. Sin ella, una shell sola usa todo el panel; los agentes y las divisiones la llevan siempre."
              checked={settings.paneBar}
              onChange={set("paneBar")}
            />
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

/** Muestra de un tema: sus colores (o su escena) y su nombre; «Nuevo» hasta que lo pruebas. */
const ThemeCard: React.FC<{
  theme: (typeof THEMES)[number];
  selected: boolean;
  isNew: boolean;
  onSelect: () => void;
}> = ({ theme, selected, isNew, onSelect }) => (
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    aria-label={isNew ? `${theme.name} (nuevo)` : theme.name}
    onClick={onSelect}
    className={cn(
      "relative flex min-w-0 flex-col items-start gap-1.5 rounded-md border p-2 text-left text-[12px] transition-colors duration-150",
      selected ? "border-accent text-ink" : "border-line text-ink-2 hover:border-line-strong",
    )}
  >
    {isNew && (
      <span className="absolute -right-1.5 -top-1.5 z-10 rounded-full bg-accent px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.06em] text-on-accent shadow-none">
        Nuevo
      </span>
    )}
    <ThemeSwatch theme={theme} />
    <span className="truncate">{theme.name}</span>
  </button>
);

const ThemeSwatch: React.FC<{ theme: (typeof THEMES)[number] }> = ({ theme }) => {
  const [bg, ink, accent] = theme.swatch;
  if (theme.id === "navidad") {
    return (
      <span aria-hidden="true" className="relative flex h-9 w-full items-end justify-center gap-0.5 overflow-hidden rounded-sm border border-line pb-0.5" style={{ background: bg }}>
        <PixelSprite name="gift2" />
        <PixelSprite name="tree" />
        <PixelSprite name="gift" />
        <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: "repeating-linear-gradient(90deg,#ff4d6d 0 3px,transparent 3px 7px,#ffd166 7px 10px,transparent 10px 14px,#4fd182 14px 17px,transparent 17px 21px)" }} />
      </span>
    );
  }
  if (theme.id === "vidrio") {
    return (
      <span aria-hidden="true" className="lg-backdrop relative flex h-9 w-full items-center justify-center overflow-hidden rounded-sm border border-line" data-default="">
        <span
          className="h-5 w-[70%] rounded-md border border-white/25 shadow-[inset_1px_1px_0_rgb(255_255_255/0.4),0_4px_10px_-4px_rgb(0_0_0/0.6)] backdrop-blur-md"
          style={{ background: "rgb(12 14 22 / 0.45)" }}
        >
          <span className="ml-1.5 mt-1.5 block h-1 w-6 rounded-full" style={{ background: accent }} />
        </span>
      </span>
    );
  }
  return (
    <span className="flex h-9 w-full overflow-hidden rounded-sm border border-line" aria-hidden="true">
      <span className="flex-[3]" style={{ background: bg }} />
      <span className="flex-1" style={{ background: ink }} />
      <span className="flex-1" style={{ background: accent }} />
    </span>
  );
};

/** Vidrio líquido: tu imagen de fondo, opacidad y desenfoque del vidrio. */
const GlassOptions: React.FC = () => {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const url = useBackdropStore((s) => s.url);
  const floor = useBackdropStore((s) => s.floor);
  const loading = useBackdropStore((s) => s.loading);
  const clamped = floor > settings.glassTint;
  const pct = (v: number) => `${Math.round(v * 100)} %`;

  return (
    <>
      <Row label="Imagen de fondo" hint="PNG, JPG, WebP, GIF o AVIF, hasta 25 MB. termCode guarda su propia copia">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="lg-backdrop h-8 w-12 rounded-sm border border-line"
            data-default={url ? undefined : ""}
            style={url ? { backgroundImage: `url("${url}")` } : undefined}
          />
          <button
            type="button"
            onClick={() => void chooseBackdrop()}
            disabled={loading}
            className="flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-50"
          >
            <ImagePlus size={13} strokeWidth={1.75} aria-hidden="true" />
            {settings.glassImage ? "Cambiar…" : "Elegir imagen…"}
          </button>
          {settings.glassImage && (
            <button
              type="button"
              aria-label="Quitar la imagen de fondo"
              title="Quitar (vuelve el degradado de fábrica)"
              onClick={() => void clearBackdrop()}
              className="grid size-8 place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-signal"
            >
              <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </div>
      </Row>
      <Row
        label="Opacidad del vidrio"
        hint={
          clamped
            ? `Con esta imagen no baja de ${pct(floor)}: más claro, el texto no se leería`
            : "Más bajo, se ve más tu fondo; más alto, se lee mejor"
        }
      >
        <Stepper
          value={settings.glassTint}
          {...LIMITS.glassTint}
          step={0.04}
          format={pct}
          onChange={(glassTint) => update({ glassTint })}
        />
      </Row>
      <Row label="Desenfoque" hint="0 es lo más ligero para la batería">
        <Stepper value={settings.glassBlur} {...LIMITS.glassBlur} step={4} suffix="px" onChange={(glassBlur) => update({ glassBlur })} />
      </Row>
    </>
  );
};

/** Versión y actualizaciones; el resto (sistema, enlaces) en «Acerca de termCode». */
const AboutSection: React.FC = () => {
  const openAbout = useUiStore((s) => s.openAbout);
  return (
    <Section title="Acerca de">
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="flex items-center gap-3">
          <LogoMark title="termCode" className="h-6 w-auto text-ink" />
          <span className="text-[11.5px] text-ink-3">by CODERGENIUS MX</span>
        </span>
        <button
          type="button"
          onClick={() => openAbout()}
          className="h-7 rounded-md px-2.5 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          Más información…
        </button>
      </div>
      <UpdateControls />
    </Section>
  );
};
