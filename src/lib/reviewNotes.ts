/**
 * Comentarios por línea sobre un diff, que se mandan juntos al agente como
 * una revisión ("en schema.ts:40 cambia esto…"), igual que en un PR.
 */
export interface ReviewNote {
  id: string;
  /** Árbol del diff (repo o worktree del agente): las notas de cada uno van a su agente. */
  root: string;
  path: string;
  /** `new` = línea del archivo actual; `old` = línea que el cambio borró. */
  side: "old" | "new";
  line: number;
  /** El texto de la línea comentada, para que el agente la ubique aunque el archivo se mueva. */
  quote: string;
  text: string;
}

export const noteAnchor = (side: ReviewNote["side"], line: number) => `${side}:${line}`;

/** La revisión tal como la lee el agente: ordenada por archivo y línea, con la línea citada. */
export function formatReview(notes: ReviewNote[]): string {
  const sorted = [...notes].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.side.localeCompare(b.side));
  const items = sorted.map((note, i) => {
    const where = `${note.path}:${note.line}${note.side === "old" ? " (línea que borraste)" : ""}`;
    const quote = note.quote.trim() ? `\n   > ${note.quote.trim()}` : "";
    const text = note.text
      .trim()
      .split("\n")
      .map((line) => `   ${line}`)
      .join("\n");
    return `${i + 1}. ${where}${quote}\n${text}`;
  });
  const intro = notes.length === 1 ? "Revisé tus cambios. Atiende este comentario:" : "Revisé tus cambios. Atiende estos comentarios:";
  return `${intro}\n\n${items.join("\n\n")}\n`;
}
