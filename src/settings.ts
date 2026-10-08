export type MotionLevel = "off" | "calm" | "lively";
export type PaletteName = "vibrant" | "colorblind" | "theme";
export type GroupBy = "folder" | "tag" | "none";

export interface ConstellationSettings {
  motion: MotionLevel;
  autoRotate: boolean;
  rotateSpeed: number;
  glow: number;
  bloom: boolean;
  labelCount: number;
  labelSize: number;
  palette: PaletteName;
  groupBy: GroupBy;
  folderDepth: number;
  showOrphans: boolean;
  highContrast: boolean;
  respectReducedMotion: boolean;
  highlightActive: boolean;
  excludeFolders: string;
}

export const DEFAULT_SETTINGS: ConstellationSettings = {
  motion: "calm",
  autoRotate: true,
  rotateSpeed: 0.5,
  glow: 1,
  bloom: true,
  labelCount: 14,
  labelSize: 13,
  palette: "vibrant",
  groupBy: "folder",
  folderDepth: 1,
  showOrphans: true,
  highContrast: false,
  respectReducedMotion: true,
  highlightActive: true,
  excludeFolders: "",
};

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/** Merge saved data over the defaults, dropping anything the wrong type or out of range (hand-edited or older data.json). */
export function sanitizeSettings(raw: unknown): ConstellationSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    motion: pick(r.motion, ["off", "calm", "lively"] as const, d.motion),
    autoRotate: bool(r.autoRotate, d.autoRotate),
    rotateSpeed: clamp(r.rotateSpeed, 0.1, 2, d.rotateSpeed),
    glow: clamp(r.glow, 0, 1.5, d.glow),
    bloom: bool(r.bloom, d.bloom),
    labelCount: Math.round(clamp(r.labelCount, 0, 40, d.labelCount)),
    labelSize: Math.round(clamp(r.labelSize, 10, 24, d.labelSize)),
    palette: pick(r.palette, ["vibrant", "colorblind", "theme"] as const, d.palette),
    groupBy: pick(r.groupBy, ["folder", "tag", "none"] as const, d.groupBy),
    folderDepth: Math.round(clamp(r.folderDepth, 1, 4, d.folderDepth)),
    showOrphans: bool(r.showOrphans, d.showOrphans),
    highContrast: bool(r.highContrast, d.highContrast),
    respectReducedMotion: bool(r.respectReducedMotion, d.respectReducedMotion),
    highlightActive: bool(r.highlightActive, d.highlightActive),
    excludeFolders: typeof r.excludeFolders === "string" ? r.excludeFolders : d.excludeFolders,
  };
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function prefersMoreContrast(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-contrast: more)").matches;
}

/** Motion level after the operating system's reduced-motion preference is applied. */
export function effectiveMotion(s: ConstellationSettings): MotionLevel {
  return s.respectReducedMotion && prefersReducedMotion() ? "off" : s.motion;
}

export function effectiveAutoRotate(s: ConstellationSettings): boolean {
  return s.autoRotate && !(s.respectReducedMotion && prefersReducedMotion());
}

/** High contrast is on when chosen here or when the operating system asks for more contrast. */
export function effectiveHighContrast(s: ConstellationSettings): boolean {
  return s.highContrast || prefersMoreContrast();
}
