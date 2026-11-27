/**
 * Adornos del tema Navidad, todos decorativos: no reciben clics, los lectores
 * de pantalla no los ven y nada tapa el texto de una terminal más que un copo
 * de nieve de 2–4 px de paso. Con «reducir movimiento» no hay nieve ni
 * trineo, y los foquitos no parpadean.
 *
 * - Guirnalda de foquitos colgada del borde de arriba de la ventana.
 * - Nieve de pixeles (se apaga en Ajustes) y, de vez en cuando, Santa en su
 *   trineo cruzando el cielo.
 * - En la barra de estado: árbol, regalos, muñeco de nieve y bastón.
 * - Gorro de Santa en la pestaña activa, y nieve acumulada sobre cada tarjeta
 *   (esto último es CSS: ver index.css).
 */
import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSettingsStore } from "../../store/settingsStore";
import { PixelSprite } from "./PixelSprite";

export const useFestive = () => useSettingsStore((s) => s.settings.theme === "navidad");

function subscribeReducedMotion(cb: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", cb);
  return () => query.removeEventListener("change", cb);
}
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function useReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, reducedMotion, () => false);
}

function subscribeWidth(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}
/** Ancho redondeado a 48 px: cambiar el tamaño de la ventana no repinta la guirnalda en cada pixel. */
const windowWidth = () => Math.ceil(window.innerWidth / 48) * 48;

/** Generador fijo: la nieve cae igual en cada arranque (y en cada render). */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/* ------------------------------------------------------------------ */
/* Capa de toda la ventana                                             */
/* ------------------------------------------------------------------ */

export const FestiveLayer: React.FC = () => {
  const festive = useFestive();
  const snow = useSettingsStore((s) => s.settings.festiveSnow);
  const still = useReducedMotion();
  if (!festive) return null;
  return (
    <>
      <Garland still={still} />
      {snow && !still && <Snowfall />}
      {snow && !still && <SleighFlyby />}
    </>
  );
};

const BULB_COLORS = ["#ff4d6d", "#ffd166", "#4fd182", "#7fb2ff", "#e08ad6"];
/** Distancia entre ganchos de la guirnalda y foquitos por tramo. */
const SPAN = 96;
const BULBS_PER_SPAN = 4;
const SAG = 5;

/** Un cable que cuelga entre ganchos con foquitos que se encienden por turnos. */
const Garland: React.FC<{ still: boolean }> = ({ still }) => {
  const width = useSyncExternalStore(subscribeWidth, windowWidth, () => 1440);
  const spans = Math.ceil(width / SPAN);
  const { wire, bulbs } = useMemo(() => {
    const path: string[] = [];
    const lights: Array<{ x: number; y: number; color: string; phase: number }> = [];
    for (let i = 0; i < spans; i++) {
      const x0 = i * SPAN;
      path.push(`M${x0} 1 Q${x0 + SPAN / 2} ${1 + SAG * 2} ${x0 + SPAN} 1`);
      for (let b = 1; b <= BULBS_PER_SPAN; b++) {
        const t = b / (BULBS_PER_SPAN + 1);
        // Punto de la curva cuadrática (y(t) = 1 + 2·SAG·2t(1-t)).
        const y = 1 + SAG * 2 * 2 * t * (1 - t);
        const n = i * BULBS_PER_SPAN + b;
        lights.push({ x: Math.round(x0 + SPAN * t), y: Math.round(y), color: BULB_COLORS[n % BULB_COLORS.length], phase: n % 3 });
      }
    }
    return { wire: path.join(" "), bulbs: lights };
  }, [spans]);

  return (
    <svg
      aria-hidden="true"
      className="festive-garland pointer-events-none fixed left-0 top-0 z-[25]"
      width={spans * SPAN}
      height={SAG + 12}
      shapeRendering="crispEdges"
    >
      <path d={wire} fill="none" stroke="#2f4a3e" strokeWidth={1} />
      {bulbs.map((b) => (
        <g key={`${b.x}`} className={still ? undefined : `festive-bulb festive-bulb-${b.phase}`}>
          <rect x={b.x - 1} y={b.y} width={3} height={1} fill="#556b61" />
          <rect x={b.x - 1} y={b.y + 1} width={3} height={4} fill={b.color} />
          <rect x={b.x} y={b.y + 5} width={1} height={1} fill={b.color} />
          <rect x={b.x - 1} y={b.y + 1} width={1} height={1} fill="#ffffff" opacity={0.7} />
        </g>
      ))}
    </svg>
  );
};

