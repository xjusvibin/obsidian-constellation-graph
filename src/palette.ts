import type { PaletteName } from "./settings";

/** Bright colours that glow well on a dark background. */
const VIBRANT = [
  "#ffd54a", "#5b9bff", "#2fd4e8", "#ff5c62", "#4ade80", "#b085f5",
  "#f0883e", "#ff7ac6", "#9be564", "#7dd3fc", "#fca5a5", "#c4b5fd",
];

/** Okabe-Ito: distinguishable under the common forms of colour blindness. */
const COLORBLIND = [
  "#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#FFFFFF",
];

export function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s, l];
}

export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return "#" + to(f(p, q, h + 1 / 3)) + to(f(p, q, h)) + to(f(p, q, h - 1 / 3));
}

/** Colour for the i-th group. Past the end of the base palette it cycles with shifted lightness. */
export function groupColor(i: number, palette: PaletteName, accent: string): string {
  if (palette === "theme") {
    const [h] = hexToHsl(accent);
    return hslToHex(h + i * 137.508, 0.72, 0.62);
  }
  const base = palette === "colorblind" ? COLORBLIND : VIBRANT;
  const c = base[i % base.length];
  const round = Math.floor(i / base.length);
  if (round === 0) return c;
  const [h, s, l] = hexToHsl(c);
  return hslToHex(h, s, Math.max(0.35, Math.min(0.8, l + (round % 2 ? -0.14 : 0.12))));
}

export function accentFallback(): string {
  try {
    const v = getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  } catch { /* not available outside Obsidian */ }
  return "#7c5cff";
}
