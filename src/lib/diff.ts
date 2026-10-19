/** Unified diff (salida de `git diff`) → filas listas para pintar. */

export type RowKind = "context" | "add" | "del" | "hunk" | "meta";

export interface DiffRow {
  kind: RowKind;
  text: string;
  oldNo?: number;
  newNo?: number;
  /** Tramo que realmente cambió dentro de la línea [inicio, fin) — solo en pares del/add. */
  changed?: [number, number];
}

export interface ParsedDiff {
  rows: DiffRow[];
  additions: number;
  deletions: number;
  binary: boolean;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Líneas de cabecera que no aportan al leer (las de rename/modo sí se muestran). */
function isNoiseHeader(line: string): boolean {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("similarity index ")
  );
}

/**
 * Marca el tramo distinto entre una línea borrada y su reemplazo (prefijo y
 * sufijo comunes fuera). Suficiente para ver "qué cambió" sin un diff por
 * palabras completo.
 */
export function changedSpan(a: string, b: string): { a: [number, number]; b: [number, number] } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  // Si casi toda la línea cambió, resaltar no ayuda.
  const similar = start + (a.length - endA) >= Math.min(a.length, b.length) * 0.3;
  return similar ? { a: [start, endA], b: [start, endB] } : null;
}

/** 0–1: cuánto comparten dos líneas (prefijo + sufijo comunes). */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (!longest) return 1;
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return (prefix + suffix) / longest;
}

const PAIR_THRESHOLD = 0.5;
const PAIR_LOOKAHEAD = 8;

/**
 * Empareja cada línea borrada con su reemplazo más parecido (en orden y con
 * ventana corta), no por posición: si se insertó una línea al inicio del
 * bloque, el resto sigue emparejándose bien.
 */
function markPairs(rows: DiffRow[]) {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "del") {
      i++;
      continue;
    }
    const dels: DiffRow[] = [];
    while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++]);
    const adds: DiffRow[] = [];
    while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);

    let next = 0;
    for (const del of dels) {
      let best = -1;
      let bestScore = PAIR_THRESHOLD;
      for (let j = next; j < Math.min(adds.length, next + PAIR_LOOKAHEAD); j++) {
        const score = similarity(del.text, adds[j].text);
        if (score > bestScore) {
          best = j;
          bestScore = score;
        }
      }
      if (best === -1) continue;
      const span = changedSpan(del.text, adds[best].text);
      if (span) {
        del.changed = span.a;
        adds[best].changed = span.b;
      }
      next = best + 1;
    }
  }
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const rows: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const line of text.split("\n")) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: hunk[3].trim() || line });
      continue;
    }
    if (line.startsWith("diff --git ")) inHunk = false;
    if (!inHunk) {
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) binary = true;
      else if (line && !isNoiseHeader(line)) rows.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
      additions++;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
      deletions++;
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line }); // "\ No newline at end of file"
    }
  }

  markPairs(rows);
  return { rows, additions, deletions, binary };
}

export interface SplitRow {
  left?: DiffRow;
  right?: DiffRow;
  /** Filas que ocupan ambas columnas (hunks, meta). */
  full?: DiffRow;
}

/** Vista lado a lado: borrados a la izquierda, altas a la derecha, alineados por bloque. */
export function toSplitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === "hunk" || row.kind === "meta") {
      out.push({ full: row });
      i++;
    } else if (row.kind === "context") {
      out.push({ left: row, right: row });
      i++;
    } else {
      const dels: DiffRow[] = [];
      const adds: DiffRow[] = [];
      while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++]);
      while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k], right: adds[k] });
    }
  }
  return out;
}
