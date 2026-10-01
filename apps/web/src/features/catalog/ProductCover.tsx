import type { CatalogProduct } from "@pandora/contracts";
import type { ReactNode } from "react";
import styles from "./Catalog.module.css";

// Original, fictional cover art (overview §8): abstract shapes generated deterministically from the product ID,
// so every game keeps the same cover and no external artwork is needed.
const PALETTES = [
  { paper: "#eadbca", soft: "#d4a98c", strong: "#a4523a", ink: "#3b2a22" },
  { paper: "#e1e4d4", soft: "#a9b996", strong: "#5e7355", ink: "#2c3328" },
  { paper: "#efe2c2", soft: "#d8b267", strong: "#80561a", ink: "#3a2e1a" },
  { paper: "#dfe3e6", soft: "#9fb1bf", strong: "#4d6577", ink: "#243039" },
  { paper: "#eadde2", soft: "#bb97a6", strong: "#6f4458", ink: "#2d1f27" },
] as const;
type Palette = (typeof PALETTES)[number];

/** FNV-1a hash and mulberry32 generator: stable pseudo-random numbers per product. */
function randomFor(seed: string): () => number {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function Sunrise({ p, random }: { p: Palette; random: () => number }) {
  const cx = 120 + random() * 160;
  return (
    <>
      {[150, 115, 80].map((r, i) => (
        <circle key={r} cx={cx} cy={210} r={r} fill={i === 2 ? p.strong : p.soft} opacity={0.35 + i * 0.25} />
      ))}
      <path d={`M0 215 Q ${100 + random() * 60} ${175 + random() * 20} 200 205 T 400 ${190 + random() * 20} V300 H0Z`} fill={p.ink} opacity={0.8} />
      <path d="M0 250 Q 120 225 240 248 T 400 240 V300 H0Z" fill={p.strong} opacity={0.7} />
    </>
  );
}

function Tiles({ p, random }: { p: Palette; random: () => number }) {
  const cells: ReactNode[] = [];
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      const x = column * 48 + (row % 2) * 24 - 10;
      const y = row * 42 + 20;
      const roll = random();
      const fill = roll > 0.82 ? p.strong : roll > 0.55 ? p.soft : "none";
      cells.push(
        <polygon
          key={`${row}-${column}`}
          points={`${x},${y + 12} ${x + 20},${y} ${x + 40},${y + 12} ${x + 40},${y + 36} ${x + 20},${y + 48} ${x},${y + 36}`}
          fill={fill}
          stroke={p.ink}
          strokeOpacity={0.25}
          strokeWidth={1.5}
          opacity={0.85}
        />,
      );
    }
  }
  return <>{cells}</>;
}

function Tokens({ p, random }: { p: Palette; random: () => number }) {
  return (
    <>
      <path d={`M-20 ${230 - random() * 60} L420 ${80 - random() * 40} V180 L-20 ${330 - random() * 40}Z`} fill={p.soft} opacity={0.55} />
      {Array.from({ length: 14 }, (_, i) => {
        const r = 8 + random() * 22;
        return <circle key={i} cx={random() * 400} cy={random() * 300} r={r} fill={i % 3 === 0 ? p.strong : p.paper} stroke={p.ink} strokeOpacity={0.35} strokeWidth={2} />;
      })}
    </>
  );
}

function Peaks({ p, random }: { p: Palette; random: () => number }) {
  const ridge = (base: number, height: number) => {
    let d = `M0 300 L0 ${base}`;
    for (let x = 0; x <= 400; x += 50) d += ` L${x + 25} ${base - height * (0.4 + random() * 0.6)} L${x + 50} ${base}`;
    return `${d} L400 300Z`;
  };
  return (
    <>
      <circle cx={80 + random() * 240} cy={70} r={28} fill={p.strong} opacity={0.75} />
      <path d={ridge(220, 110)} fill={p.soft} opacity={0.8} />
      <path d={ridge(260, 80)} fill={p.ink} opacity={0.75} />
    </>
  );
}

const MOTIFS = [Sunrise, Tiles, Tokens, Peaks];

export function ProductCover({ product }: { product: CatalogProduct }) {
  const random = randomFor(product.id);
  const palette = PALETTES[Math.floor(random() * PALETTES.length)] ?? PALETTES[0];
  const Motif = MOTIFS[Math.floor(random() * MOTIFS.length)] ?? Sunrise;
  return (
    <div className={styles.cover} data-kind={product.type} aria-hidden="true" style={{ background: palette.paper, color: palette.ink }}>
      <svg className={styles.coverArt} viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" focusable="false">
        <Motif p={palette} random={random} />
      </svg>
      <span className={styles.coverLabel}>PANDORA COLLECTION</span>
      <strong className={styles.coverTitle}>{product.name}</strong>
      <span className={styles.coverLabel}>{product.publisher}</span>
      {product.type === "expansion" && (
        <span className={styles.coverRibbon} style={{ background: palette.strong }}>
          Expansion
        </span>
      )}
    </div>
  );
}
