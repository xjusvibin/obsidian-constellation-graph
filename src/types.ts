import type { ConstellationSettings } from "./settings";

export interface RawNode {
  id: string;
  name: string;
  group: string;
  deg: number;
  /** When the note was created (ms since epoch); orders the "Animate" timelapse. */
  ctime?: number;
}

export interface RawLink {
  source: string;
  target: string;
}

export interface GroupInfo {
  key: string;
  label: string;
  color: string;
  count: number;
}

export interface GraphData {
  nodes: RawNode[];
  links: RawLink[];
  groups: GroupInfo[];
}

export interface SimNode extends RawNode {
  index: number;
  gi: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  phase: number;
  speed: number;
  /** While set, the layout holds the note here (used while it is being dragged). */
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
}

/** What the view needs from its host (Obsidian, or the dev harness). */
export interface Host {
  openNote(id: string, newTab: boolean): void;
}

export interface RendererCallbacks {
  onHover(idx: number): void;
  onSelect(idx: number): void;
  onOpen(idx: number, newTab: boolean): void;
  /** A timed show started, progressed or ended. `kind` is null when nothing is running. */
  onActivity?(kind: "animate" | "supernova" | null, text: string): void;
}

/** The 3D renderer and the list-only fallback expose the same surface, so the UI never has to care which it has. */
export interface GraphRenderer {
  readonly nodes: SimNode[];
  readonly selectedIndex: number;
  readonly isPaused: boolean;
  indexOf(id: string): number;
  neighbors(i: number): number[];
  setData(data: GraphData): void;
  applySettings(s: ConstellationSettings): void;
  setPaused(p: boolean): void;
  setHover(i: number): void;
  setSelected(i: number, fly?: boolean): void;
  setActive(i: number): void;
  setSearch(matches: Set<number> | null): void;
  setHidden(groupIndex: number, hide: boolean): void;
  isHidden(groupIndex: number): boolean;
  flyTo(i: number): void;
  resetView(): void;
  /** Timelapse: notes appear in creation order and their links form. Calling again stops it. */
  animate(): void;
  /** Collapse, explode, re-settle, then trace the shortest paths from the main hub. Calling again stops it. */
  supernova(): void;
  readonly activity: "animate" | "supernova" | null;
  readonly canShow: boolean;
  destroy(): void;
}
