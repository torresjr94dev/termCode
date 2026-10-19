/**
 * Marcas de conflicto de git (también el estilo diff3/zdiff3 con la base):
 *
 *   <<<<<<< HEAD
 *   lo tuyo
 *   ||||||| base
 *   lo que había
 *   =======
 *   lo que llega
 *   >>>>>>> otra-rama
 */

export type ConflictChunk =
  | { kind: "text"; lines: string[] }
  | {
      kind: "conflict";
      ours: string[];
      base: string[] | null;
      theirs: string[];
      oursLabel: string;
      theirsLabel: string;
    };

export type Choice = "ours" | "theirs" | "both";

const label = (line: string, marker: string) => line.slice(marker.length).trim();

/** Parte el archivo en texto común y bloques en conflicto. Un bloque mal cerrado queda como texto. */
export function parseConflicts(text: string): ConflictChunk[] {
  const lines = text.split("\n");
  const chunks: ConflictChunk[] = [];
  let plain: string[] = [];
  let i = 0;

  const flush = () => {
    if (plain.length) chunks.push({ kind: "text", lines: plain });
    plain = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith("<<<<<<<")) {
      plain.push(line);
      i++;
      continue;
    }
    // Buscar el cierre antes de decidir: si no lo hay, todo sigue siendo texto.
    const start = i;
    const ours: string[] = [];
    const theirs: string[] = [];
    let base: string[] | null = null;
    let section: "ours" | "base" | "theirs" = "ours";
    let theirsLabel = "";
    let closed = false;
    i++;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (section === "ours" && l.startsWith("|||||||")) {
        section = "base";
        base = [];
      } else if (section !== "theirs" && /^=======\r?$/.test(l)) {
        section = "theirs";
      } else if (section === "theirs" && l.startsWith(">>>>>>>")) {
        theirsLabel = label(l, ">>>>>>>");
        closed = true;
        i++;
        break;
      } else if (l.startsWith("<<<<<<<")) {
        break; // anidado o roto: no lo interpretamos
      } else if (section === "ours") {
        ours.push(l);
      } else if (section === "base") {
        base?.push(l);
      } else {
        theirs.push(l);
      }
    }
    if (!closed) {
      plain.push(...lines.slice(start, i === start ? start + 1 : i));
      if (i === start) i++;
      continue;
    }
    flush();
    chunks.push({ kind: "conflict", ours, base, theirs, oursLabel: label(line, "<<<<<<<"), theirsLabel });
  }
  flush();
  return chunks;
}

export const conflictCount = (chunks: ConflictChunk[]) => chunks.filter((c) => c.kind === "conflict").length;

/** Contenido final con una elección por bloque; `null` si falta alguno. */
export function resolveConflicts(chunks: ConflictChunk[], choices: Array<Choice | undefined>): string | null {
  const out: string[] = [];
  let index = 0;
  for (const chunk of chunks) {
    if (chunk.kind === "text") {
      out.push(...chunk.lines);
      continue;
    }
    const choice = choices[index++];
    if (!choice) return null;
    if (choice !== "theirs") out.push(...chunk.ours);
    if (choice !== "ours") out.push(...chunk.theirs);
  }
  return out.join("\n");
}
