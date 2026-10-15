import type { BurstMsg, MissileMsg } from "./powerups";
import type { ConstellationSettings } from "./settings";
import type { AnonymousTopology, HitMsg, Pose, ShotMsg } from "./multiplayer";

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
  /** Save a setting (the room panel remembers your name). Not available in the browser preview. */
  updateSettings?(patch: Partial<ConstellationSettings>): void;
  /** Send a web request (Obsidian's requestUrl); resolves with the status. Used only to set up multiplayer connections. */
  post?(url: string, body: string): Promise<number>;
  /** Versions for the diagnostics text. */
  versions?(): { plugin: string; obsidian: string; platform: string };
}

export interface RendererCallbacks {
  onHover(idx: number): void;
  onSelect(idx: number): void;
  onOpen(idx: number, newTab: boolean): void;
  /** A timed show started, progressed or ended. `kind` is null when nothing is running. */
  onActivity?(kind: "animate" | "supernova" | null, text: string): void;
  /** Pilot mode started or stopped; `text` is a message for the reader (read out by screen readers too). */
  onPilot?(active: boolean, text: string): void;
  /** Multiplayer: your ship's pose (about twenty times a second), a bolt you fired, and a bolt that hit you. */
  onNetworkPose?(pose: Pose): void;
  onNetworkShot?(shot: ShotMsg): void;
  /** The reader moved the camera and let go: where it points, to remember for next time. */
  onView?(view: { d: [number, number, number]; z: number }): void;
  onNetworkHit?(shooterId: string, shotId: string, at: [number, number, number]): void;
  /** You were destroyed by this pilot's bolt. */
  onNetworkKill?(killerId: string | null): void;
  /** Your missile, a group you broke (its meteors), and a pickup you took. */
  onNetworkMissile?(missile: MissileMsg): void;
  onNetworkBurst?(burst: BurstMsg): void;
  onNetworkGrab?(pickup: number): void;
  /** The scoreboard key went down (true) or up (false). */
  onScores?(on: boolean): void;
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
  /** Fly a path through a chain of linked notes, starting from the selected one. Calling again stops it. */
  tour(): void;
  readonly activity: "animate" | "supernova" | null;
  readonly canShow: boolean;
  /** Free flight through the constellation. Not available without WebGL. */
  readonly canPilot: boolean;
  readonly pilotActive: boolean;
  setPilot(on: boolean): void;
  /** Fold every group into one point, or open them all if any is folded. Not available without WebGL. */
  toggleAllGroups?(): void;
  /** Multiplayer (not available without WebGL). */
  setMultiplayer?(active: boolean, selfId?: string): void;
  /** The seed the room's pickups are laid out from (the room code), and what other pilots do with them. */
  setPowerSeed?(seed: string): void;
  addRemoteMissile?(id: string, missile: MissileMsg, from: string): void;
  addRemoteBurst?(burst: BurstMsg): void;
  remoteGrab?(pickup: number): void;
  /** You destroyed another pilot (heals you a little). */
  rewardKill?(): void;
  /** The current view as a PNG (the 3D scene only: no note names are drawn into it), or null if it cannot be made. */
  capture?(): Promise<Blob | null>;
  setWorldOrigin?(slot: number): void;
  setRemoteTopology?(id: string, topology: AnonymousTopology, name: string, slot: number): void;
  setRemotePositions?(id: string, positions: Float32Array): void;
  setRemotePose?(id: string, pose: Pose): void;
  addRemoteShot?(id: string, shot: ShotMsg): void;
  showRemoteHit?(hit: HitMsg): void;
  removeRemote?(id: string): void;
  readonly anyCollapsed?: boolean;
  destroy(): void;
}
