export type MotionLevel = "off" | "calm" | "lively";
export type PaletteName = "vibrant" | "colorblind" | "theme";
export type GroupBy = "folder" | "tag" | "none";

export interface ConstellationSettings {
  motion: MotionLevel;
  autoRotate: boolean;
  rotateSpeed: number;
  glow: number;
  nodeSize: number;
  linkBrightness: number;
  spacing: number;
  checkForUpdates: boolean;
  rememberView: boolean;
  savedView: { d: [number, number, number]; z: number } | null;
  updateCheckedAt: number;
  updateNotified: string;
  bloom: boolean;
  quality: "auto" | "low" | "balanced" | "high";
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
  openOnStartup: boolean;
  pilotEnabled: boolean;
  pilotSensitivity: number;
  pilotInvertY: boolean;
  pilotView: "chase" | "cockpit";
  pilotShip: "striker" | "dart" | "bulwark";
  pilotColor: string;
  pilotDrones: boolean;
  pilotTips: boolean;
  pilotSound: boolean;
  pilotVolume: number;
  pilotWireframe: boolean;
  pilotAgility: number;
  pilotSpeed: number;
  pilotMouse: "capture" | "cursor";
  pilotCollapse: "auto" | "never" | "always";
  multiplayerName: string;
  multiplayerRelayUrl: string;
  multiplayerTurnUrl: string;
  multiplayerTurnUser: string;
  multiplayerTurnCredential: string;
}

export const DEFAULT_SETTINGS: ConstellationSettings = {
  motion: "calm",
  autoRotate: true,
  rotateSpeed: 0.5,
  glow: 1,
  nodeSize: 1,
  linkBrightness: 1,
  spacing: 1,
  checkForUpdates: false,
  rememberView: true,
  savedView: null,
  updateCheckedAt: 0,
  updateNotified: "",
  bloom: true,
  quality: "auto",
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
  openOnStartup: false,
  pilotEnabled: true,
  pilotSensitivity: 1,
  pilotInvertY: false,
  pilotView: "chase",
  pilotShip: "striker",
  pilotColor: "auto",
  pilotDrones: true,
  pilotTips: true,
  pilotSound: true,
  pilotVolume: 0.5,
  pilotWireframe: true,
  pilotAgility: 1,
  pilotSpeed: 1,
  pilotMouse: "capture",
  pilotCollapse: "auto",
  multiplayerName: "Pilot",
  multiplayerRelayUrl: "https://ntfy.sh",
  multiplayerTurnUrl: "",
  multiplayerTurnUser: "",
  multiplayerTurnCredential: "",
};

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/** A remembered camera: a direction (unit vector, from where you look at to where the camera is) and how far out relative to the framing of the whole graph. */
function sanitizeView(v: unknown): { d: [number, number, number]; z: number } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { d?: unknown; z?: unknown };
  if (!Array.isArray(o.d) || o.d.length !== 3 || !o.d.every(x => typeof x === "number" && isFinite(x) && Math.abs(x) <= 1.01) || typeof o.z !== "number" || !isFinite(o.z)) return null;
  const len = Math.hypot(o.d[0] as number, o.d[1] as number, o.d[2] as number);
  if (len < 0.5 || len > 1.5) return null;
  return { d: [o.d[0] as number / len, o.d[1] as number / len, o.d[2] as number / len], z: Math.min(2, Math.max(0.25, o.z)) };
}

/** Merge saved data over the defaults, dropping anything the wrong type or out of range (hand-edited or older data.json). */
export function sanitizeSettings(raw: unknown): ConstellationSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    motion: pick(r.motion, ["off", "calm", "lively"] as const, d.motion),
    autoRotate: bool(r.autoRotate, d.autoRotate),
    rotateSpeed: clamp(r.rotateSpeed, 0.1, 2, d.rotateSpeed),
    glow: clamp(r.glow, 0, 1.5, d.glow),
    nodeSize: clamp(r.nodeSize, 0.5, 2, d.nodeSize),
    linkBrightness: clamp(r.linkBrightness, 0.3, 2.5, d.linkBrightness),
    spacing: clamp(r.spacing, 0.5, 2.5, d.spacing),
    checkForUpdates: bool(r.checkForUpdates, d.checkForUpdates),
    rememberView: bool(r.rememberView, d.rememberView),
    savedView: sanitizeView(r.savedView),
    updateCheckedAt: typeof r.updateCheckedAt === "number" && isFinite(r.updateCheckedAt) ? r.updateCheckedAt : 0,
    updateNotified: typeof r.updateNotified === "string" && /^\d+\.\d+\.\d+$/.test(r.updateNotified) ? r.updateNotified : "",
    bloom: bool(r.bloom, d.bloom),
    quality: pick(r.quality, ["auto", "low", "balanced", "high"] as const, d.quality),
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
    openOnStartup: bool(r.openOnStartup, d.openOnStartup),
    pilotEnabled: bool(r.pilotEnabled, d.pilotEnabled),
    pilotSensitivity: clamp(r.pilotSensitivity, 0.2, 3, d.pilotSensitivity),
    pilotInvertY: bool(r.pilotInvertY, d.pilotInvertY),
    pilotView: pick(r.pilotView, ["chase", "cockpit"] as const, d.pilotView),
    pilotColor: pick(r.pilotColor, ["auto", "orange", "violet", "green", "rose", "gold", "white", "red", "cyan"] as const, d.pilotColor),
    pilotShip: pick(r.pilotShip, ["striker", "dart", "bulwark"] as const, d.pilotShip),
    pilotSound: bool(r.pilotSound, d.pilotSound),
    pilotDrones: bool(r.pilotDrones, d.pilotDrones),
    pilotTips: bool(r.pilotTips, d.pilotTips),
    pilotVolume: clamp(r.pilotVolume, 0, 1, d.pilotVolume),
    pilotWireframe: bool(r.pilotWireframe, d.pilotWireframe),
    pilotAgility: clamp(r.pilotAgility, 0.5, 1.5, d.pilotAgility),
    pilotSpeed: clamp(r.pilotSpeed, 0.4, 3, d.pilotSpeed),
    pilotMouse: pick(r.pilotMouse, ["capture", "cursor"] as const, d.pilotMouse),
    pilotCollapse: pick(r.pilotCollapse, ["auto", "never", "always"] as const, d.pilotCollapse),
    multiplayerName: typeof r.multiplayerName === "string" ? r.multiplayerName.trim().slice(0, 24) || d.multiplayerName : d.multiplayerName,
    multiplayerRelayUrl: typeof r.multiplayerRelayUrl === "string" ? r.multiplayerRelayUrl.trim().slice(0, 300) || d.multiplayerRelayUrl : d.multiplayerRelayUrl,
    multiplayerTurnUrl: typeof r.multiplayerTurnUrl === "string" ? r.multiplayerTurnUrl.trim().slice(0, 300) : d.multiplayerTurnUrl,
    multiplayerTurnUser: typeof r.multiplayerTurnUser === "string" ? r.multiplayerTurnUser.slice(0, 300) : d.multiplayerTurnUser,
    multiplayerTurnCredential: typeof r.multiplayerTurnCredential === "string" ? r.multiplayerTurnCredential.slice(0, 300) : d.multiplayerTurnCredential,
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
