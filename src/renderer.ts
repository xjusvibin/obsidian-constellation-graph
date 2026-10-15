import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { Simulation, mapCoordinate } from "./sim";
import { PilotController } from "./pilot";
import type { GraphData, GraphRenderer, RendererCallbacks, SimNode } from "./types";
import { ConstellationSettings, effectiveAutoRotate, effectiveHighContrast, effectiveMotion, prefersReducedMotion } from "./settings";
import type { AnonymousTopology, ImpactSnapshot, NavigationTarget, Pose, ShotSnapshot } from "./multiplayer";
import { buildShip, type Ship } from "./ship";

THREE.ColorManagement.enabled = false; // we feed sRGB values straight to the screen

const VERT = /* glsl */ `
attribute vec3 aColor; attribute float aSize; attribute float aAlpha; attribute float aEmph;
uniform float uScale; uniform float uPulse;
varying vec3 vColor; varying float vAlpha; varying float vEmph;
void main() {
  vColor = aColor; vAlpha = aAlpha; vEmph = aEmph;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uPulse * uScale / max(0.001, -mv.z), 7.0, 190.0);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
varying vec3 vColor; varying float vAlpha; varying float vEmph;
uniform float uGlow; uniform float uContrast; uniform float uNova;
void main() {
  if (vAlpha < 0.004) discard;
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = 1.0 - smoothstep(0.30, 0.37, d);
  float halo = pow(1.0 - d, 2.5) * uGlow;
  float ring = smoothstep(0.76, 0.80, d) * (1.0 - smoothstep(0.88, 0.92, d)) * vEmph;
  vec3 col = vColor * (core * (1.05 + uContrast * 0.25) + halo * 0.85) + vec3(core * 0.10 + core * vEmph * 0.45) + vec3(ring);
  col += vec3(core * uNova * 0.55 + halo * uNova * 0.45); // white-hot during the supernova
  float a = clamp((core + halo + ring) * vAlpha, 0.0, 1.0);
  gl_FragColor = vec4(col, a);
}`;

const FOV = 55;
const CORE = 0.34; // fraction of a point sprite that is the solid disc

// A press on a note is a click unless it clearly becomes a drag. Quick taps with a shaky hand stay clicks.
const DRAG_FAR_PX = 10;       // moving this far is always a drag
const DRAG_HOLD_MS = 200;     // held at least this long ...
const DRAG_HELD_PX = 3;       // ... a movement this small already starts the drag
const DOUBLE_CLICK_MS = 450;  // two clicks this close together open the note
const PRESS_SLACK_PX = 7;     // extra reach when pressing, because notes keep drifting on screen

function baseRadius(deg: number): number {
  return Math.min(5.5, 0.9 + Math.sqrt(deg) * 0.5);
}

function pilotOptions(s: ConstellationSettings, multiplayer = false) {
  return { sensitivity: s.pilotSensitivity, invertY: s.pilotInvertY, view: s.pilotView, sound: s.pilotSound, volume: s.pilotVolume, muteEngine: s.pilotMuteEngine, muteAfterburner: s.pilotMuteAfterburner, wireframe: s.pilotWireframe, agility: multiplayer ? 1 : s.pilotAgility, speed: multiplayer ? 1 : s.pilotSpeed, mouse: s.pilotMouse, multiplayer };
}