const FLAKES = 28;

/** Copos cuadrados (pixeles) y unos pocos copos grandes de sprite. */
const Snowfall: React.FC = () => {
  const flakes = useMemo(() => {
    const rand = seeded(1225);
    return Array.from({ length: FLAKES }, (_, i) => {
      const duration = 11 + rand() * 13;
      return {
        id: i,
        left: rand() * 100,
        size: 2 + Math.floor(rand() * 3),
        duration,
        delay: -rand() * duration,
        drift: Math.round((rand() - 0.5) * 80),
        opacity: 0.45 + rand() * 0.4,
        sprite: i % 4 === 0,
      };
    });
  }, []);
  return (
    <div aria-hidden="true" className="festive-snow">
      {flakes.map((f) => (
        <div
          key={f.id}
          className="festive-flake"
          style={
            {
              left: `${f.left}%`,
              width: f.sprite ? undefined : f.size,
              height: f.sprite ? undefined : f.size,
              opacity: f.opacity,
              animationDuration: `${f.duration}s`,
              animationDelay: `${f.delay}s`,
              "--drift": `${f.drift}px`,
              background: f.sprite ? "transparent" : undefined,
            } as React.CSSProperties
          }
        >
          {f.sprite && <PixelSprite name="flake" />}
        </div>
      ))}
    </div>
  );
};

/** Primer paso a los 25 s; luego cada 3 min. */
const FIRST_FLIGHT_MS = 25_000;
const FLIGHT_EVERY_MS = 180_000;
const FLIGHT_MS = 16_000;

/** Santa cruza el cielo (de derecha a izquierda) de vez en cuando. */
const SleighFlyby: React.FC = () => {
  const [flight, setFlight] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (ms: number) => {
      timer = setTimeout(() => {
        // Con la ventana escondida nadie lo ve: espera a la próxima.
        if (!document.hidden) setFlight((n) => n + 1);
        schedule(FLIGHT_EVERY_MS);
      }, ms);
    };
    schedule(FIRST_FLIGHT_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!flight) return null;
  return (
    <div
      key={flight}
      aria-hidden="true"
      className="festive-sleigh pointer-events-none fixed top-[58px] z-[16] flex items-end gap-1"
      style={{ animationDuration: `${FLIGHT_MS}ms` }}
    >
      <PixelSprite name="reindeer" scale={2} />
      <PixelSprite name="reindeer" scale={2} className="-ml-2" />
      <span className="mb-3 h-px w-3 bg-[#8b5a2b]" />
      <PixelSprite name="sleigh" scale={2} flip />
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Piezas que van dentro de otros componentes                           */
/* ------------------------------------------------------------------ */

/** Escena al final de la barra de estado. Solo con espacio de sobra. */
export const FestiveStatus: React.FC = () => {
  const festive = useFestive();
  if (!festive) return null;
  return (
    <span aria-hidden="true" className="pointer-events-none hidden shrink-0 items-end gap-1 self-end pb-px xl:flex">
      <PixelSprite name="cane" />
      <PixelSprite name="gift2" />
      <PixelSprite name="tree" />
      <PixelSprite name="gift" />
      <PixelSprite name="snowman" />
    </span>
  );
};

/**
 * Santa y sus cosas en el hueco libre de la barra de título (va dentro de un
 * `@container`): solo aparece si cabe entera, nunca cortada ni empujando nada.
 */
export const HeaderFestive: React.FC = () => {
  const festive = useFestive();
  if (!festive) return null;
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 hidden items-center gap-2 @min-[170px]:flex">
      <PixelSprite name="bell" className="animate-[festive-swing_2.8s_ease-in-out_infinite] [transform-origin:50%_0]" />
      <PixelSprite name="gift" />
      <PixelSprite name="santa" />
      <PixelSprite name="tree" />
      <PixelSprite name="gift2" />
    </span>
  );
};

/** Estrella junto al logo de la barra lateral. */
export const SidebarFestive: React.FC = () => {
  const festive = useFestive();
  if (!festive) return null;
  return <PixelSprite name="star" className="pointer-events-none" />;
};

/** Gorro de Santa sobre la pestaña activa. */
export const SantaHat: React.FC = () => (
  <PixelSprite name="hat" className="pointer-events-none absolute -left-1 -top-1 z-20 -rotate-[18deg]" />
);
