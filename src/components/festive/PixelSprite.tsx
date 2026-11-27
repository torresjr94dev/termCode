import React, { memo } from "react";
import { FESTIVE_PALETTE, SPRITES, type SpriteName } from "./sprites";

interface Run {
  x: number;
  y: number;
  w: number;
  fill: string;
}

/** Tramos horizontales del mismo color: un `<rect>` por tramo, no por pixel. */
export function spriteRuns(rows: readonly string[]): Run[] {
  const runs: Run[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      const fill = FESTIVE_PALETTE[ch];
      if (ch !== "." && fill) runs.push({ x, y, w: end - x, fill });
      x = end;
    }
  });
  return runs;
}

const cache = new Map<SpriteName, Run[]>();
function runsOf(name: SpriteName): Run[] {
  let runs = cache.get(name);
  if (!runs) {
    runs = spriteRuns(SPRITES[name]);
    cache.set(name, runs);
  }
  return runs;
}

interface PixelSpriteProps {
  name: SpriteName;
  /** CSS px por pixel del sprite. Entero: con pantallas 2× queda nítido. */
  scale?: number;
  /** Espejo horizontal (el reno mira al otro lado). */
  flip?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/** Un sprite 8-bit, decorativo (oculto para lectores de pantalla). */
export const PixelSprite: React.FC<PixelSpriteProps> = memo(({ name, scale = 1, flip, className, style }) => {
  const rows = SPRITES[name];
  const width = rows[0].length;
  const height = rows.length;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={width * scale}
      height={height * scale}
      viewBox={`0 0 ${width} ${height}`}
      shapeRendering="crispEdges"
      className={className}
      style={flip ? { ...style, transform: `${style?.transform ?? ""} scaleX(-1)`.trim() } : style}
    >
      {runsOf(name).map((r) => (
        <rect key={`${r.x}:${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
      ))}
    </svg>
  );
});
PixelSprite.displayName = "PixelSprite";