export function webglAvailable(): boolean {
  try {
    const c = createEl("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return false; }
}

interface Tween { t0: number; dur: number; p0: THREE.Vector3; p1: THREE.Vector3; t0v: THREE.Vector3; t1v: THREE.Vector3 }
interface RemoteMap { playerId: string; points: THREE.Points; links: THREE.LineSegments; ids: Map<string, number>; nodeIds: string[]; revision: number; target: Float32Array; current: Float32Array; initialized: boolean }
interface RemoteShip { ship: Ship; target: Pose | null; name: string; indicator: HTMLDivElement; label: HTMLSpanElement; arrow: HTMLSpanElement }
interface RemoteBolt { line: THREE.Line; ownerId: string; target: THREE.Vector3; current: THREE.Vector3; direction: THREE.Vector3 }
interface NetworkImpact { mesh: THREE.Mesh; expires: number }
interface Rect { x: number; y: number; w: number; h: number }

export class ConstellationRenderer implements GraphRenderer {
  readonly sim = new Simulation();
  groups: GraphData["groups"] = [];

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private mapGroup = new THREE.Group();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 1, 7000);
  private controls: OrbitControls;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloom: UnrealBloomPass;
  private canvas: HTMLCanvasElement;
  private labelLayer: HTMLDivElement;
  private indicatorLayer: HTMLDivElement;
  private labels: HTMLDivElement[] = [];
  private stars: THREE.Points;
  private nodePoints: THREE.Points | null = null;
  private lines: THREE.LineSegments | null = null;
  private uniforms = { uScale: { value: 500 }, uGlow: { value: 1 }, uContrast: { value: 0 }, uPulse: { value: 1 }, uNova: { value: 0 } };

  private pos = new Float32Array(0);
  private col = new Float32Array(0);
  private size = new Float32Array(0);
  private alpha = new Float32Array(0);
  private emph = new Float32Array(0);
  private tAlpha = new Float32Array(0);
  private tSize = new Float32Array(0);
  private tEmph = new Float32Array(0);
  private baseSize = new Float32Array(0);
  private linePos = new Float32Array(0);
  private lineCol = new Float32Array(0);
  private nodeRgb: THREE.Color[] = [];
  private adj: number[][] = [];
  private idIndex = new Map<string, number>();
  private labelPriority: number[] = [];

  private hover = -1;
  private selected = -1;
  private active = -1;
  private search: Set<number> | null = null;
  private hidden = new Set<number>();
  private follow = -1;
  private dirty = true;
  private stale = true; // buffers need re-uploading / a frame needs drawing

  private settings: ConstellationSettings;
  private still = false;
  private paused = false;
  private visible = true;
  private contextLost = false;
  private degraded = false;
  private raf = 0;
  private last = 0;
  private fitDone = false;
  private autoFrame = true; // also keep the zoom fitted, until the reader zooms or orbits themselves
  private rotateBlockedUntil = 0; // after you let go of the camera it stays still for a moment before drifting again
  private userActive = false; // true only while the reader is dragging; centring pauses then and resumes at once
  private frameB: { cx: number; cy: number; cz: number; radius: number } | null = null;
  private age = 0;
  private frameNo = 0;
  private resumeTimer = 0;
  private slow = 0;
  private pointer = { x: -1, y: -1, inside: false, moved: false };
  private press: { i: number; x: number; y: number; t: number; id: number } | null = null; // the button is down; i is the note under it (-1 for none)
  private lastClick: { i: number; t: number } | null = null;
  private drag: { i: number; plane: THREE.Plane; offset: THREE.Vector3; moved: boolean; pointerId: number } | null = null;
  private ray = new THREE.Raycaster();
  private hit = new THREE.Vector3();
  private tween: Tween | null = null;
  private ro: ResizeObserver;
  private io: IntersectionObserver;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private lit = new Set<number>();
  private placed: Rect[] = [];
  private reveal: { t0: number; dur: number; order: number[]; rank: Int32Array; count: number; total: number } | null = null;
  private birth = new Float32Array(0); // when each note appeared during an animation (renderer age, seconds)
  private nova: { stage: "collapse" | "settle" | "trace"; t0: number; blastAt: number; traceT0: number; depth: Int16Array; maxDepth: number } | null = null;
  private novaBloom = 0;
  private linkAt = new Map<number, number>(); // pair of note indices -> link index
  private treeLink = new Uint8Array(0); // links on the shortest-path tree during the trace
  private flashEl: HTMLDivElement;
  private pilot: PilotController;
  private aim = -1; // the note under the Pilot crosshair
  private fwd = new THREE.Vector3();
  private netQ = new THREE.Quaternion();
  private remoteMaps = new Map<string, RemoteMap>();
  private multiplayer = false;
  private regionOrigin: [number, number, number] = [0, 0, 0];
  private worldNodes: SimNode[] = [];
  private localPlayerId = "";
  private localTopology: AnonymousTopology | null = null;
  private navigationTarget: NavigationTarget | null = null;
  private localPose: Pose | null = null;
  private navigationMarker: THREE.Mesh;
  private remoteShips = new Map<string, RemoteShip>();
  private remoteShots = new Map<string, RemoteBolt>();
  private networkImpacts = new Map<string, NetworkImpact>();

  constructor(private container: HTMLElement, private cb: RendererCallbacks, settings: ConstellationSettings) {
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x05070c, 1);
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.className = "cg-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    container.appendChild(this.canvas);

    this.flashEl = container.createDiv({ cls: "cg-flash", attr: { "aria-hidden": "true" } });

    this.labelLayer = container.createDiv({ cls: "cg-labels", attr: { "aria-hidden": "true" } });
    this.indicatorLayer = container.createDiv({ cls: "cg-player-indicators", attr: { "aria-hidden": "true" } });
    this.scene.add(this.mapGroup);
    this.navigationMarker = new THREE.Mesh(new THREE.RingGeometry(4, 5.5, 24), new THREE.MeshBasicMaterial({ color: 0xff5d68, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false }));
    this.navigationMarker.visible = false; this.navigationMarker.renderOrder = 9; this.scene.add(this.navigationMarker);

    this.camera.position.set(260, 150, 560);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.dampingFactor = 0.07;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.9;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 3000;
    this.controls.addEventListener("start", this.onControlStart);
    this.controls.addEventListener("end", this.onControlEnd);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.6, 0.35);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);

    this.stars = this.makeStars();
    this.scene.add(this.stars);

    this.pilot = new PilotController(this.canvas, container, this.camera, this.scene, {
      nodes: () => this.nodes,
      pickAt: (x, y, slack) => this.pickAt(x, y, slack),
      pickDestinationAt: (x, y, slack) => this.pickDestinationAt(x, y, slack),
      navigationTarget: () => this.navigationTarget,
      setNavigationTarget: target => this.setNavigationTarget(target),
      requestFastTravel: target => this.cb.onFastTravel?.(target),
      groupLabel: gi => this.groups[gi]?.label ?? "",
      nodeRadius: i => baseRadius(this.worldNodes[i]?.deg ?? 0),
      solid: i => { const n = this.sim.nodes[i]; return !!n && !this.hidden.has(n.gi) && this.alpha[i] > 0.3; },
      clusters: () => this.clusterShells(),
      bounds: () => this.worldBounds(),
      fitDistance: r => this.fitDistance(r),
      selectedIndex: () => this.selected,
      setAim: i => this.setAim(i),
      select: i => { this.setSelected(i, false); this.cb.onSelect(i); },
      open: (i, newTab) => { if (!this.multiplayer) this.cb.onOpen(i, newTab); },
      onState: (active, text) => this.onPilotState(active, text),
      leave: () => this.setPilot(false),
      onAudioMute: (which, muted) => this.cb.onAudioMute?.(which, muted),
      onNetworkFrame: input => this.cb.onNetworkFrame?.(input),
      onFire: (sequence, gun, aimPoint) => this.cb.onFire?.(sequence, gun, aimPoint),
    }, pilotOptions(settings));

    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("pointerdown", this.onPointerDown, true); // capture: claim a drag before the orbit controls do
    this.canvas.addEventListener("pointercancel", this.onPointerCancel);
    this.canvas.addEventListener("lostpointercapture", this.onPointerCancel);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.io = new IntersectionObserver(es => { this.visible = es[es.length - 1].isIntersecting; this.pilot.setViewVisible(this.visible); this.stale = true; });
    this.io.observe(container);
    this.resize();
    this.applySettings(settings);
    this.raf = window.requestAnimationFrame(this.frame);
  }

  // ----------------------------------------------------------------- public API

  get nodes(): SimNode[] { return this.worldNodes; }
  indexOf(id: string): number { return this.idIndex.get(id) ?? -1; }
  neighbors(i: number): number[] { return this.adj[i] ?? []; }
  get selectedIndex(): number { return this.selected; }
  get isPaused(): boolean { return this.paused; }

  setData(data: GraphData): void {
    // remember how each existing note currently looks so a live refresh does not blink
    const prev = new Map<string, [number, number, number]>();
    this.sim.nodes.forEach((p, i) => prev.set(p.id, [this.alpha[i], this.size[i], this.emph[i]]));

    this.reveal = null;
    if (this.nova) { this.sim.novaCancel(); this.nova = null; this.novaBloom = 0; this.uniforms.uPulse.value = 1; this.uniforms.uNova.value = 0; }
    this.groups = data.groups;
    this.sim.setData(data);
    this.refreshWorldNodes(true);
    const n = this.sim.nodes.length;
    this.sim.setScale(n);
    if (this.still) this.sim.settle(n > 4000 ? 120 : 300);
    this.refreshWorldNodes();
    this.idIndex = new Map(this.sim.nodes.map((p, i) => [p.id, i]));
    this.adj = this.sim.nodes.map(() => []);
    data.links.forEach(l => {
      const a = this.idIndex.get(l.source), b = this.idIndex.get(l.target);
      if (a !== undefined && b !== undefined) { this.adj[a].push(b); this.adj[b].push(a); }
    });
    if (this.hover >= 0) { this.hover = -1; this.cb.onHover(-1); }
    this.selected = -1; this.follow = -1; this.active = -1; this.hidden.clear(); this.search = null;
    this.allocate(n, data.links.length);
    this.sim.nodes.forEach((p, i) => {
      const old = prev.get(p.id);
      if (old) { this.alpha[i] = old[0]; this.size[i] = old[1]; this.emph[i] = old[2]; }
    });
    this.birth = new Float32Array(n).fill(-1e9);
    this.linkAt = new Map(this.sim.srcs.map((s, l) => [this.pairKey(s.index, this.sim.dsts[l].index), l]));
    this.recolor();
    this.labelPriority = this.sim.nodes.map((_, i) => i).sort((a, b) => this.sim.nodes[b].deg - this.sim.nodes[a].deg);
    this.dirty = true; this.stale = true;
    if (!this.fitDone) this.age = 0;
  }

  applySettings(s: ConstellationSettings): void {
    this.settings = s;
    const level = effectiveMotion(s);
    this.still = level === "off";
    this.sim.setMotion(level);
    const hc = effectiveHighContrast(s);
    this.uniforms.uGlow.value = hc ? 0.35 : s.glow;
    this.uniforms.uContrast.value = hc ? 1 : 0;
    this.bloom.strength = (hc ? 0 : 0.35 * s.glow) + this.novaBloom;
    this.controls.enableDamping = !this.still;
    this.updateRotate();
    this.controls.autoRotateSpeed = s.rotateSpeed * 2;
    this.stars.visible = !hc;
    this.container.classList.toggle("cg-contrast", hc);
    this.container.style.setProperty("--cg-label-size", s.labelSize + "px");
    this.pilot.setOptions(pilotOptions(s, this.multiplayer));
    if (!s.pilotEnabled && this.pilot.active) this.setPilot(false);
    this.dirty = true; this.stale = true;
  }

  /** The camera drifts only when nothing needs a steady target: not while you hover, select, drag or have just let go. */
  private updateRotate(): void {
    this.controls.autoRotate = effectiveAutoRotate(this.settings) && !this.paused && this.selected < 0 && this.hover < 0
      && !this.userActive && !this.drag && !this.pilot.active && performance.now() >= this.rotateBlockedUntil;
  }

  setPaused(p: boolean): void { this.paused = p; this.updateRotate(); }

  setHover(i: number): void {
    if (this.multiplayer) i = -1;
    if (i !== this.hover) { this.hover = i; this.dirty = true; this.updateRotate(); this.cb.onHover(i); }
  }
  setSelected(i: number, fly = true): void {
    if (this.multiplayer) i = -1;
    this.selected = i; this.follow = i; this.dirty = true; this.stale = true;
    this.updateRotate();
    if (i >= 0 && fly) this.flyTo(i);
  }
  setActive(i: number): void { if (i !== this.active) { this.active = i; this.dirty = true; } }

  // ----------------------------------------------------------------- Pilot mode

  get canPilot(): boolean { return true; }
  get pilotActive(): boolean { return this.pilot.active; }

  setWorldOrigin(slot: number): void {
    const points: [number, number, number][] = [[0, 0, 0], [2300, 0, 0], [-1150, 0, 1992], [-1150, 0, -1992]];
    const p = points[Math.max(0, Math.min(3, Math.floor(slot)))];
    this.regionOrigin = p;
    this.sim.setOrigin(...p); this.applyMapTransform(); this.refreshWorldNodes(); this.stale = true; this.dirty = true;
  }

  setMultiplayer(active: boolean): void {
    if (!active && this.pilot.active) this.pilot.exit();
    this.multiplayer = active;
    if (active) {
      if (this.drag) this.dragEnd();
      this.press = null; this.lastClick = null;
      this.setHover(-1); this.setSelected(-1, false);
    }
    if (!active) this.setNavigationTarget(null);
    this.applyMapTransform(); this.refreshWorldNodes();
    this.pilot.setOptions(pilotOptions(this.settings, active));
    this.container.classList.toggle("cg-room-active", active);
    this.remoteShips.forEach(remote => remote.ship.group.scale.setScalar(active ? 0.68 : 0.34));
    if (!active) { this.localPlayerId = ""; this.localTopology = null; this.indicatorLayer.replaceChildren(); }
    this.stale = true; this.dirty = true;
  }

  setLocalTopology(playerId: string, topology: AnonymousTopology | null): void {
    if (this.navigationTarget?.ownerId === this.localPlayerId && this.navigationTarget.revision !== topology?.revision) this.setNavigationTarget(null);
    this.localPlayerId = playerId; this.localTopology = topology;
  }

  setPlayerNames(names: Map<string, string>): void {
    for (const [id, remote] of this.remoteShips) {
      remote.name = names.get(id) ?? "Pilot";
      remote.label.textContent = remote.name;
    }
  }

  get inMultiplayer(): boolean { return this.multiplayer; }

  setNavigationTarget(target: NavigationTarget | null): void {
    if (!this.multiplayer && target) return;
    this.navigationTarget = target;
    this.pilot.clearTarget();
    this.navigationMarker.visible = false;
    this.cb.onNavigationTarget?.(target);
    this.stale = true;
  }

  requestFastTravel(): void {
    if (this.multiplayer && this.navigationTarget) this.cb.onFastTravel?.(this.navigationTarget);
  }

  private applyMapTransform(): void {
    const scale = this.multiplayer ? 2 : 1;
    this.mapGroup.scale.setScalar(scale);
    this.mapGroup.position.set(mapCoordinate(0, this.regionOrigin[0], scale), mapCoordinate(0, this.regionOrigin[1], scale), mapCoordinate(0, this.regionOrigin[2], scale));
    this.mapGroup.updateMatrixWorld(true);
  }

  private refreshWorldNodes(rebuild = false): void {
    const source = this.sim.nodes;
    if (rebuild || this.worldNodes.length !== source.length) this.worldNodes = source.map(node => ({ ...node }));
    const scale = this.multiplayer ? 2 : 1, [ox, oy, oz] = this.regionOrigin;
    for (let i = 0; i < source.length; i++) {
      const n = source[i], w = this.worldNodes[i];
      w.x = mapCoordinate(n.x, ox, scale); w.y = mapCoordinate(n.y, oy, scale); w.z = mapCoordinate(n.z, oz, scale);
      w.vx = n.vx * scale; w.vy = n.vy * scale; w.vz = n.vz * scale;
    }
  }

  private worldBounds(): { cx: number; cy: number; cz: number; radius: number } {
    const b = this.sim.bounds(), scale = this.multiplayer ? 2 : 1, [ox, oy, oz] = this.regionOrigin;
    return { cx: mapCoordinate(b.cx, ox, scale), cy: mapCoordinate(b.cy, oy, scale), cz: mapCoordinate(b.cz, oz, scale), radius: b.radius * scale };
  }

  private pickDestinationAt(px: number, py: number, slack = 0): NavigationTarget | null {
    if (!this.multiplayer) return null;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, dpr = this.renderer.getPixelRatio();
    if (!w || !h) return null;
    const cameraDir = this.fwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let best: NavigationTarget | null = null, bestScore = Infinity;
    const consider = (ownerId: string, starId: string, revision: number, x: number, y: number, z: number) => {
      if (!starId || (x - this.camera.position.x) * cameraDir.x + (y - this.camera.position.y) * cameraDir.y + (z - this.camera.position.z) * cameraDir.z < 1) return;
      this.tmp.set(x, y, z).project(this.camera); if (this.tmp.z > 1) return;
      const sx = (this.tmp.x * 0.5 + 0.5) * w, sy = (-this.tmp.y * 0.5 + 0.5) * h;
      const distance = Math.hypot(sx - px, sy - py), depth = this.camera.position.distanceTo(this.tmp2.set(x, y, z)) || 1;
      const radius = Math.max(14, Math.min(36, this.uniforms.uScale.value * 3 / depth / dpr)) + slack;
      if (distance <= radius) { const score = distance + depth * 0.005; if (score < bestScore) { bestScore = score; best = { ownerId, starId, revision }; } }
    };
    if (this.localPlayerId && this.localTopology) for (let i = 0; i < this.worldNodes.length; i++) {
      const n = this.worldNodes[i], anonymous = this.localTopology.nodes[i];
      if (anonymous) consider(this.localPlayerId, anonymous.id, this.localTopology.revision, n.x, n.y, n.z);
    }
    for (const remote of this.remoteMaps.values()) {
      if (!remote.initialized) continue;
      for (let i = 0; i < remote.nodeIds.length; i++) {
        const o = i * 3;
        consider(remote.playerId, remote.nodeIds[i], remote.revision, remote.current[o], remote.current[o + 1], remote.current[o + 2]);
      }
    }
    return best;
  }

  setRemoteTopology(playerId: string, topology: AnonymousTopology): void {
    if (this.navigationTarget?.ownerId === playerId && this.navigationTarget.revision !== topology.revision) this.setNavigationTarget(null);
    this.removeRemoteMap(playerId);
    const pos = new Float32Array(topology.nodes.length * 3);
    const colors = new Float32Array(topology.nodes.length * 3);
    const ids = new Map<string, number>();
    topology.nodes.forEach((node, i) => {
      ids.set(node.id, i);
      const color = new THREE.Color(topology.groups[node.group]?.color ?? "#8b93a7");
      colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b;
    });
    const nodeSizes = Float32Array.from(topology.nodes.map(node => (baseRadius(node.degree) * 2) / CORE));
    const nodeAlpha = new Float32Array(topology.nodes.length).fill(0.78);
    const nodeEmphasis = new Float32Array(topology.nodes.length);
    const nodeGeometry = new THREE.BufferGeometry();
    nodeGeometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    nodeGeometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    nodeGeometry.setAttribute("aSize", new THREE.BufferAttribute(nodeSizes, 1));
    nodeGeometry.setAttribute("aAlpha", new THREE.BufferAttribute(nodeAlpha, 1));
    nodeGeometry.setAttribute("aEmph", new THREE.BufferAttribute(nodeEmphasis, 1));
    const points = new THREE.Points(nodeGeometry, new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
    points.frustumCulled = false; points.renderOrder = 1; points.visible = false; this.scene.add(points);
    const linePos = new Float32Array(topology.links.length * 6);
    const lineGeometry = new THREE.BufferGeometry(); lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
    const lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: 0x8ca8d4, transparent: true, opacity: 0.2, depthWrite: false }));
    lines.frustumCulled = false; lines.renderOrder = 0; lines.visible = false; this.scene.add(lines);
    (lines as THREE.LineSegments & { __edgeIndices?: number[] }).__edgeIndices = topology.links.flatMap(link => [ids.get(link[0]) ?? -1, ids.get(link[1]) ?? -1]);
    this.remoteMaps.set(playerId, { playerId, points, links: lines, ids, nodeIds: topology.nodes.map(node => node.id), revision: topology.revision, target: pos.slice(), current: pos, initialized: false });
    this.stale = true;
  }

  setRemotePositions(playerId: string, positions: Float32Array): void {
    const remote = this.remoteMaps.get(playerId); if (!remote || positions.length !== remote.target.length) return;
    remote.target.set(positions); remote.initialized = true; this.stale = true;
  }

  setRemoteShip(playerId: string, pose: Pose, name = "Pilot"): void {
    let remote = this.remoteShips.get(playerId);
    if (!remote) {
      const ship = buildShip(); ship.group.scale.setScalar(this.multiplayer ? 0.68 : 0.34); ship.group.visible = false;
      this.scene.add(ship.group); ship.lights.forEach(light => this.scene.add(light));
      const indicator = document.createElement("div"); indicator.className = "cg-player-indicator"; indicator.hidden = true;
      const arrow = document.createElement("span"); arrow.className = "cg-player-indicator-arrow";
      const label = document.createElement("span"); label.className = "cg-player-indicator-label";
      indicator.append(arrow, label); this.indicatorLayer.appendChild(indicator);
      remote = { ship, target: null, name, indicator, label, arrow }; this.remoteShips.set(playerId, remote);
    }
    remote.name = name; remote.label.textContent = name;
    remote.target = pose;
    if (!pose.active || pose.health <= 0) { remote.ship.group.visible = false; remote.indicator.hidden = true; }
    this.stale = true;
  }

  setRemoteShots(shots: ShotSnapshot[], impacts: ImpactSnapshot[], localPlayerId = ""): void {
    const seen = new Set<string>(), now = performance.now();
    for (const shot of shots) {
      if (shot.ownerId === localPlayerId && this.pilot.cockpitView) continue;
      seen.add(shot.id);
      if (shot.ownerId === localPlayerId) {
        const sequence = Number(shot.id.slice(shot.id.lastIndexOf(":") + 1));
        if (Number.isSafeInteger(sequence)) this.pilot.acknowledgeShot(sequence);
      }
      let bolt = this.remoteShots.get(shot.id);
      if (!bolt) {
        const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
        const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x8cecff, transparent: true, opacity: 0.95 }));
        line.frustumCulled = false; line.renderOrder = 4; this.scene.add(line);
        bolt = { line, ownerId: shot.ownerId, target: new THREE.Vector3(), current: new THREE.Vector3(), direction: new THREE.Vector3() };
        bolt.current.set(...shot.origin);
        const initial = geometry.getAttribute("position") as THREE.BufferAttribute;
        initial.setXYZ(0, ...shot.origin); initial.setXYZ(1, ...shot.position); initial.needsUpdate = true;
        this.remoteShots.set(shot.id, bolt);
      }
      bolt.target.set(...shot.position); bolt.direction.set(...shot.direction).normalize();
    }
    for (const [id, bolt] of this.remoteShots) if (!seen.has(id)) {
      this.scene.remove(bolt.line); bolt.line.geometry.dispose(); (bolt.line.material as THREE.Material).dispose(); this.remoteShots.delete(id);
    }
    for (const impact of impacts) if (!this.networkImpacts.has(impact.id)) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(impact.kind === "ship" ? 5 : 3.5, 8, 6), new THREE.MeshBasicMaterial({ color: impact.kind === "ship" ? 0xff625f : 0xffc46b, transparent: true, opacity: 0.9, depthWrite: false }));
      mesh.position.set(...impact.position); mesh.renderOrder = 5; this.scene.add(mesh);
      this.networkImpacts.set(impact.id, { mesh, expires: now + 350 });
    }
    this.stale = true;
  }

  setAuthoritativePose(pose: Pose): void { this.localPose = pose; this.pilot.applyAuthorityPose(pose); }

  removeRemote(playerId: string): void {
    this.stale = true;
    for (const [id, bolt] of this.remoteShots) if (bolt.ownerId === playerId) {
      this.scene.remove(bolt.line); bolt.line.geometry.dispose(); (bolt.line.material as THREE.Material).dispose(); this.remoteShots.delete(id);
    }
    const remoteShip = this.remoteShips.get(playerId);
    if (remoteShip) {
      remoteShip.indicator.remove();
      this.scene.remove(remoteShip.ship.group); remoteShip.ship.lights.forEach(light => this.scene.remove(light)); remoteShip.ship.dispose(); this.remoteShips.delete(playerId);
    }
    this.removeRemoteMap(playerId);
  }

  private removeRemoteMap(playerId: string): void {
    const remote = this.remoteMaps.get(playerId); if (!remote) return;
    this.scene.remove(remote.points, remote.links); remote.points.geometry.dispose(); remote.links.geometry.dispose();
    (remote.points.material as THREE.Material).dispose(); (remote.links.material as THREE.Material).dispose();
    this.remoteMaps.delete(playerId); this.stale = true;
  }

  private updateRemoteMaps(): boolean {
    let moving = false;
    for (const remote of this.remoteMaps.values()) {
      if (!remote.initialized) continue;
      const p = remote.points.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < remote.current.length; i++) {
        const delta = remote.target[i] - remote.current[i];
        if (Math.abs(delta) > 0.05) moving = true;
        remote.current[i] += delta * 0.35;
      }
      p.needsUpdate = true; remote.points.visible = true;
      const lp = remote.links.geometry.getAttribute("position") as THREE.BufferAttribute;
      const edges = (remote.links as THREE.LineSegments & { __edgeIndices?: number[] }).__edgeIndices ?? [];
      for (let i = 0; i < edges.length; i += 2) {
        const a = edges[i] * 3, b = edges[i + 1] * 3, o = i * 3;
        for (let k = 0; k < 3; k++) { lp.array[o + k] = remote.current[a + k] ?? 0; lp.array[o + 3 + k] = remote.current[b + k] ?? 0; }
      }
      lp.needsUpdate = true; remote.links.visible = true;
    }
    for (const remote of this.remoteShips.values()) {
      const pose = remote.target; if (!pose || !pose.active) continue;
      const group = remote.ship.group;
      const target = this.tmp.set(...pose.position);
      if (!group.visible) { group.position.copy(target); group.quaternion.set(...pose.rotation).normalize(); group.visible = true; }
      else { group.position.lerp(target, 0.45); this.netQ.set(...pose.rotation).normalize(); group.quaternion.slerp(this.netQ, 0.45); }
      moving = moving || group.position.distanceTo(target) > 0.05;
    }
    for (const bolt of this.remoteShots.values()) {
      bolt.current.lerp(bolt.target, 0.55);
      const a = bolt.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      a.setXYZ(0, bolt.current.x, bolt.current.y, bolt.current.z);
      a.setXYZ(1, bolt.current.x - bolt.direction.x * 22, bolt.current.y - bolt.direction.y * 22, bolt.current.z - bolt.direction.z * 22);
      a.needsUpdate = true; moving = true;
    }
    const now = performance.now();
    for (const [id, impact] of this.networkImpacts) {
      const left = impact.expires - now;
      if (left <= 0) { this.scene.remove(impact.mesh); impact.mesh.geometry.dispose(); (impact.mesh.material as THREE.Material).dispose(); this.networkImpacts.delete(id); continue; }
      const scale = 1 + (1 - left / 350) * 1.8; impact.mesh.scale.setScalar(scale);
      (impact.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, left / 120); moving = true;
    }
    return moving;
  }

  private updateNavigationMarker(): void {
    const target = this.navigationTarget;
    if (!target || !this.multiplayer) { this.navigationMarker.visible = false; return; }
    let at: THREE.Vector3 | null = null;
    if (target.ownerId === this.localPlayerId && this.localTopology?.revision === target.revision) {
      const index = this.localTopology.nodes.findIndex(node => node.id === target.starId);
      if (index >= 0 && this.worldNodes[index]) { const n = this.worldNodes[index]; at = this.tmp.set(n.x, n.y, n.z); }
    } else {
      const map = this.remoteMaps.get(target.ownerId);
      const index = map?.revision === target.revision ? map.ids.get(target.starId) : undefined;
      if (map?.initialized && index !== undefined) { const o = index * 3; at = this.tmp.set(map.current[o], map.current[o + 1], map.current[o + 2]); }
    }
    if (!at) { this.navigationMarker.visible = false; return; }
    this.navigationMarker.position.copy(at); this.navigationMarker.quaternion.copy(this.camera.quaternion); this.navigationMarker.visible = true;
  }

  private updatePlayerIndicators(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!this.multiplayer || !w || !h) { for (const p of this.remoteShips.values()) p.indicator.hidden = true; return; }
    this.camera.updateMatrixWorld();
    const reference = this.localPose ? this.tmp2.set(...this.localPose.position) : this.camera.position;
    for (const remote of this.remoteShips.values()) {
      const pose = remote.target, group = remote.ship.group, indicator = remote.indicator;
      if (!pose?.active || pose.health <= 0 || !group.visible) { indicator.hidden = true; continue; }
      const point = group.position, view = point.clone().applyMatrix4(this.camera.matrixWorldInverse);
      const projected = point.clone().project(this.camera), behind = view.z >= 0;
      const x = (projected.x * 0.5 + 0.5) * w, y = (-projected.y * 0.5 + 0.5) * h;
      const onScreen = !behind && x >= 24 && x <= w - 24 && y >= 26 && y <= h - 22;
      indicator.hidden = false;
      remote.label.textContent = `${remote.name} · ${Math.round(reference.distanceTo(point))} m`;
      if (onScreen) {
        indicator.classList.add("cg-player-indicator-near");
        remote.arrow.textContent = "⌄"; remote.arrow.style.transform = "";
        indicator.style.transform = `translate(${Math.round(x)}px, ${Math.round(y - 22)}px) translate(-50%, -50%)`;
      } else {
        indicator.classList.remove("cg-player-indicator-near");
        remote.arrow.textContent = "▲";
        let dx = x - w / 2, dy = y - h / 2;
        if (behind) { dx = -dx; dy = -dy; }
        if (Math.hypot(dx, dy) < 1) dy = -1;
        const length = Math.hypot(dx, dy); dx /= length; dy /= length;
        const edge = Math.min((w / 2 - 30) / Math.max(0.001, Math.abs(dx)), (h / 2 - 30) / Math.max(0.001, Math.abs(dy)));
        const px = w / 2 + dx * Math.max(0, edge), py = h / 2 + dy * Math.max(0, edge);
        remote.arrow.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI + 90}deg)`;
        indicator.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px) translate(-50%, -50%)`;
      }
    }
  }

  clearSelection(): void {
    this.lastClick = null;
    this.pilot.clearTarget();
    this.setSelected(-1, false);
    this.cb.onSelect(-1);
  }

  /** Enter or leave free flight. The orbit controls are parked while it runs, and the view eases back out when it ends. */
  setPilot(on: boolean): void {
    if (on === this.pilot.active) return;
    if (!on) { this.pilot.exit(); return; }
    if (!this.settings.pilotEnabled) { this.cb.onPilot?.(false, "Pilot mode is turned off in the settings"); return; }
    if (this.settings.respectReducedMotion && prefersReducedMotion()) {
      this.cb.onPilot?.(false, "Pilot mode needs motion, and reduced motion is on, so it stays off. Search and the note list still work."); return;
    }
    if (this.drag || this.contextLost || !this.sim.nodes.length) return;
    if (this.reveal) this.endAnimation(false);
    if (this.nova) this.novaStop(false);
    this.tween = null; this.follow = -1; this.autoFrame = false;
    window.clearTimeout(this.resumeTimer);
    this.controls.enabled = false; this.controls.autoRotate = false;
    this.frameB = this.worldBounds();
    this.pilot.enter();
  }

  private onPilotState(active: boolean, text: string): void {
    if (!active) { // flight is over: hand the camera back to the orbit controls without a jump, then ease out to the full view
      const dir = this.tmp.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const b = this.worldBounds();
      this.controls.target.copy(this.camera.position).addScaledVector(dir, Math.max(60, this.camera.position.distanceTo(this.tmp2.set(b.cx, b.cy, b.cz))));
      this.controls.enabled = true;
      this.aim = -1; this.dirty = true; this.stale = true;
      this.autoFrame = true;
      this.updateRotate();
      this.resetView();
    }
    this.cb.onPilot?.(active, text);
  }

  /** The centre, rough radius and colour of every group that is showing: what Pilot mode draws as wireframe shells. */
  private clusterShells(): { x: number; y: number; z: number; r: number; color: string }[] {
    const G = this.groups.length, nodes = this.worldNodes;
    const sx = new Float64Array(G), sy = new Float64Array(G), sz = new Float64Array(G), cnt = new Float64Array(G), sq = new Float64Array(G);
    for (const n of nodes) { if (this.hidden.has(n.gi)) continue; sx[n.gi] += n.x; sy[n.gi] += n.y; sz[n.gi] += n.z; cnt[n.gi]++; }
    for (let g = 0; g < G; g++) if (cnt[g]) { sx[g] /= cnt[g]; sy[g] /= cnt[g]; sz[g] /= cnt[g]; }
    for (const n of nodes) { if (this.hidden.has(n.gi)) continue; sq[n.gi] += (n.x - sx[n.gi]) ** 2 + (n.y - sy[n.gi]) ** 2 + (n.z - sz[n.gi]) ** 2; }
    const out: { x: number; y: number; z: number; r: number; color: string }[] = [];
    for (let g = 0; g < G; g++) {
      if (cnt[g] < 3) continue; // a shell around one or two notes says nothing
      out.push({ x: sx[g], y: sy[g], z: sz[g], r: Math.max(12, Math.sqrt(sq[g] / cnt[g]) * 2.1), color: this.groups[g].color });
    }
    return out;
  }

  private setAim(i: number): void { if (i !== this.aim) { this.aim = i; this.dirty = true; } }
  setSearch(matches: Set<number> | null): void { this.search = matches; this.dirty = true; }
  setHidden(groupIndex: number, hide: boolean): void { hide ? this.hidden.add(groupIndex) : this.hidden.delete(groupIndex); this.dirty = true; }
  isHidden(groupIndex: number): boolean { return this.hidden.has(groupIndex); }

  flyTo(i: number): void {
    if (this.pilot.active) { this.pilot.warpToNode(i); return; }
    if (this.multiplayer) { const topology = this.localTopology, n = topology?.nodes[i]; if (n && topology && this.localPlayerId) this.setNavigationTarget({ ownerId: this.localPlayerId, starId: n.id, revision: topology.revision }); return; }
    const n = this.worldNodes[i]; if (!n) return;
    const dir = this.tmp.copy(this.camera.position).sub(this.controls.target);
    if (dir.lengthSq() < 1) dir.set(0.3, 0.2, 1);
    dir.normalize();
    const to = new THREE.Vector3(n.x, n.y, n.z);
    this.startTween(to.clone().addScaledVector(dir, 85 + baseRadius(n.deg) * 6), to, 1300);
  }

  resetView(): void {
    if (this.pilot.active) { this.pilot.returnToHub(); return; }
    this.follow = -1; this.autoFrame = true;
    const b = this.worldBounds();
    const dir = this.tmp.copy(this.camera.position).sub(this.controls.target);
    if (dir.lengthSq() < 1) dir.set(0.4, 0.25, 1);
    dir.normalize();
    const dist = this.fitDistance(b.radius); // fits the narrower field of view, so tall, thin panes still frame everything
    const c = new THREE.Vector3(b.cx, b.cy, b.cz);
    this.startTween(c.clone().addScaledVector(dir, dist), c, 1500);
  }

  get activity(): "animate" | "supernova" | null { return this.reveal ? "animate" : this.nova ? "supernova" : null; }
  get canShow(): boolean { return true; }

  /** Timelapse: every note disappears, then returns in the order it was created, with each new link flashing as it forms. */
  animate(): void {
    if (this.reveal) { this.endAnimation(false); return; }
    if (this.nova) this.novaStop(false);
    const nodes = this.sim.nodes, N = nodes.length;
    if (N < 2 || this.drag) return;
    const order = nodes.map((_, i) => i).sort((a, b) => (nodes[a].ctime ?? 0) - (nodes[b].ctime ?? 0) || nodes[a].id.localeCompare(nodes[b].id));
    const rank = new Int32Array(N); order.forEach((i, k) => { rank[i] = k; });
    const dur = Math.min(30000, Math.max(6000, N * 90));
    this.reveal = { t0: performance.now(), dur, order, rank, count: 0, total: N };
    this.birth.fill(-1e9);
    this.autoFrame = true; this.dirty = true; this.stale = true;
    this.cb.onActivity?.("animate", `Animating: 0 of ${N} notes`);
  }

  private endAnimation(finished: boolean): void {
    if (!this.reveal) return;
    this.reveal = null; this.dirty = true; this.stale = true;
    this.cb.onActivity?.(null, finished ? "Animation finished" : "Animation stopped");
  }

  /**
   * Crush the whole graph into a point, detonate it, let it re-form from scratch, then light up the shortest paths from
   * the main hub outward. With motion off there is no show: the layout is simply recomputed at once.
   */
  supernova(): void {
    if (this.nova) { this.novaStop(false); return; }
    if (this.reveal) this.endAnimation(false);
    if (this.drag || !this.sim.nodes.length) return;
    this.autoFrame = true; this.follow = -1;
    if (this.selected >= 0) { this.setSelected(-1, false); this.cb.onSelect(-1); }
    if (this.still) {
      this.sim.relayout(); this.dirty = true; this.stale = true; this.resetView();
      this.cb.onActivity?.(null, "Layout re-optimized"); return;
    }
    if (this.paused) { this.cb.onActivity?.(null, "Resume motion first, then start the supernova"); return; }
    this.sim.novaStart();
    this.nova = { stage: "collapse", t0: this.age, blastAt: 0, traceT0: 0, depth: new Int16Array(0), maxDepth: 0 };
    this.cb.onActivity?.("supernova", "Supernova: collapsing");
  }

  private novaStop(finished: boolean): void {
    this.sim.novaCancel();
    this.nova = null; this.novaBloom = 0; this.dirty = true; this.stale = true;
    this.uniforms.uPulse.value = 1; this.uniforms.uNova.value = 0; this.flashEl.setCssProps({ opacity: "0" });
    this.bloom.strength = effectiveHighContrast(this.settings) ? 0 : 0.35 * this.settings.glow;
    this.cb.onActivity?.(null, finished ? "Layout optimized" : "Supernova stopped");
  }

  private pairKey(a: number, b: number): number { return a < b ? a * 1_000_003 + b : b * 1_000_003 + a; }

  /** Breadth-first from the hub: depth of every note, and which links lie on the shortest-path tree. */
  private beginTrace(now: number): void {
    const nv = this.nova!, nodes = this.sim.nodes, N = nodes.length;
    let hub = this.selected >= 0 ? this.selected : 0;
    if (this.selected < 0) for (let i = 1; i < N; i++) if (nodes[i].deg > nodes[hub].deg) hub = i;
    const depth = new Int16Array(N).fill(-1), parent = new Int32Array(N).fill(-1), queue: number[] = [hub];
    depth[hub] = 0; let maxDepth = 0;
    for (let q = 0; q < queue.length; q++) {
      const a = queue[q];
      for (const b of this.adj[a]) if (depth[b] < 0) { depth[b] = depth[a] + 1; parent[b] = a; maxDepth = Math.max(maxDepth, depth[b]); queue.push(b); }
    }
    this.treeLink = new Uint8Array(this.sim.srcs.length);
    for (let i = 0; i < N; i++) if (parent[i] >= 0) { const l = this.linkAt.get(this.pairKey(i, parent[i])); if (l !== undefined) this.treeLink[l] = 1; }
    nv.stage = "trace"; nv.traceT0 = now; nv.depth = depth; nv.maxDepth = maxDepth;
    this.cb.onActivity?.("supernova", "Supernova: tracing the shortest paths");
  }

  private fitDistance(radius: number): number {
    const v = (FOV * Math.PI) / 360, h = Math.atan(Math.tan(v) * this.camera.aspect);
    return (radius / Math.sin(Math.min(v, h))) * 1.08;
  }

  destroy(): void {
    window.cancelAnimationFrame(this.raf);
    window.clearTimeout(this.resumeTimer);
    this.ro.disconnect(); this.io.disconnect();
    this.controls.removeEventListener("start", this.onControlStart);
    this.controls.removeEventListener("end", this.onControlEnd);
    this.controls.dispose();
    for (const [ev, fn] of [
      ["pointermove", this.onPointerMove], ["pointerleave", this.onPointerLeave], ["pointercancel", this.onPointerCancel], ["lostpointercapture", this.onPointerCancel],
      ["pointerup", this.onPointerUp],
      ["contextmenu", this.onContextMenu],
      ["webglcontextlost", this.onContextLost], ["webglcontextrestored", this.onContextRestored],
    ] as [string, EventListener][]) this.canvas.removeEventListener(ev, fn);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown, true);
    this.pilot.destroy();
    for (const bolt of this.remoteShots.values()) { this.scene.remove(bolt.line); bolt.line.geometry.dispose(); (bolt.line.material as THREE.Material).dispose(); }
    for (const impact of this.networkImpacts.values()) { this.scene.remove(impact.mesh); impact.mesh.geometry.dispose(); (impact.mesh.material as THREE.Material).dispose(); }
    this.remoteShots.clear(); this.networkImpacts.clear();
    this.disposeNodes();
    this.stars.geometry.dispose(); (this.stars.material as THREE.Material).dispose();
    // EffectComposer.dispose() does not free its passes, and browsers cap live WebGL contexts
    this.bloom.dispose(); this.renderPass.dispose(); this.composer.dispose();
    this.navigationMarker.geometry.dispose(); (this.navigationMarker.material as THREE.Material).dispose();
    this.renderer.dispose(); this.renderer.forceContextLoss();
    this.canvas.remove(); this.labelLayer.remove(); this.indicatorLayer.remove(); this.flashEl.remove();
  }

  // ----------------------------------------------------------------- setup

  private makeStars(): THREE.Points {
    const n = 600, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, t = Math.random() * 6.2832, r = 2200 + Math.random() * 1500, s = Math.sqrt(1 - u * u);
      a[i * 3] = Math.cos(t) * s * r; a[i * 3 + 1] = u * r; a[i * 3 + 2] = Math.sin(t) * s * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(a, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8aa0ff, size: 1.5, sizeAttenuation: false, transparent: true, opacity: 0.45, depthWrite: false }));
  }

  private disposeNodes(): void {
    for (const o of [this.nodePoints, this.lines]) {
      if (!o) continue;
    this.mapGroup.remove(o); o.geometry.dispose(); (o.material as THREE.Material).dispose();
    }
    this.nodePoints = null; this.lines = null;
  }

  private allocate(n: number, l: number): void {
    this.disposeNodes();
    this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n); this.alpha = new Float32Array(n); this.emph = new Float32Array(n);
    this.tAlpha = new Float32Array(n).fill(1); this.tSize = new Float32Array(n); this.tEmph = new Float32Array(n);
    this.baseSize = new Float32Array(n);
    this.sim.nodes.forEach((p, i) => { this.baseSize[i] = (baseRadius(p.deg) * 2) / CORE; this.size[i] = this.tSize[i] = this.baseSize[i]; });

    const g = new THREE.BufferGeometry();
    const mk = (name: string, arr: Float32Array, item: number) => { const at = new THREE.BufferAttribute(arr, item); at.setUsage(THREE.DynamicDrawUsage); g.setAttribute(name, at); };
    mk("position", this.pos, 3); mk("aColor", this.col, 3); mk("aSize", this.size, 1); mk("aAlpha", this.alpha, 1); mk("aEmph", this.emph, 1);
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });
    this.nodePoints = new THREE.Points(g, m);
    this.nodePoints.frustumCulled = false;
    this.nodePoints.renderOrder = 2;
    this.mapGroup.add(this.nodePoints);

    this.linePos = new Float32Array(l * 6); this.lineCol = new Float32Array(l * 6);
    const lg = new THREE.BufferGeometry();
    const lp = new THREE.BufferAttribute(this.linePos, 3); lp.setUsage(THREE.DynamicDrawUsage); lg.setAttribute("position", lp);
    const lc = new THREE.BufferAttribute(this.lineCol, 3); lc.setUsage(THREE.DynamicDrawUsage); lg.setAttribute("color", lc);
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 1;
    this.mapGroup.add(this.lines);
  }

  private recolor(): void {
    const nodes = this.sim.nodes;
    this.nodeRgb = nodes.map(p => new THREE.Color(this.groups[p.gi]?.color ?? "#8b93a7"));
    nodes.forEach((_, i) => { const c = this.nodeRgb[i]; this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b; });
    if (this.nodePoints) (this.nodePoints.geometry.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h); // also resizes every pass
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.uniforms.uScale.value = (h * this.renderer.getPixelRatio()) / (2 * Math.tan((FOV * Math.PI) / 360));
    this.stale = true;
  }

  // ----------------------------------------------------------------- interaction

  private onContextLost = (e: Event) => { e.preventDefault(); this.contextLost = true; };
  private onContextRestored = () => { this.contextLost = false; this.stale = true; this.resize(); };

  private onControlStart = () => { window.clearTimeout(this.resumeTimer); this.controls.autoRotate = false; this.tween = null; this.autoFrame = false; this.userActive = true; this.updateRotate(); };
  private onControlEnd = () => {
    this.userActive = false;
    window.clearTimeout(this.resumeTimer);
    this.rotateBlockedUntil = performance.now() + 3500;
    this.resumeTimer = window.setTimeout(() => this.updateRotate(), 3550);
    this.updateRotate();
  };

  private setPointer(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.x = e.clientX - r.left; this.pointer.y = e.clientY - r.top; this.pointer.inside = true;
  }
  private onPointerMove = (e: PointerEvent) => {
    if (this.pilot.active) return;
    this.setPointer(e); this.pointer.moved = true;
    // the button went up without us seeing it (focus moved away, released outside the window): do not stay stuck in a drag
    if ((this.press || this.drag) && e.buttons === 0) { this.onPointerCancel(); return; }
    if (this.drag) { this.dragMove(e); return; }
    // a press on a note only turns into a drag once the pointer has clearly left: far, or held a moment and then moved
    const p = this.press;
    if (p && p.i >= 0) {
      const dist = Math.hypot(e.clientX - p.x, e.clientY - p.y), held = performance.now() - p.t;
      if (dist >= DRAG_FAR_PX || (held >= DRAG_HOLD_MS && dist >= DRAG_HELD_PX)) this.dragStart(e, p.i);
    }
  };
  private onPointerLeave = () => { this.pointer.inside = false; this.pointer.moved = true; };
  private onPointerDown = (e: PointerEvent) => {
    if (e.button === 2) { this.clearSelection(); return; }
    if (e.button !== 0 || this.pilot.active) return; // in Pilot mode a press is a shot, handled by the pilot
    this.setPointer(e);
    if (this.multiplayer) {
      this.setHover(-1);
      this.press = { i: -1, x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
      return;
    }
    let hit = this.pick();
    if (hit < 0) hit = this.pick(PRESS_SLACK_PX); // notes drift while the hand travels, so a press may land just beside one
    this.setHover(hit); // touch taps never fire a move first
    this.press = { i: this.hover, x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    if (this.hover >= 0 && !this.nova) {
      this.controls.enabled = false; // otherwise the orbit controls start turning the camera under a click
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    }
  };
  private onContextMenu = (e: MouseEvent) => { e.preventDefault(); this.clearSelection(); };
  private onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0 || this.pilot.active) return;
    const p = this.press; this.press = null;
    if (this.drag) { this.dragEnd(); return; }
    this.endPress(p);
    if (!p) return;
    if (this.multiplayer) {
      const r = this.canvas.getBoundingClientRect();
      this.setNavigationTarget(this.pickDestinationAt(e.clientX - r.left, e.clientY - r.top, PRESS_SLACK_PX));
      return;
    }
    // Not a drag, so it is a click. It belongs to the note that was pressed, even if that note drifted a little
    // or the hand shook: nothing is re-aimed at release.
    const now = performance.now(), last = this.lastClick;
    if (last && last.i >= 0 && now - last.t < DOUBLE_CLICK_MS && (p.i === last.i || p.i < 0)) { // second click of a double-click
      this.lastClick = null; this.cb.onOpen(last.i, false); return;
    }
    if (p.i >= 0) {
      if (e.ctrlKey || e.metaKey) this.cb.onOpen(p.i, true);
      else { this.lastClick = { i: p.i, t: now }; this.setSelected(p.i); this.cb.onSelect(p.i); }
    } else if (Math.hypot(e.clientX - p.x, e.clientY - p.y) <= 6 && this.selected >= 0) { // a click on empty space, not an orbit
      this.lastClick = null; this.setSelected(-1); this.cb.onSelect(-1);
    }
  };
  private onPointerCancel = () => {
    const p = this.press; this.press = null;
    if (this.drag) this.dragEnd(); else this.endPress(p);
  };

  private endPress(p: { id: number } | null): void {
    this.controls.enabled = true;
    if (p) { try { this.canvas.releasePointerCapture(p.id); } catch { /* already released */ } }
  }

  /** The press has become a drag: now the layout is switched into drag mode and the note follows the pointer on a plane facing the camera. */
  private dragStart(e: PointerEvent, i: number): void {
    const n = this.sim.nodes[i]; if (!n || this.nova) return;
    const normal = this.camera.getWorldDirection(this.tmp2.set(0, 0, 0)).clone();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(n.x, n.y, n.z));
    this.drag = { i, plane, offset: new THREE.Vector3(), moved: true, pointerId: e.pointerId };
    // anchor to where the button went down, not to where the pointer is now, so the note stays under the cursor
    const at = this.pointerOnPlane(this.press?.x ?? e.clientX, this.press?.y ?? e.clientY, plane);
    if (at) this.drag.offset.set(n.x - at.x, n.y - at.y, n.z - at.z);
    this.userActive = true; this.autoFrame = false;
    window.clearTimeout(this.resumeTimer); this.controls.autoRotate = false; this.tween = null;
    this.sim.beginDrag(i);
    this.canvas.setCssProps({ cursor: "grabbing" });
    this.dragMove(e);
  }

  private dragMove(e: PointerEvent): void {
    const d = this.drag; if (!d) return;
    const at = this.pointerOnPlane(e.clientX, e.clientY, d.plane); if (!at) return;
    this.sim.dragTo(at.x + d.offset.x, at.y + d.offset.y, at.z + d.offset.z);
    this.stale = true;
  }

  private dragEnd(): void {
    const d = this.drag; if (!d) return;
    this.drag = null;
    this.endPress({ id: d.pointerId });
    this.sim.endDrag(this.still); // with reduced motion the notes return at once instead of bouncing
    this.userActive = false; this.stale = true;
    this.canvas.style.cursor = this.hover >= 0 ? "pointer" : "grab";
    this.onControlEnd();
  }

  private pointerOnPlane(clientX: number, clientY: number, plane: THREE.Plane): THREE.Vector3 | null {
    const r = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    return this.ray.ray.intersectPlane(plane, this.hit) ? this.hit : null;
  }
  /** The note under the pointer. `slack` widens every target by a few pixels (used for a press, since notes drift while the hand travels). */
  private pick(slack = 0): number { return this.pickAt(this.pointer.x, this.pointer.y, slack); }

  /** The note under a point of the canvas (CSS pixels), ignoring notes behind the camera. */
  private pickAt(px: number, py: number, slack = 0): number {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, dpr = this.renderer.getPixelRatio();
    const v = this.tmp, nodes = this.worldNodes, cam = this.camera.position;
    const fx = this.fwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let best = -1, bestScore = 1e9;
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i];
      if (this.hidden.has(p.gi) || this.alpha[i] < 0.3) continue;
      if ((p.x - cam.x) * fx.x + (p.y - cam.y) * fx.y + (p.z - cam.z) * fx.z < 1) continue; // behind the camera
      v.set(p.x, p.y, p.z).project(this.camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - px, sy - py);
      if (d > 70) continue;
      const dist = this.camera.position.distanceTo(this.tmp2.set(p.x, p.y, p.z)) || 1;
      const sprite = Math.min(190, Math.max(7, (this.size[i] * this.uniforms.uScale.value) / dist)) / dpr; // CSS pixels
      const reach = Math.max(18, sprite * CORE * 0.5 * 1.3 + 10) + slack; // a little larger than the drawn note, so it is easy to hit
      if (d < reach) { const score = d + dist * 0.01; if (score < bestScore) { bestScore = score; best = i; } }
    }
    return best;
  }

  private startTween(p1: THREE.Vector3, t1: THREE.Vector3, dur: number): void {
    if (this.still) { // reduced motion: no flying, just arrive
      this.controls.target.copy(t1); this.camera.position.copy(p1); this.tween = null; this.stale = true; return;
    }
    this.tween = { t0: performance.now(), dur, p0: this.camera.position.clone(), p1, t0v: this.controls.target.clone(), t1v: t1 };
  }

  // ----------------------------------------------------------------- frame

  private frame = (now: number) => {
    this.raf = window.requestAnimationFrame(this.frame);
    if (!this.visible || document.hidden || this.contextLost) { this.last = now; return; }
    const dt = Math.min(0.1, (now - this.last) / 1000 || 0.016);
    this.last = now; this.age += dt; this.frameNo++;
    if (!this.nodePoints) return;

    let moving = this.updateRemoteMaps();
    if (!this.paused) { this.sim.step(dt); moving = this.sim.isActive() || moving; }
    this.refreshWorldNodes();
    if (!this.drag && !this.pilot.active && (this.pointer.moved || (this.pointer.inside && moving && this.frameNo % 8 === 0))) {
      this.pointer.moved = false;
      this.setHover(this.pointer.inside ? this.pick() : -1);
      this.canvas.style.cursor = this.hover >= 0 ? "pointer" : "grab";
    }
    this.updateShows(dt);
    if (this.dirty) this.recomputeTargets();

    const animating = this.updateBuffers(dt, moving || this.stale);
    let camMoved = false;
    if (this.pilot.active) {
      this.pilot.update(dt);
      // keep the orbit target ahead of the ship, so labels still fade with distance
      this.controls.target.copy(this.camera.position).addScaledVector(this.tmp.set(0, 0, -1).applyQuaternion(this.camera.quaternion), 300);
      this.stale = true;
    } else {
    this.updateCamera(now);
    this.updateNavigationMarker();
    this.updatePlayerIndicators();
      camMoved = this.controls.update(dt);
    }
    if (!(moving || animating || camMoved || this.stale || this.tween || this.follow >= 0)) return; // fully at rest: draw nothing
    this.stale = false;

    this.stars.rotation.y += this.paused || this.still ? 0 : dt * 0.004;
    this.updateLabels();
    if (this.settings.bloom && !this.degraded && !effectiveHighContrast(this.settings) && this.bloom.strength > 0) this.composer.render(); else this.renderer.render(this.scene, this.camera);

    // protect slow machines: drop the glow pass first, then lower resolution
    this.slow = dt > 0.04 ? this.slow + 1 : Math.max(0, this.slow - 1);
    if (this.slow > 90) {
      this.slow = 0;
      if (!this.degraded) this.degraded = true;
      else if (this.renderer.getPixelRatio() > 1) { this.renderer.setPixelRatio(1); this.resize(); }
    }
  };

  private updateShows(_dt: number): void {
    const now = this.age;
    if (this.reveal) {
      const r = this.reveal, p = Math.min(1, (performance.now() - r.t0) / r.dur);
      const e = this.still ? p : p * p * (3 - 2 * p);
      const count = Math.min(r.total, Math.floor(e * (r.total + 1)));
      if (count !== r.count) {
        for (let k = r.count; k < count; k++) {
          const i = r.order[k]; this.birth[i] = now;
          if (!this.still) { this.size[i] = this.baseSize[i] * 0.15; this.emph[i] = 1; this.alpha[i] = 0; } // pop in
        }
        r.count = count; this.dirty = true;
        this.cb.onActivity?.("animate", `Animating: ${count} of ${r.total} notes`);
      }
      this.stale = true;
      if (p >= 1) this.endAnimation(true);
    }
    const nv = this.nova; if (!nv) return;
    this.stale = true;
    const phase = this.sim.novaPhase, hc = effectiveHighContrast(this.settings), base = hc ? 0 : 0.35 * this.settings.glow;
    if (nv.stage === "collapse") {
      if (phase === "settle") { nv.stage = "settle"; nv.blastAt = now; this.cb.onActivity?.("supernova", "Supernova: detonation"); }
      else {
        const c = Math.min(1, (now - nv.t0) / 1.5);
        this.uniforms.uNova.value = c * 0.8; this.uniforms.uPulse.value = 1 + 0.35 * c; this.novaBloom = 0.8 * c * c;
        this.flashEl.setCssProps({ opacity: "0" });
      }
    }
    if (nv.stage === "settle") {
      if (phase === "idle") { this.beginTrace(now); }
      else {
        const s = now - nv.blastAt;
        this.uniforms.uNova.value = Math.max(0, 1 - s / 1.4);
        this.uniforms.uPulse.value = 1 + 0.55 * Math.exp(-s / 0.6);
        this.novaBloom = 1.5 * Math.exp(-s / 0.8);
        this.flashEl.style.opacity = hc ? "0" : String(0.32 * Math.exp(-s / 0.3)); // one soft flash, never a strobe
      }
    }
    if (nv.stage === "trace") {
      this.uniforms.uNova.value = 0; this.uniforms.uPulse.value = 1; this.novaBloom = 0; this.flashEl.setCssProps({ opacity: "0" });
      this.dirty = true; // node highlights follow the wave
      if (now - nv.traceT0 > (nv.maxDepth + 1) * 0.42 + 1.8) { this.novaStop(true); return; }
    }
    this.bloom.strength = base + this.novaBloom;
  }

  private recomputeTargets(): void {
    this.dirty = false;
    const nodes = this.sim.nodes, N = nodes.length;
    const primary = this.hover >= 0 ? this.hover : this.selected;
    const lit = this.lit; lit.clear();
    if (primary >= 0) { lit.add(primary); for (const j of this.adj[primary]) lit.add(j); }
    for (let i = 0; i < N; i++) {
      let a = 1;
      if (this.hidden.has(nodes[i].gi) || (this.reveal && this.reveal.rank[i] >= this.reveal.count)) a = 0;
      else {
        if (primary >= 0 && !lit.has(i) && !this.pilot.active) a *= 0.13; // in flight nothing dims, or the notes you have not selected could not be aimed at
        if (this.search && !this.search.has(i)) a *= 0.14;
      }
      this.tAlpha[i] = a;
      let s = this.baseSize[i], e = 0;
      if (i === primary) { s *= 1.5; e = 0.9; }
      else if (primary >= 0 && lit.has(i)) s *= 1.12;
      if (i === this.selected) e = 1;
      if (i === this.aim && this.pilot.active) { s *= 1.4; e = Math.max(e, 0.8); } // what the crosshair is on
      if (this.search && this.search.has(i)) { s *= 1.25; e = Math.max(e, 0.7); }
      if (this.settings.highlightActive && i === this.active) e = Math.max(e, 0.75);
      const nv = this.nova;
      if (nv && nv.stage === "trace" && nv.depth[i] >= 0) { // the wave of light travelling out from the hub
        const lit = this.age - nv.traceT0 - nv.depth[i] * 0.42, pulse = lit >= 0 ? Math.exp(-lit / 0.7) : 0;
        e = Math.max(e, pulse); s *= 1 + 0.45 * pulse;
      }
      this.tSize[i] = s; this.tEmph[i] = e;
    }
    this.stale = true;
  }

  /** Returns true while any fade or size change is still in progress. */
  private updateBuffers(dt: number, positionsChanged: boolean): boolean {
    const nodes = this.sim.nodes, k = this.still ? 1 : Math.min(1, dt * 9);
    let animating = false;
    for (let i = 0; i < nodes.length; i++) {
      const da = this.tAlpha[i] - this.alpha[i], ds = this.tSize[i] - this.size[i], de = this.tEmph[i] - this.emph[i];
      if (Math.abs(da) > 0.002 || Math.abs(ds) > 0.01 || Math.abs(de) > 0.002) {
        animating = true;
        this.alpha[i] += da * k; this.size[i] += ds * k; this.emph[i] += de * k;
      } else { this.alpha[i] = this.tAlpha[i]; this.size[i] = this.tSize[i]; this.emph[i] = this.tEmph[i]; }
    }
    if (!positionsChanged && !animating) return false;

    const geo = this.nodePoints!.geometry;
    for (let i = 0; i < nodes.length; i++) { const p = nodes[i]; this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z; }
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aAlpha") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aEmph") as THREE.BufferAttribute).needsUpdate = true;

    const src = this.sim.srcs, dst = this.sim.dsts, hc = effectiveHighContrast(this.settings);
    const base = hc ? 0.55 : 0.2, boost = hc ? 1.6 : 2.6;
    const primary = this.hover >= 0 ? this.hover : this.selected;
    for (let l = 0; l < src.length; l++) {
      const s = src[l], d = dst[l], a = s.index, b = d.index, o = l * 6;
      this.linePos[o] = s.x; this.linePos[o + 1] = s.y; this.linePos[o + 2] = s.z;
      this.linePos[o + 3] = d.x; this.linePos[o + 4] = d.y; this.linePos[o + 5] = d.z;
      let f = base * Math.min(this.alpha[a], this.alpha[b]);
      if (primary >= 0 && (a === primary || b === primary)) f = Math.min(1, base * boost) * Math.min(1, this.alpha[a] + this.alpha[b]);
      if (this.reveal || this.age - Math.max(this.birth[a], this.birth[b]) < 1) { // a link flashes the moment both ends exist
        const born = this.age - Math.max(this.birth[a], this.birth[b]);
        if (born >= 0 && born < 1) f += base * 3.5 * (1 - born) * Math.min(this.alpha[a], this.alpha[b]);
      }
      const nv = this.nova;
      if (nv && nv.stage === "trace") {
        if (this.treeLink[l]) { const lit = this.age - nv.traceT0 - Math.max(nv.depth[a], nv.depth[b]) * 0.42; f += lit >= 0 ? 0.9 * Math.exp(-lit / 0.8) : 0; }
        else f *= 0.55;
      }
      const ca = this.nodeRgb[a], cb = this.nodeRgb[b];
      this.lineCol[o] = ca.r * f; this.lineCol[o + 1] = ca.g * f; this.lineCol[o + 2] = ca.b * f;
      this.lineCol[o + 3] = cb.r * f; this.lineCol[o + 4] = cb.g * f; this.lineCol[o + 5] = cb.b * f;
    }
    const lg = this.lines!.geometry;
    (lg.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (lg.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    return animating;
  }

  private updateCamera(now: number): void {
    if (!this.fitDone && this.age > 1.8 && this.sim.nodes.length) { this.fitDone = true; this.resetView(); }
    if (this.tween) {
      const t = Math.min(1, (now - this.tween.t0) / this.tween.dur), e = 1 - Math.pow(1 - t, 3);
      if (this.follow >= 0 && this.worldNodes[this.follow]) { // keep aiming at the node while it drifts
        const n = this.worldNodes[this.follow], dirLen = this.tween.p1.distanceTo(this.tween.t1v);
        const dir = this.tmp.copy(this.tween.p1).sub(this.tween.t1v).normalize();
        this.tween.t1v.set(n.x, n.y, n.z); this.tween.p1.copy(this.tween.t1v).addScaledVector(dir, dirLen);
      }
      this.controls.target.lerpVectors(this.tween.t0v, this.tween.t1v, e);
      this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, e);
      if (t >= 1) this.tween = null;
    } else if (this.follow >= 0 && this.worldNodes[this.follow]) {
      const n = this.worldNodes[this.follow];
      const d = this.tmp.set(n.x, n.y, n.z).sub(this.controls.target).multiplyScalar(this.still ? 1 : 0.12);
      this.controls.target.add(d); this.camera.position.add(d);
    } else if (this.fitDone && !this.still && !this.paused && !this.userActive) {
      // the clusters keep orbiting, so keep the camera on them: ease toward their centre, and back in if the view has drifted far away
      if (this.frameNo % (this.nova ? 5 : 45) === 0 || !this.frameB) this.frameB = this.worldBounds();
      const b = this.frameB;
      const ease = this.nova ? 0.09 : 0.03;
      const d = this.tmp.set(b.cx, b.cy, b.cz).sub(this.controls.target).multiplyScalar(ease);
      this.controls.target.add(d); this.camera.position.add(d);
      const dir = this.tmp2.copy(this.camera.position).sub(this.controls.target);
      const cur = dir.length() || 1, fit = this.fitDistance(b.radius);
      const nv = this.nova, hold = !!nv && (nv.stage === "collapse" || (nv.stage === "settle" && this.age - nv.blastAt < 1.4)); // keep the lens still so the crush and the blast read
      const want = hold ? cur : this.autoFrame ? fit : cur > fit * 1.5 ? fit * 1.5 : cur; // the reader may zoom in, but not wander off
      if (want !== cur) this.camera.position.copy(this.controls.target).addScaledVector(dir.normalize(), cur + (want - cur) * ease);
    }
  }

  private updateLabels(): void {
    const s = this.settings, nodes = this.worldNodes, hc = effectiveHighContrast(s);
    if (this.multiplayer) { for (const label of this.labels) label.toggleClass("cg-hidden", true); return; }
    if (this.nova && this.nova.stage !== "trace") { for (const l of this.labels) l.toggleClass("cg-hidden", true); return; }
    const want: number[] = [];
    const seen = new Set<number>();
    const add = (i: number) => { if (i >= 0 && !seen.has(i) && !this.hidden.has(nodes[i].gi)) { seen.add(i); want.push(i); } };
    if (this.reveal) for (let k = this.reveal.count - 1; k >= Math.max(0, this.reveal.count - 3); k--) add(this.reveal.order[k]); // the newest arrivals
    add(this.hover); add(this.selected); add(this.active); add(this.pilot.active ? this.aim : -1);
    const primary = this.hover >= 0 ? this.hover : this.selected;
    if (primary >= 0) {
      let top = this.adj[primary].slice();
      if (top.length > 8) top = top.sort((a, b) => nodes[b].deg - nodes[a].deg).slice(0, 8);
      top.forEach(add);
    }
    if (this.search) { let c = 0; for (const i of this.search) { add(i); if (++c > 14) break; } }
    else if (primary < 0) for (let k = 0; k < this.labelPriority.length && want.length < s.labelCount + 3; k++) add(this.labelPriority[k]);

    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, v = this.tmp, placed = this.placed;
    const cp = this.camera.position, cx0 = cp.x, cy0 = cp.y, cz0 = cp.z;
    const fd = this.fwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion), fx0 = fd.x, fy0 = fd.y, fz0 = fd.z;
    placed.length = 0;
    const fs = s.labelSize, focusDist = this.camera.position.distanceTo(this.controls.target) || 1;
    let used = 0;
    for (const i of want) {
      const n = nodes[i];
      v.set(n.x, n.y, n.z).project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) continue;
      if (this.pilot.active && (n.x - cx0) * fx0 + (n.y - cy0) * fy0 + (n.z - cz0) * fz0 < 1) continue; // behind the ship
      const sx = (v.x * 0.5 + 0.5) * w, rise = baseRadius(n.deg) * 2.2 + 6, sy = (-v.y * 0.5 + 0.5) * h - rise;
      const lw = Math.min(260, n.name.length * fs * 0.56 + 14), lh = fs + 8;
      const x = sx - lw / 2, y = sy - lh;
      const must = i === this.hover || i === this.selected;
      if (!must && placed.some(r => x < r.x + r.w && x + lw > r.x && y < r.y + r.h && y + lh > r.y)) continue;
      placed.push({ x, y, w: lw, h: lh });
      let el = this.labels[used];
      if (!el) { el = this.labelLayer.createDiv({ cls: "cg-label" }); this.labels[used] = el; }
      if (el.textContent !== n.name) el.textContent = n.name;
      // fade with real distance from the camera; labels never drop below 60% and are always opaque in high contrast
      const dist = this.camera.position.distanceTo(this.tmp2.set(n.x, n.y, n.z));
      const depth = hc ? 1 : Math.max(0.6, Math.min(1, 1.25 - 0.45 * (dist / (focusDist * 1.4))));
      el.style.opacity = String(must || hc ? 1 : Math.min(1, depth * Math.min(1, this.alpha[i] * 1.3)));
      el.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px) translate(-50%, -100%)`;
      el.classList.toggle("cg-label-strong", must);
      el.toggleClass("cg-hidden", false);
      used++;
    }
    for (let k = used; k < this.labels.length; k++) this.labels[k].toggleClass("cg-hidden", true);
  }
}
