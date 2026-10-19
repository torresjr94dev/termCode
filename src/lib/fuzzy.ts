/**
 * Coincidencia difusa para rutas y nombres (⌘P, ramas): las letras de la
 * búsqueda aparecen en orden. Puntúa más los inicios de palabra, las letras
 * seguidas y lo que cae en el nombre del archivo.
 */

export interface FuzzyMatch {
  score: number;
  /** Índices de `target` que coinciden (para resaltarlos). */
  positions: number[];
}

const BOUNDARY = new Set(["/", ".", "_", "-", " ", "@"]);

function isBoundary(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1];
  if (BOUNDARY.has(prev)) return true;
  // camelCase: la mayúscula tras una minúscula empieza palabra.
  const ch = target[i];
  return ch !== ch.toLowerCase() && prev === prev.toLowerCase() && prev !== prev.toUpperCase();
}

/** Chequeo barato antes del alineamiento: ¿aparecen las letras en orden? */
function isSubsequence(query: string, lower: string): boolean {
  let at = 0;
  for (const ch of query) {
    at = lower.indexOf(ch, at);
    if (at === -1) return false;
    at++;
  }
  return true;
}

const CONSECUTIVE = 5;

/**
 * Alineamiento óptimo (programación dinámica, O(consulta × objetivo)): elige
 * para cada letra la aparición que más puntúa, no la primera que encuentra.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, positions: [] };
  const lower = target.toLowerCase();
  if (!isSubsequence(q, lower)) return null;

  const n = target.length;
  const baseStart = target.lastIndexOf("/") + 1;
  const charScore = (i: number) => 1 + (isBoundary(target, i) ? 8 : 0) + (i >= baseStart ? 4 : 0);

  let prev = new Float64Array(n).fill(-Infinity);
  const back: Int32Array[] = [];
  for (let k = 0; k < q.length; k++) {
    const cur = new Float64Array(n).fill(-Infinity);
    const from = new Int32Array(n).fill(-1);
    let bestBefore = -Infinity;
    let bestBeforeAt = -1;
    for (let i = 0; i < n; i++) {
      // Mejor letra anterior que no sea la inmediatamente previa (esa suma el bono de seguidas).
      if (k > 0 && i >= 2 && prev[i - 2] > bestBefore) {
        bestBefore = prev[i - 2];
        bestBeforeAt = i - 2;
      }
      if (lower[i] !== q[k]) continue;
      if (k === 0) {
        cur[i] = charScore(i);
        continue;
      }
      let best = bestBefore;
      let at = bestBeforeAt;
      if (i >= 1 && prev[i - 1] + CONSECUTIVE > best) {
        best = prev[i - 1] + CONSECUTIVE;
        at = i - 1;
      }
      if (best === -Infinity) continue;
      cur[i] = best + charScore(i);
      from[i] = at;
    }
    back.push(from);
    prev = cur;
  }

  let end = -1;
  for (let i = 0; i < n; i++) if (prev[i] > (end === -1 ? -Infinity : prev[end])) end = i;
  if (end === -1 || prev[end] === -Infinity) return null;

  const positions: number[] = new Array(q.length);
  for (let k = q.length - 1, i = end; k >= 0; k--) {
    positions[k] = i;
    i = back[k][i];
  }
  // A igualdad, gana la ruta más corta.
  return { score: prev[end] - n * 0.02, positions };
}

/** Los `limit` mejores, ordenados por puntuación. */
export function fuzzyFilter<T>(items: readonly T[], query: string, key: (item: T) => string, limit = 50): Array<{ item: T } & FuzzyMatch> {
  const results: Array<{ item: T } & FuzzyMatch> = [];
  for (const item of items) {
    const match = fuzzyMatch(query, key(item));
    if (match) results.push({ item, ...match });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
