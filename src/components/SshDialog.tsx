import React, { useEffect, useRef, useState } from "react";
import { Server, X } from "lucide-react";
import { useSidebarStore } from "../store/sidebarStore";
import { useUiStore } from "../store/uiStore";
import { validateServer, type ServerErrors, type ServerFields } from "../lib/ssh";
import { cn } from "../lib/layout";
import { IconButton, Kbd } from "./ui";

const EMPTY: ServerFields = { name: "", user: "", host: "", port: 22, identityFile: "" };

/**
 * Agregar o editar un servidor SSH. Sin campo de contraseña a propósito: la
 * autenticación es de ssh (tu agente, tus llaves, el llavero de macOS).
 */
export const SshDialog: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const dialog = useUiStore((s) => s.sshDialog);
  if (!dialog) return null;
  return <ServerForm key={dialog.id ?? "nuevo"} id={dialog.id} onClosed={onClosed} />;
};

const ServerForm: React.FC<{ id?: string; onClosed: () => void }> = ({ id, onClosed }) => {
  const existing = useSidebarStore((s) => (id ? s.servers.find((sv) => sv.id === id) : undefined));
  const saveServer = useSidebarStore((s) => s.saveServer);
  const [fields, setFields] = useState<ServerFields>(existing ?? EMPTY);
  const [errors, setErrors] = useState<ServerErrors>({});
  const first = useRef<HTMLInputElement | null>(null);

  useEffect(() => first.current?.focus(), []);

  const close = () => {
    useUiStore.getState().setSshDialog(null);
    onClosed();
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const found = validateServer(fields);
    setErrors(found);
    if (Object.keys(found).length) return;
    if (saveServer(fields, id)) {
      useUiStore.getState().showToast(`${fields.name.trim()} guardado.`);
      close();
    }
  };
  const field = <K extends keyof ServerFields>(key: K) => ({
    value: String(fields[key]),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = key === "port" ? Number(e.target.value.replace(/\D/g, "") || 0) : e.target.value;
      setFields((f) => ({ ...f, [key]: value }));
      // El error se va en cuanto se corrige, no al volver a enviar.
      if (errors[key]) setErrors((err) => ({ ...err, [key]: undefined }));
    },
    "aria-invalid": Boolean(errors[key]) || undefined,
    "aria-describedby": errors[key] ? `ssh-${key}-error` : undefined,
  });

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
      className="fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-canvas/60 px-4 pt-[14vh]"
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-title"
        onSubmit={submit}
        noValidate
        className="w-full max-w-[420px] animate-pop-in overflow-hidden rounded-lg border border-[var(--glass-border)] glass"
      >
        <div className="flex h-11 items-center gap-2 border-b border-line pl-4 pr-2">
          <Server size={14} strokeWidth={1.9} aria-hidden="true" className="text-ink-3" />
          <h2 id="ssh-title" className="flex-1 text-[13px] font-medium text-ink">
            {existing ? `Editar ${existing.name}` : "Agregar servidor SSH"}
          </h2>
          <IconButton icon={X} label="Cerrar" shortcut="esc" size="sm" onClick={close} />
        </div>
        <div className="grid grid-cols-[1fr_88px] gap-x-3 gap-y-3 px-4 py-4">
          <Field label="Nombre" error={errors.name} id="name" className="col-span-2">
            <input ref={first} placeholder="Producción" autoComplete="off" spellCheck={false} {...field("name")} />
          </Field>
          <Field label="Host" error={errors.host} id="host">
            <input placeholder="servidor.ejemplo.mx o 10.0.0.5" autoComplete="off" spellCheck={false} {...field("host")} />
          </Field>
          <Field label="Puerto" error={errors.port} id="port">
            <input inputMode="numeric" {...field("port")} />
          </Field>
          <Field label="Usuario" hint="Vacío: el de tu ~/.ssh/config o tu usuario" error={errors.user} id="user" className="col-span-2">
            <input placeholder="deploy" autoComplete="off" spellCheck={false} {...field("user")} />
          </Field>
          <Field label="Llave privada" hint="Opcional. Sin ella, ssh usa tu agente y tus llaves de siempre" error={errors.identityFile} id="identityFile" className="col-span-2">
            <input placeholder="~/.ssh/id_ed25519" autoComplete="off" spellCheck={false} {...field("identityFile")} />
          </Field>
          <p className="col-span-2 text-[11.5px] leading-relaxed text-ink-3">
            termCode no guarda contraseñas: si el servidor la pide, la escribes en la terminal y la recibe ssh.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-chrome px-3 py-2.5">
          <button type="button" onClick={close} className="flex h-7 items-center gap-2 rounded-md px-2.5 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink">
            Cancelar <Kbd>esc</Kbd>
          </button>
          <button type="submit" className="flex h-7 items-center gap-2 rounded-md bg-accent px-3 text-[12px] font-medium text-on-accent transition-opacity duration-150 hover:opacity-90">
            Guardar <Kbd className="text-on-accent/70">↵</Kbd>
          </button>
        </div>
      </form>
    </div>
  );
};

/** Etiqueta visible, ayuda y error junto al campo (no solo arriba del formulario). */
const Field: React.FC<{ label: string; id: string; hint?: string; error?: string; className?: string; children: React.ReactElement<React.InputHTMLAttributes<HTMLInputElement>> }> = ({
  label,
  id,
  hint,
  error,
  className,
  children,
}) => (
  <label className={cn("flex min-w-0 flex-col gap-1", className)} htmlFor={`ssh-${id}`}>
    <span className="text-[11.5px] font-medium text-ink-2">{label}</span>
    {React.cloneElement(children, {
      id: `ssh-${id}`,
      className: cn(
        "h-8 rounded-md border bg-raised px-2.5 font-mono text-[12px] text-ink outline-none transition-colors duration-150 placeholder:text-ink-3/60 focus:border-accent/60",
        error ? "border-signal/70" : "border-line",
      ),
    })}
    {error ? (
      <span id={`ssh-${id}-error`} role="alert" className="text-[11px] text-signal">
        {error}
      </span>
    ) : (
      hint && <span className="text-[11px] text-ink-3">{hint}</span>
    )}
  </label>
);
