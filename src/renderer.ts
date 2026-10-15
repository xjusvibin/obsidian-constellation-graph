import { BlackHole } from "./blackhole";
import { PowerWorld } from "./powerworld";
import { pickupLayout, type BurstMsg, type MissileMsg } from "./powerups";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { Simulation } from "./sim";
import { PilotController } from "./pilot";
import { RemoteWorld, WORLD_ORIGINS } from "./remote";
import type { AnonymousTopology, HitMsg, Pose, ShotMsg } from "./multiplayer";
import { busiestNote, planTour } from "./tour";
import type { GraphData, GraphRenderer, RendererCallbacks, SimNode } from "./types";
import { ConstellationSettings, effectiveAutoRotate, effectiveHighContrast, effectiveMotion, prefersReducedMotion } from "./settings";

THREE.ColorManagement.enabled = false; // we feed sRGB values straight to the screen

const VERT = /* glsl */ `
attribute vec3 aColor; attribute float aSize; attribute float aAlpha; attribute float aEmph;
uniform float uScale; uniform float uPulse; uniform float uNodeScale;
varying vec3 vColor; varying float vAlpha; varying float vEmph; varying float vFade;
void main() {
  vColor = aColor; vAlpha = aAlpha; vEmph = aEmph;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float raw = aSize * uNodeScale * uPulse * uScale / max(0.001, -mv.z);
  gl_PointSize = clamp(raw, 5.0, 190.0);
  vFade = clamp(raw / 16.0, 0.22, 1.0); // far away a star is only a speck: dim it, so thousands of them do not add up to a white wash
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
varying vec3 vColor; varying float vAlpha; varying float vEmph; varying float vFade;
uniform float uGlow; uniform float uContrast; uniform float uNova;
void main() {
  if (vAlpha < 0.004) discard;
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = 1.0 - smoothstep(0.30, 0.37, d);
  float halo = pow(1.0 - d, 2.5) * uGlow * vFade;
  float ring = smoothstep(0.76, 0.80, d) * (1.0 - smoothstep(0.88, 0.92, d)) * vEmph;
  vec3 col = vColor * (core * (1.05 + uContrast * 0.25) + halo * 0.85) + vec3(core * 0.10 + core * vEmph * 0.45) + vec3(ring);
  col += vec3(core * uNova * 0.55 + halo * uNova * 0.45); // white-hot during the supernova
  col = vec3(1.0) - exp(-col * 1.15); // soft shoulder: bright stars level off instead of clipping to white
  float a = clamp((core * mix(0.7, 1.0, vFade) + halo + ring) * vAlpha, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a); // premultiplied, for the screen blend below
}`;

const FOV = 55;
const NEAR_LABELS = 6;   // flying: at most this many notes are named because they are close
const clamp01 = (v: number): number => Math.min(1, Math.max(0.0, v));
const PILOT_AUTO_COLLAPSE = 400; // a vault with more notes than this starts folded into its groups when you first fly
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
  return { multiplayer, sensitivity: s.pilotSensitivity, invertY: s.pilotInvertY, view: s.pilotView, ship: s.pilotShip, color: s.pilotColor, sound: s.pilotSound, volume: s.pilotVolume, wireframe: s.pilotWireframe, agility: s.pilotAgility, speed: s.pilotSpeed, mouse: s.pilotMouse };
}

export function webglAvailable(): boolean {
  try {
    const c = createEl("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return false; }
}

interface Tween { t0: number; dur: number; p0: THREE.Vector3; p1: THREE.Vector3; t0v: THREE.Vector3; t1v: THREE.Vector3 }
interface Rect { x: number; y: number; w: number; h: number }

export class ConstellationRenderer implements GraphRenderer {
  readonly sim = new Simulation();
  groups: GraphData["groups"] = [];

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 1, 7000);
  private controls: OrbitControls;
  private composer: EffectComposer;
  private hole!: BlackHole;
  private renderPass: RenderPass;
  private bloom: UnrealBloomPass;
  private canvas: HTMLCanvasElement;
  private labelLayer: HTMLDivElement;
  private labels: HTMLDivElement[] = [];
  private nearLabels: number[] = []; // flying: the notes close enough to be named
  private nearAt = false;
  private nearRadius = 100;
  private stars: THREE.Points;
  private nodePoints: THREE.Points | null = null;
  private lines: THREE.LineSegments | null = null;
  private uniforms = { uScale: { value: 500 }, uGlow: { value: 1 }, uContrast: { value: 0 }, uPulse: { value: 1 }, uNova: { value: 0 }, uNodeScale: { value: 1 } };

  private pos = new Float32Array(0);
  private jolt = new Float32Array(0); private joltV = new Float32Array(0); // how far a blast has pushed each note (drawing only, the layout is untouched), and how fast
  private joltLive = false;
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

  // groups collapsed into a single "star system" point. The notes stay in the layout; they fade and fly in to the middle of their
  // group, and a bright point stands in for them until the group is opened again.
  private collapsedKeys = new Set<string>();
  private gCollapsed: boolean[] = [];
  private exp = new Float32Array(1).fill(1);        // per group: 1 = open, 0 = collapsed (animated)
  private gc = { x: new Float64Array(1), y: new Float64Array(1), z: new Float64Array(1), n: new Float64Array(1) };
  private clusterPts: THREE.Points | null = null;
  private cpos = new Float32Array(0); private ccol = new Float32Array(0); private csize = new Float32Array(0);
  private calpha = new Float32Array(0); private cemph = new Float32Array(0);
  private clusterLabels: HTMLDivElement[] = [];
  private autoCollapsed = false;
  private follow = -1;
  private dirty = true;
  private stale = true; // buffers need re-uploading / a frame needs drawing

  private settings: ConstellationSettings;
  private still = false;
  private paused = false;
  private visible = true;
  private contextLost = false;
  private degraded = false;
  private ratioForced = false; // the slow-machine fallback has dropped the resolution
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
  private viewTimer = 0;
  private zoomGoal = 0; // the distance from the orbit target the wheel is heading for (0: not zooming)
  private slow = 0;
  private pointer = { x: -1, y: -1, inside: false, moved: false };
  private press: { i: number; x: number; y: number; t: number; id: number; c: number } | null = null; // the button is down; i is the note under it (-1 for none)
  private lastClick: { i: number; t: number } | null = null;
  private drag: { i: number; plane: THREE.Plane; offset: THREE.Vector3; moved: boolean; pointerId: number } | null = null;
  private ray = new THREE.Raycaster();
  private hit = new THREE.Vector3();
  private tween: Tween | null = null;
  private tourTimer = 0;
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
  private remote: RemoteWorld;
  private powers: PowerWorld;
  private powerSeed = "";
  private powersReady = false;
  private selfId = "me";
  private multiplayer = false;
  private aim = -1; // the note under the Pilot crosshair
  private pilotAimCluster = -1; // the collapsed group under it
  private fwd = new THREE.Vector3();

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

    this.camera.position.set(260, 150, 560);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.dampingFactor = 0.07;
    this.controls.rotateSpeed = 0.6;
    this.controls.enableZoom = false; // the wheel is handled below: it glides toward a goal distance instead of jumping a notch per click
    this.controls.minDistance = 30;
    this.controls.maxDistance = 3000;
    this.controls.addEventListener("start", this.onControlStart);
    this.controls.addEventListener("end", this.onControlEnd);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.5, 0.55);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.hole = new BlackHole(this.scene, this.camera);
    this.composer.addPass(this.hole.pass); // after the glow, so the lensing bends the glow too

    this.stars = this.makeStars();
    this.scene.add(this.stars);

    this.pilot = new PilotController(this.canvas, container, this.camera, this.scene, {
      nodes: () => this.sim.nodes,
      pickAt: (x, y, slack) => this.pickAt(x, y, slack),
      groupLabel: gi => this.groups[gi]?.label ?? "",
      nodeRadius: i => baseRadius(this.sim.nodes[i]?.deg ?? 0),
      solid: i => { const n = this.sim.nodes[i]; return !!n && !this.hidden.has(n.gi) && this.alpha[i] > 0.3; },
      clusters: () => this.clusterShells(),
      bounds: () => this.sim.bounds(),
      fitDistance: r => this.fitDistance(r),
      baseFov: () => FOV,
      pickClusterAt: (x, y, slack) => this.pickClusterAt(x, y, slack),
      clusterBodies: () => this.collapsedBodies(),
      expandGroup: g => this.expandGroup(g),
      collapseGroup: g => this.collapseGroup(g),
      toggleAllGroups: () => this.toggleAllGroups(),
      groupOf: i => this.groupOf(i),
      isCollapsed: g => this.isCollapsed(g),
      setAimCluster: g => { if (g !== this.pilotAimCluster) { this.pilotAimCluster = g; this.stale = true; } },
      setFov: deg => this.setFov(deg),
      setAim: i => this.setAim(i),
      onState: (active, text) => this.onPilotState(active, text),
      leave: () => this.setPilot(false),
      onNetworkPose: pose => this.cb.onNetworkPose?.(pose),
      onNetworkShot: shot => this.cb.onNetworkShot?.(shot),
      showScores: on => this.cb.onScores?.(on),
      fireMissile: (id, from, dir, speed, target) => {
        this.powers.launch(id, this.selfId, from, dir, speed, false, target);
        this.cb.onNetworkMissile?.({ id, o: [from.x, from.y, from.z], d: [dir.x, dir.y, dir.z], s: Math.round(speed), ...(target ? { tg: target } : {}) });
      },
      remoteTargets: () => this.remote.targets,
      watchable: () => this.remote.watchable,
      followState: (id, p, q, v) => this.remote.followState(id, p, q, v),
    }, pilotOptions(settings));

    this.remote = new RemoteWorld(this.scene, this.labelLayer, this.camera, () => this.nodeMaterial(), {
      hitTest: (a, b, kind, travelled) => this.pilot.hitTest(a, b, kind, travelled),
      struck: (id, shotId, at) => { this.cb.onNetworkHit?.(id, shotId, at); if (this.pilot.takeDeath()) this.cb.onNetworkKill?.(id); },
    });

    this.powers = new PowerWorld(this.scene, {
      selfId: () => this.selfId,
      ship: out => this.pilot.shipPosition(out),
      hitShip: (damage, from, by, missileId) => {
        if (!this.pilot.applyDamage(damage, from)) return false;
        if (by && missileId) this.cb.onNetworkHit?.(by, missileId, [from.x, from.y, from.z]); // the shooter sees it land
        if (this.pilot.takeDeath()) this.cb.onNetworkKill?.(by);
        return true;
      },
      clusters: () => this.collapsedBodies(),
      breakCluster: g => this.expandGroup(g),
      sendBurst: b => this.cb.onNetworkBurst?.(b),
      sendGrab: id => this.cb.onNetworkGrab?.(id),
      grabbed: kind => this.pilot.receivePickup(kind),
      explode: (x, y, z, size, color) => { this.remote.explode(x, y, z, size, color); this.shockwave(x, y, z, size); },
      sound: kind => this.pilot.playSound(kind),
      pilotPosition: (id, out) => (id === this.selfId ? this.pilot.shipPosition(out) : this.remote.pilotPosition(id, out)),
    });

    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("pointerdown", this.onPointerDown, true); // capture: claim a drag before the orbit controls do
    this.canvas.addEventListener("pointercancel", this.onPointerCancel);
    this.canvas.addEventListener("lostpointercapture", this.onPointerCancel);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.io = new IntersectionObserver(es => { this.visible = es[es.length - 1].isIntersecting; this.stale = true; });
    this.io.observe(container);
    this.resize();
    this.applySettings(settings);
    this.raf = window.requestAnimationFrame(this.frame);
  }

  // ----------------------------------------------------------------- public API

  get nodes(): SimNode[] { return this.sim.nodes; }
  indexOf(id: string): number { return this.idIndex.get(id) ?? -1; }
  neighbors(i: number): number[] { return this.adj[i] ?? []; }
  get selectedIndex(): number { return this.selected; }
  get isPaused(): boolean { return this.paused; }

  setData(data: GraphData): void {
    const oldExp = new Map<string, number>(this.groups.map((g, i) => [g.key, this.exp[i] ?? 1]));
    // remember how each existing note currently looks so a live refresh does not blink
    const prev = new Map<string, [number, number, number]>();
    this.sim.nodes.forEach((p, i) => prev.set(p.id, [this.alpha[i], this.size[i], this.emph[i]]));

    this.reveal = null;
    if (this.nova) { this.sim.novaCancel(); this.nova = null; this.novaBloom = 0; this.uniforms.uPulse.value = 1; this.uniforms.uNova.value = 0; }
    this.groups = data.groups;
    this.gCollapsed = this.groups.map(g => this.collapsedKeys.has(g.key));
    this.exp = new Float32Array(Math.max(1, this.groups.length));
    this.groups.forEach((g, i) => { this.exp[i] = oldExp.get(g.key) ?? (this.gCollapsed[i] ? 0 : 1); });
    for (const k of ["x", "y", "z", "n"] as const) this.gc[k] = new Float64Array(Math.max(1, this.groups.length));
    this.sim.setData(data);
    const n = this.sim.nodes.length;
    this.sim.setScale(n);
    if (this.still) this.sim.settle(n > 4000 ? 120 : 300);
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
    const level = this.multiplayer ? "off" : effectiveMotion(s); // in a room every constellation holds still, so everyone sees the same thing
    this.still = level === "off";
    this.sim.setMotion(level);
    const hc = effectiveHighContrast(s);
    this.uniforms.uGlow.value = hc ? 0.35 : s.glow;
    this.uniforms.uNodeScale.value = s.nodeSize;
    const cap = s.quality === "low" ? 1 : s.quality === "balanced" ? 1.5 : 2, want = Math.min(window.devicePixelRatio || 1, this.ratioForced ? 1 : cap);
    if (Math.abs(this.renderer.getPixelRatio() - want) > 0.01) { this.renderer.setPixelRatio(want); this.resize(); }
    if (this.sim.setSpacing(s.spacing) && this.sim.nodes.length) { this.sim.relayout(); this.frameB = null; }
    this.uniforms.uContrast.value = hc ? 1 : 0;
    this.bloom.strength = (hc ? 0 : 0.35 * s.glow) + this.novaBloom;
    this.controls.enableDamping = effectiveMotion(s) !== "off"; // a room holds the notes still, but the camera should still glide: only the reader's own motion setting turns damping off
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

  setHover(i: number): void { if (i !== this.hover) { this.hover = i; this.dirty = true; this.updateRotate(); this.cb.onHover(i); } }
  setSelected(i: number, fly = true): void {
    this.selected = i; this.follow = i; this.dirty = true; this.stale = true;
    this.updateRotate();
    if (i >= 0 && fly) this.flyTo(i);
  }
  setActive(i: number): void { if (i !== this.active) { this.active = i; this.dirty = true; } }

  // ----------------------------------------------------------------- Pilot mode

  get canPilot(): boolean { return true; }
  get pilotActive(): boolean { return this.pilot.active; }

  // ----------------------------------------------------------------- multiplayer

  private nodeMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: false,
      // screen blending: overlapping stars brighten toward white but never clip, so a crowded group keeps its colour
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcColorFactor });
  }

  /** Start or stop a room: every constellation holds still, and flying follows the room's rules. */
  setMultiplayer(active: boolean, selfId = "me"): void {
    if (active === this.multiplayer) return;
    this.selfId = active ? selfId : "me"; this.powers.setCombat(active); this.powersReady = false;
    if (this.pilot.active) this.pilot.exit(false); // flying starts over with the room's rules
    this.multiplayer = active;
    if (!active) { this.remote.clear(); this.sim.setOrigin(0, 0, 0); this.frameB = null; this.dirty = true; }
    this.applySettings(this.settings);
    this.stale = true;
  }

  /** Move your constellation to your corner of the shared space (the corner depends on your place in the room). */
  setPowerSeed(seed: string): void { this.powerSeed = seed; this.powersReady = false; }
  addRemoteMissile(id: string, m: MissileMsg, from: string): void { this.powers.launch(id, from, new THREE.Vector3(...m.o), new THREE.Vector3(...m.d), m.s, true, m.tg ?? null); this.stale = true; }
  addRemoteBurst(b: BurstMsg): void { this.powers.addBurst(b, performance.now()); this.stale = true; }
  remoteGrab(pickup: number): void { this.powers.remoteGrab(pickup, performance.now()); }

  /** Lay the pickups out: around the room's middle in a room (from the room code), or around your own constellation when you fly alone. */
  private refreshPowers(): void {
    this.powersReady = true;
    if (this.multiplayer) this.powers.setLayout(pickupLayout(this.powerSeed || "room", [0, 0, 0], 750));
    else { const b = this.sim.bounds(); this.powers.setLayout(pickupLayout("solo", [b.cx, b.cy, b.cz], Math.max(120, b.radius * 1.3))); }
  }

  setWorldOrigin(slot: number): void {
    const o = WORLD_ORIGINS[Math.max(0, Math.min(3, Math.floor(slot)))];
    this.sim.setOrigin(o[0], o[1], o[2]); this.frameB = null; this.dirty = true; this.stale = true;
  }

  setRemoteTopology(id: string, topology: AnonymousTopology, name: string, slot: number): void { this.remote.setTopology(id, topology, name, slot); this.stale = true; }
  setRemotePositions(id: string, positions: Float32Array): void { this.remote.setPositions(id, positions); this.stale = true; }
  setRemotePose(id: string, pose: Pose): void { this.remote.setPose(id, pose); this.stale = true; }
  addRemoteShot(id: string, shot: ShotMsg): void { this.remote.addShot(id, shot); this.stale = true; }
  /** Draw one frame and take it as a PNG. Only the 3D scene is in it (the names are separate page elements), so it never shows a note title. */
  capture(): Promise<Blob | null> {
    if (this.contextLost) return Promise.resolve(null);
    try {
      if (this.settings.bloom && this.settings.quality !== "low" && !this.degraded && !effectiveHighContrast(this.settings) && this.bloom.strength > 0) this.composer.render(); else this.renderer.render(this.scene, this.camera);
      return new Promise(resolve => this.canvas.toBlob(b => resolve(b), "image/png")); // the snapshot is taken as toBlob is called, before the buffer is cleared
    } catch { return Promise.resolve(null); }
  }

  /** You destroyed another pilot. */
  rewardKill(): void { this.pilot.healOnKill(); }
  showRemoteHit(hit: HitMsg): void { this.remote.showHit(hit); this.powers.detonate(hit.shotId); this.pilot.hitConfirmed(); this.stale = true; }
  removeRemote(id: string): void { this.remote.remove(id); this.stale = true; }

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
    this.tween = null; this.follow = -1; this.autoFrame = false; this.zoomGoal = 0;
    window.clearTimeout(this.resumeTimer);
    this.controls.enabled = false; this.controls.autoRotate = false;
    this.frameB = this.sim.bounds();
    if (this.selected >= 0) { this.setSelected(-1, false); this.cb.onSelect(-1); } // Pilot mode is a sandbox: nothing stays selected
    const mode = this.settings.pilotCollapse, big = this.sim.nodes.length > PILOT_AUTO_COLLAPSE;
    if (mode === "always" || (mode === "auto" && big && !this.autoCollapsed)) { this.collapseAll(true); this.autoCollapsed = true; } // a big vault starts folded up, so there is somewhere to start
    this.pilot.enter();
  }

  private onPilotState(active: boolean, text: string): void {
    if (!active) { // flight is over: hand the camera back to the orbit controls without a jump, then ease out to the full view
      const dir = this.tmp.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const b = this.sim.bounds();
      this.controls.target.copy(this.camera.position).addScaledVector(dir, Math.max(60, this.camera.position.distanceTo(this.tmp2.set(b.cx, b.cy, b.cz))));
      this.controls.enabled = true;
      this.setFov(FOV);
      this.aim = -1; this.dirty = true; this.stale = true;
      this.autoFrame = true;
      this.updateRotate();
      this.resetView();
    }
    this.cb.onPilot?.(active, text);
  }

  /** The centre, rough radius and colour of every group that is showing: what Pilot mode draws as wireframe shells. */
  private clusterShells(): { x: number; y: number; z: number; r: number; color: string }[] {
    const G = this.groups.length, nodes = this.sim.nodes;
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

  /**
   * A blast shoves nearby notes away and makes them flare, then they spring back (like a rubber band, a little overshoot).
   * This is only how they are drawn: the layout, and what other pilots see of it, do not change. Off with the reader's motion setting.
   */
  private shockwave(x: number, y: number, z: number, size: number): void {
    if (effectiveMotion(this.settings) === "off" || !this.jolt.length) return;
    const nodes = this.sim.nodes, R = Math.max(40, size * 9), R2 = R * R, peak = 65 + size * 9;
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i], dx = p.x - x, dy = p.y - y, dz = p.z - z, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > R2 || this.alpha[i] < 0.05) continue;
      const d = Math.sqrt(d2) || 1, f = (1 - d / R) ** 2 * peak / d;
      this.joltV[i * 3] += dx * f; this.joltV[i * 3 + 1] += dy * f; this.joltV[i * 3 + 2] += dz * f;
      this.emph[i] = Math.max(this.emph[i], 1.6 * (1 - d / R) + 0.2); // a flare that fades back by itself
    }
    this.joltLive = true; this.stale = true;
  }

  private stepJolt(dt: number): void {
    const h = Math.min(dt, 0.05), K = 16, C = 4.2;
    let live = false;
    for (let j = 0; j < this.jolt.length; j++) {
      const v = this.joltV[j] + (-K * this.jolt[j] - C * this.joltV[j]) * h;
      this.joltV[j] = v; this.jolt[j] += v * h;
      if (Math.abs(this.jolt[j]) > 0.02 || Math.abs(v) > 0.1) live = true; else { this.jolt[j] = 0; this.joltV[j] = 0; }
    }
    this.joltLive = live;
  }

  private setAim(i: number): void { if (i !== this.aim) { this.aim = i; this.dirty = true; } }
  setSearch(matches: Set<number> | null): void { this.search = matches; this.dirty = true; }
  setHidden(groupIndex: number, hide: boolean): void { hide ? this.hidden.add(groupIndex) : this.hidden.delete(groupIndex); this.dirty = true; }
  isHidden(groupIndex: number): boolean { return this.hidden.has(groupIndex); }

  flyTo(i: number): void {
    if (this.pilot.active) { this.pilot.warpToNode(i); return; }
    const n = this.sim.nodes[i]; if (!n) return;
    const dir = this.tmp.copy(this.camera.position).sub(this.controls.target);
    if (dir.lengthSq() < 1) dir.set(0.3, 0.2, 1);
    dir.normalize();
    const to = new THREE.Vector3(n.x, n.y, n.z);
    this.startTween(to.clone().addScaledVector(dir, 85 + baseRadius(n.deg) * 6), to, 1300);
  }

  /** A tour: the camera visits a chain of linked notes, a few seconds at each. Touching the camera, or calling this again, ends it. */
  tour(): void {
    if (this.tourTimer) { this.tourStop(false); return; }
    if (this.pilot.active || this.multiplayer || this.nova || !this.sim.nodes.length) return;
    const start = this.selected >= 0 ? this.selected : busiestNote(this.adj);
    const stops = planTour(this.adj, start);
    if (stops.length < 2) { this.cb.onActivity?.(null, "This note has no links to follow"); return; }
    let at = 0;
    const step = () => {
      const i = stops[at]; this.setSelected(i, false); this.cb.onSelect(i); this.flyTo(i);
      this.cb.onActivity?.(null, `Tour: ${this.sim.nodes[i]?.name ?? ""} (${at + 1} of ${stops.length})`);
      if (++at >= stops.length) { window.clearInterval(this.tourTimer); this.tourTimer = window.setTimeout(() => this.tourStop(false), 3200); }
    };
    step(); this.tourTimer = window.setInterval(step, 3600);
  }

  private tourStop(byUser: boolean): void {
    if (!this.tourTimer) return;
    window.clearInterval(this.tourTimer); window.clearTimeout(this.tourTimer); this.tourTimer = 0;
    this.cb.onActivity?.(null, byUser ? "" : "Tour finished");
  }

  /** The first framing: the way the reader left the camera last time if they asked for that, otherwise the whole graph. */
  private openView(): void {
    const sv = this.settings.savedView;
    if (!this.settings.rememberView || !sv) { this.resetView(); return; }
    this.follow = -1; this.autoFrame = false;
    const b = this.sim.bounds(), c = new THREE.Vector3(b.cx, b.cy, b.cz);
    this.startTween(c.clone().addScaledVector(new THREE.Vector3(...sv.d), this.fitDistance(b.radius) * sv.z), c, 1500);
  }

  /** A moment after the camera stops, tell the app where it is, so the next session can open the same way. */
  private scheduleViewSave(): void {
    if (!this.settings.rememberView) return;
    window.clearTimeout(this.viewTimer);
    this.viewTimer = window.setTimeout(() => {
      if (this.pilot.active || this.nova || this.multiplayer || this.tween || !this.fitDone) return;
      const b = this.sim.bounds(), d = this.camera.position.clone().sub(this.controls.target), len = d.length();
      if (len < 1) return;
      const z = Math.min(2, Math.max(0.25, len / this.fitDistance(b.radius))); d.divideScalar(len);
      this.cb.onView?.({ d: [+d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3)], z: +z.toFixed(3) });
    }, 1800);
  }

  resetView(): void {
    if (this.pilot.active) { this.pilot.returnToHub(); return; }
    this.follow = -1; this.autoFrame = true;
    const b = this.sim.bounds();
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
    if (this.pilot.active || this.multiplayer) return; // not while flying or in a room
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
    if (this.pilot.active || this.multiplayer) return;
    if (this.nova) { this.novaStop(false); return; }
    if (this.reveal) this.endAnimation(false);
    if (this.drag || !this.sim.nodes.length) return;
    this.autoFrame = true; this.follow = -1;
    if (this.selected >= 0) { this.setSelected(-1, false); this.cb.onSelect(-1); }
    if (this.still) {
      this.sim.relayout(); this.dirty = true; this.stale = true; this.resetView();
      this.cb.onActivity?.(null, "Layout re-optimized"); return;
    }
    if (this.paused) { this.cb.onActivity?.(null, "Resume motion first, then start the black hole"); return; }
    // the disk is tilted about 25 degrees toward you from edge-on, so you see its face and the ring bent over the hole
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion), toward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
    const axis = up.multiplyScalar(Math.cos(0.45)).addScaledVector(toward, Math.sin(0.45)).normalize();
    this.sim.novaStart([axis.x, axis.y, axis.z]);
    this.nova = { stage: "collapse", t0: this.age, blastAt: 0, traceT0: 0, depth: new Int16Array(0), maxDepth: 0 };
    this.cb.onActivity?.("supernova", "Black hole: forming");
  }

  private novaStop(finished: boolean): void {
    this.sim.novaCancel();
    this.nova = null; this.novaBloom = 0; this.dirty = true; this.stale = true;
    this.uniforms.uPulse.value = 1; this.uniforms.uNova.value = 0; this.flashEl.setCssProps({ opacity: "0" });
    this.bloom.strength = effectiveHighContrast(this.settings) ? 0 : 0.35 * this.settings.glow;
    this.hole.reset();
    this.cb.onActivity?.(null, finished ? "Layout optimized" : "Black hole stopped");
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
    this.cb.onActivity?.("supernova", "Black hole: tracing the shortest paths");
  }

  private fitDistance(radius: number): number {
    const v = (FOV * Math.PI) / 360, h = Math.atan(Math.tan(v) * this.camera.aspect);
    return (radius / Math.sin(Math.min(v, h))) * 1.08;
  }

  destroy(): void {
    window.cancelAnimationFrame(this.raf);
    window.clearInterval(this.tourTimer); window.clearTimeout(this.tourTimer);
    window.clearTimeout(this.resumeTimer);
    this.ro.disconnect(); this.io.disconnect();
    this.controls.removeEventListener("start", this.onControlStart);
    this.controls.removeEventListener("end", this.onControlEnd);
    this.controls.dispose();
    for (const [ev, fn] of [
      ["pointermove", this.onPointerMove], ["pointerleave", this.onPointerLeave], ["pointercancel", this.onPointerCancel], ["lostpointercapture", this.onPointerCancel],
      ["pointerup", this.onPointerUp],
      ["webglcontextlost", this.onContextLost], ["webglcontextrestored", this.onContextRestored],
    ] as [string, EventListener][]) this.canvas.removeEventListener(ev, fn);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown, true);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.pilot.destroy(); this.remote.dispose(); this.powers.dispose();
    this.disposeNodes();
    this.stars.geometry.dispose(); (this.stars.material as THREE.Material).dispose();
    // EffectComposer.dispose() does not free its passes, and browsers cap live WebGL contexts
    window.clearTimeout(this.viewTimer); this.hole.dispose(); this.bloom.dispose(); this.renderPass.dispose(); this.composer.dispose();
    this.renderer.dispose(); this.renderer.forceContextLoss();
    this.canvas.remove(); this.labelLayer.remove(); this.flashEl.remove();
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
    for (const o of [this.nodePoints, this.lines, this.clusterPts]) {
      if (!o) continue;
      this.scene.remove(o); o.geometry.dispose(); (o.material as THREE.Material).dispose();
    }
    this.nodePoints = null; this.lines = null; this.clusterPts = null;
  }

  private allocate(n: number, l: number): void {
    this.disposeNodes();
    this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 3);
    this.jolt = new Float32Array(n * 3); this.joltV = new Float32Array(n * 3); this.joltLive = false;
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
    this.scene.add(this.nodePoints);

    // one bright point per group, drawn only while the group is collapsed
    const G = Math.max(1, this.groups.length);
    this.cpos = new Float32Array(G * 3); this.ccol = new Float32Array(G * 3); this.csize = new Float32Array(G);
    this.calpha = new Float32Array(G); this.cemph = new Float32Array(G);
    const cg = new THREE.BufferGeometry();
    const mkc = (name: string, arr: Float32Array, item: number) => { const at = new THREE.BufferAttribute(arr, item); at.setUsage(THREE.DynamicDrawUsage); cg.setAttribute(name, at); };
    mkc("position", this.cpos, 3); mkc("aColor", this.ccol, 3); mkc("aSize", this.csize, 1); mkc("aAlpha", this.calpha, 1); mkc("aEmph", this.cemph, 1);
    this.clusterPts = new THREE.Points(cg, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }));
    this.clusterPts.frustumCulled = false;
    this.clusterPts.renderOrder = 2;
    this.scene.add(this.clusterPts);

    this.linePos = new Float32Array(l * 6); this.lineCol = new Float32Array(l * 6);
    const lg = new THREE.BufferGeometry();
    const lp = new THREE.BufferAttribute(this.linePos, 3); lp.setUsage(THREE.DynamicDrawUsage); lg.setAttribute("position", lp);
    const lc = new THREE.BufferAttribute(this.lineCol, 3); lc.setUsage(THREE.DynamicDrawUsage); lg.setAttribute("color", lc);
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 1;
    this.scene.add(this.lines);
  }

  private recolor(): void {
    const nodes = this.sim.nodes;
    this.nodeRgb = nodes.map(p => new THREE.Color(this.groups[p.gi]?.color ?? "#8b93a7"));
    nodes.forEach((_, i) => { const c = this.nodeRgb[i]; this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b; });
    if (this.nodePoints) (this.nodePoints.geometry.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;
    this.groups.forEach((g, i) => { const c = new THREE.Color(g.color); this.ccol[i * 3] = c.r; this.ccol[i * 3 + 1] = c.g; this.ccol[i * 3 + 2] = c.b; });
    if (this.clusterPts) (this.clusterPts.geometry.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h); // also resizes every pass
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.uniforms.uScale.value = (h * this.renderer.getPixelRatio()) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.stale = true;
  }

  /** Widen or narrow the view (the afterburner's kick). The size of the glowing notes follows, so they do not seem to change size. */
  private setFov(deg: number): void {
    if (Math.abs(this.camera.fov - deg) < 0.02) return;
    this.camera.fov = deg; this.camera.updateProjectionMatrix();
    this.uniforms.uScale.value = (Math.max(1, this.container.clientHeight) * this.renderer.getPixelRatio()) / (2 * Math.tan((deg * Math.PI) / 360));
    this.stale = true;
  }

  // ----------------------------------------------------------------- interaction

  private onContextLost = (e: Event) => { e.preventDefault(); this.contextLost = true; };
  private onContextRestored = () => { this.contextLost = false; this.stale = true; this.resize(); };

  private onWheel = (e: WheelEvent) => {
    if (this.pilot.active || this.drag) return;
    e.preventDefault();
    const cur = this.camera.position.distanceTo(this.controls.target) || 1;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
    const base = this.zoomGoal > 0 ? this.zoomGoal : cur;
    this.zoomGoal = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, base * Math.exp(Math.max(-400, Math.min(400, dy)) * 0.00046)));
    this.onControlStart(); this.onControlEnd(); // a zoom counts as the reader steering, so the camera drift waits and the auto-framing lets go
    this.stale = true;
  };

  /** Ease the camera toward the wheel's goal distance. True while it is still moving. */
  private stepZoom(dt: number): boolean {
    if (this.zoomGoal <= 0) return false;
    const t = this.controls.target, cp = this.camera.position;
    const cur = cp.distanceTo(t) || 1, k = 1 - Math.exp(-dt * 12);
    let next = cur + (this.zoomGoal - cur) * k;
    if (Math.abs(this.zoomGoal - next) < Math.max(0.05, cur * 0.0008)) { next = this.zoomGoal; this.zoomGoal = 0; }
    cp.sub(t).multiplyScalar(next / cur).add(t);
    return true;
  }

  private onControlStart = () => { this.tourStop(true); window.clearTimeout(this.resumeTimer); this.controls.autoRotate = false; this.tween = null; this.autoFrame = false; this.userActive = true; this.updateRotate(); };
  private onControlEnd = () => {
    this.userActive = false; this.scheduleViewSave();
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
    if (e.button !== 0 || this.pilot.active) return; // in Pilot mode a press is a shot, handled by the pilot
    this.setPointer(e);
    let hit = this.pick();
    if (hit < 0) hit = this.pick(PRESS_SLACK_PX); // notes drift while the hand travels, so a press may land just beside one
    this.setHover(hit); // touch taps never fire a move first
    const cl = this.hover < 0 ? this.pickClusterAt(this.pointer.x, this.pointer.y, PRESS_SLACK_PX) : -1; // a collapsed group, if no note is there
    this.press = { i: this.hover, x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, c: cl };
    if (this.hover >= 0 && !this.nova) {
      this.controls.enabled = false; // otherwise the orbit controls start turning the camera under a click
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    }
  };
  private onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0 || this.pilot.active) return;
    const p = this.press; this.press = null;
    if (this.drag) { this.dragEnd(); return; }
    this.endPress(p);
    if (!p) return;
    if (p.c >= 0 && Math.hypot(e.clientX - p.x, e.clientY - p.y) <= 8) { this.expandGroup(p.c); return; } // a click on a collapsed group opens it
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
    const v = this.tmp, nodes = this.sim.nodes, cam = this.camera.position;
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

  /** The collapsed group under a point of the canvas, or -1. */
  private pickClusterAt(px: number, py: number, slack = 0): number {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, dpr = this.renderer.getPixelRatio();
    const v = this.tmp, cam = this.camera.position;
    const fx = this.fwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let best = -1, bestScore = 1e9;
    for (let g = 0; g < this.groups.length; g++) {
      if (this.hidden.has(g) || this.exp[g] > 0.5) continue;
      const cx = this.gc.x[g], cy = this.gc.y[g], cz = this.gc.z[g];
      if ((cx - cam.x) * fx.x + (cy - cam.y) * fx.y + (cz - cam.z) * fx.z < 1) continue;
      v.set(cx, cy, cz).project(this.camera);
      if (v.z > 1) continue;
      const d = Math.hypot((v.x * 0.5 + 0.5) * w - px, (-v.y * 0.5 + 0.5) * h - py);
      const dist = cam.distanceTo(this.tmp2.set(cx, cy, cz)) || 1;
      const sprite = Math.min(190, Math.max(9, (((this.clusterRadius(g) * 2) / CORE) * this.uniforms.uScale.value) / dist)) / dpr;
      const reach = Math.max(22, sprite * CORE * 0.5 * 1.3 + 12) + slack;
      if (d < reach) { const score = d + dist * 0.01; if (score < bestScore) { bestScore = score; best = g; } }
    }
    return best;
  }

  /** Open a collapsed group: its notes fly back out from the middle. */
  expandGroup(g: number): void { this.setGroupCollapsed(g, false); }
  collapseGroup(g: number): void { this.setGroupCollapsed(g, true); }
  toggleGroup(g: number): void { this.setGroupCollapsed(g, !this.gCollapsed[g]); }
  isCollapsed(g: number): boolean { return !!this.gCollapsed[g]; }
  get anyCollapsed(): boolean { return this.gCollapsed.some(Boolean); }
  groupOf(noteIndex: number): number { return this.sim.nodes[noteIndex]?.gi ?? -1; }

  private setGroupCollapsed(g: number, collapsed: boolean, instant = false): void {
    const info = this.groups[g]; if (!info || !!this.gCollapsed[g] === collapsed) return;
    this.gCollapsed[g] = collapsed;
    collapsed ? this.collapsedKeys.add(info.key) : this.collapsedKeys.delete(info.key);
    if (collapsed) this.measureGroups(); // so the notes know where to fly to
    if (instant) this.exp[g] = collapsed ? 0 : 1;
    if (collapsed && this.selected >= 0 && this.sim.nodes[this.selected]?.gi === g) { this.setSelected(-1, false); this.cb.onSelect(-1); }
    this.dirty = true; this.stale = true;
  }

  collapseAll(instant = false): void { for (let g = 0; g < this.groups.length; g++) this.setGroupCollapsed(g, true, instant); }
  expandAll(instant = false): void { for (let g = 0; g < this.groups.length; g++) this.setGroupCollapsed(g, false, instant); }
  /** Collapse everything, or open everything if something is already collapsed. */
  toggleAllGroups(): void { this.anyCollapsed ? this.expandAll() : this.collapseAll(); }

  /** Collapsed groups, for the map and for collisions. */
  private collapsedBodies(): { x: number; y: number; z: number; r: number; color: string; name: string; g: number }[] {
    const out: { x: number; y: number; z: number; r: number; color: string; name: string; g: number }[] = [];
    for (let g = 0; g < this.groups.length; g++) {
      if (this.hidden.has(g) || this.exp[g] > 0.5) continue;
      out.push({ x: this.gc.x[g], y: this.gc.y[g], z: this.gc.z[g], r: this.clusterRadius(g), color: this.groups[g].color, name: `${this.groups[g].label} (${this.groups[g].count})`, g });
    }
    return out;
  }

  private startTween(p1: THREE.Vector3, t1: THREE.Vector3, dur: number): void {
    this.zoomGoal = 0;
    if (effectiveMotion(this.settings) === "off") { // reduced motion: no flying, just arrive
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

    let moving = false;
    if (!this.paused) { this.sim.step(dt); moving = this.sim.isActive(); }
    if (!this.drag && !this.pilot.active && (this.pointer.moved || (this.pointer.inside && moving && this.frameNo % 8 === 0))) {
      this.pointer.moved = false;
      this.setHover(this.pointer.inside ? this.pick() : -1);
      this.canvas.style.cursor = this.hover >= 0 || (this.anyCollapsed && this.pickClusterAt(this.pointer.x, this.pointer.y) >= 0) ? "pointer" : "grab";
    }
    this.updateShows(dt);
    if (this.dirty) this.recomputeTargets();

    const animating = this.updateBuffers(dt, moving || this.stale);
    const hs = this.sim.holeState();
    if (hs.active) this.applyHoleToNodes(hs);
    if (hs.active || this.hole.alive) {
      const lensOn = this.settings.bloom && this.settings.quality !== "low" && !this.degraded && !effectiveHighContrast(this.settings) && this.bloom.strength > 0;
      const px = (this.canvas.clientHeight * this.renderer.getPixelRatio()) / (2 * Math.tan((FOV * Math.PI) / 360));
      this.hole.update(dt, hs, lensOn, px, this.camera.aspect);
      this.stale = true;
    }
    let camMoved = false;
    if (this.pilot.active) {
      this.pilot.update(dt);
      // keep the orbit target ahead of the ship, so labels still fade with distance
      this.controls.target.copy(this.camera.position).addScaledVector(this.tmp.set(0, 0, -1).applyQuaternion(this.camera.quaternion), 300);
      this.stale = true;
    } else {
      this.updateCamera(now);
      const zoomed = this.stepZoom(dt);
      camMoved = this.controls.update(dt) || zoomed;
    }
    if (this.pilot.active || this.multiplayer) {
      if (!this.powersReady) this.refreshPowers();
      this.powers.setVisible(this.pilot.active);
      this.powers.update(dt, performance.now());
    }
    if (this.remote.any) { this.remote.update(dt, this.canvas.clientWidth, this.canvas.clientHeight); this.stale = true; }
    if (!(moving || animating || camMoved || this.stale || this.tween || this.follow >= 0)) return; // fully at rest: draw nothing
    this.stale = false;

    this.stars.rotation.y += this.paused || this.still ? 0 : dt * 0.004;
    this.updateLabels();
    if (this.settings.bloom && this.settings.quality !== "low" && !this.degraded && !effectiveHighContrast(this.settings) && this.bloom.strength > 0) this.composer.render(); else this.renderer.render(this.scene, this.camera);

    // protect slow machines: drop the glow pass first, then lower resolution
    this.slow = dt > 0.04 ? this.slow + 1 : Math.max(0, this.slow - 1);
    if (this.slow > 90) {
      this.slow = 0;
      if (!this.degraded) this.degraded = true;
      else if (this.renderer.getPixelRatio() > 1) { this.ratioForced = true; this.renderer.setPixelRatio(1); this.resize(); }
    }
  };

  /** Notes near the hole shrink and darken as they are stretched toward it (a crude spaghettification and redshift), and swallowed ones vanish. */
  private applyHoleToNodes(h: { x: number; y: number; z: number; rh: number }): void {
    const nodes = this.sim.nodes, gone = this.sim.swallowed, geo = this.nodePoints?.geometry;
    if (!geo) return;
    for (let i = 0; i < nodes.length; i++) {
      if (gone && gone[i]) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      const n = nodes[i], d = Math.hypot(n.x - h.x, n.y - h.y, n.z - h.z), t = Math.min(1, Math.max(0, (d - h.rh * 1.1) / (h.rh * 6)));
      const f = t * t * (3 - 2 * t);
      this.alpha[i] = Math.min(this.alpha[i], 0.12 + 0.88 * f);
      this.size[i] = Math.min(this.size[i], this.baseSize[i] * (0.35 + 0.65 * f));
    }
    (geo.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aAlpha") as THREE.BufferAttribute).needsUpdate = true;
  }

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
      if (phase === "settle") { nv.stage = "settle"; nv.blastAt = now; this.hole.release(); this.cb.onActivity?.("supernova", "Black hole: it lets go"); }
      else {
        const hs = this.sim.holeState();
        this.uniforms.uNova.value = 0; this.uniforms.uPulse.value = 1; this.novaBloom = 0.35 * hs.frac; // the hole is lit by its own disk, not by the notes
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
      if (this.hidden.has(nodes[i].gi) || this.gCollapsed[nodes[i].gi] || (this.reveal && this.reveal.rank[i] >= this.reveal.count)) a = 0;
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
    // groups opening and closing: each has a number from 1 (open) to 0 (collapsed) that eases toward its goal
    let opening = false;
    for (let g = 0; g < this.exp.length; g++) {
      const goal = this.gCollapsed[g] ? 0 : 1, d = goal - this.exp[g];
      if (Math.abs(d) > 0.002) { this.exp[g] += d * (this.still ? 1 : Math.min(1, dt * 5)); opening = true; } else this.exp[g] = goal;
    }
    const anyClosed = this.exp.some(e => e < 1);
    if (anyClosed) this.measureGroups();
    if (opening) animating = true;
    if (this.joltLive) { this.stepJolt(dt); animating = true; }
    if (!positionsChanged && !animating && !anyClosed) return false;

    const geo = this.nodePoints!.geometry;
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i], e = this.exp[p.gi];
      if (e < 1) { // on its way into, or out of, the middle of its group
        const cx = this.gc.x[p.gi], cy = this.gc.y[p.gi], cz = this.gc.z[p.gi];
        this.pos[i * 3] = cx + (p.x - cx) * e; this.pos[i * 3 + 1] = cy + (p.y - cy) * e; this.pos[i * 3 + 2] = cz + (p.z - cz) * e;
      } else { this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z; }
      this.pos[i * 3] += this.jolt[i * 3]; this.pos[i * 3 + 1] += this.jolt[i * 3 + 1]; this.pos[i * 3 + 2] += this.jolt[i * 3 + 2];
    }
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aAlpha") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aEmph") as THREE.BufferAttribute).needsUpdate = true;

    const src = this.sim.srcs, dst = this.sim.dsts, hc = effectiveHighContrast(this.settings);
    const base = (hc ? 0.55 : 0.2) * this.settings.linkBrightness, boost = hc ? 1.6 : 2.6;
    const primary = this.hover >= 0 ? this.hover : this.selected;
    for (let l = 0; l < src.length; l++) {
      const s = src[l], d = dst[l], a = s.index, b = d.index, o = l * 6;
      this.linePos[o] = this.pos[a * 3]; this.linePos[o + 1] = this.pos[a * 3 + 1]; this.linePos[o + 2] = this.pos[a * 3 + 2];
      this.linePos[o + 3] = this.pos[b * 3]; this.linePos[o + 4] = this.pos[b * 3 + 1]; this.linePos[o + 5] = this.pos[b * 3 + 2];
      const va = this.vis(a), vb = this.vis(b); // a link stays lit while its note is folded into a group point
      let f = base * Math.min(va, vb);
      if (primary >= 0 && (a === primary || b === primary)) f = Math.min(1, base * boost) * Math.min(1, va + vb);
      if (this.reveal || this.age - Math.max(this.birth[a], this.birth[b]) < 1) { // a link flashes the moment both ends exist
        const born = this.age - Math.max(this.birth[a], this.birth[b]);
        if (born >= 0 && born < 1) f += base * 3.5 * (1 - born) * Math.min(va, vb);
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
    this.updateClusterPoints();
    return animating;
  }

  /** How visible a note is, counting the point its group becomes when it is collapsed. */
  private vis(i: number): number {
    const gi = this.sim.nodes[i].gi;
    return this.hidden.has(gi) ? this.alpha[i] : Math.max(this.alpha[i], 1 - this.exp[gi]);
  }

  /** The middle of every group, from where its notes are right now. */
  private measureGroups(): void {
    const G = this.exp.length, { x, y, z, n } = this.gc;
    x.fill(0); y.fill(0); z.fill(0); n.fill(0);
    for (const p of this.sim.nodes) { x[p.gi] += p.x; y[p.gi] += p.y; z[p.gi] += p.z; n[p.gi]++; }
    for (let g = 0; g < G; g++) { const c = n[g] || 1; x[g] /= c; y[g] /= c; z[g] /= c; }
  }

  /** How big a collapsed group looks, in scene units, from how many notes it holds. */
  private clusterRadius(g: number): number {
    return Math.min(15, 3.4 + 2.2 * Math.log2(1 + (this.groups[g]?.count ?? 1)));
  }

  private updateClusterPoints(): void {
    if (!this.clusterPts) return;
    const aimC = this.pilot.active ? this.pilotAimCluster : -1;
    for (let g = 0; g < this.groups.length; g++) {
      const shown = this.hidden.has(g) ? 0 : Math.min(1, Math.max(0, 1 - this.exp[g]) * 1.15);
      this.cpos[g * 3] = this.gc.x[g]; this.cpos[g * 3 + 1] = this.gc.y[g]; this.cpos[g * 3 + 2] = this.gc.z[g];
      this.csize[g] = ((this.clusterRadius(g) * 2) / CORE) * (g === aimC ? 1.25 : 1);
      this.calpha[g] = shown; this.cemph[g] = g === aimC ? 0.9 : 0.35;
    }
    const geo = this.clusterPts.geometry;
    for (const k of ["position", "aSize", "aAlpha", "aEmph"]) (geo.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;
  }

  private updateCamera(now: number): void {
    if (!this.fitDone && this.age > 1.8 && this.sim.nodes.length) { this.fitDone = true; this.openView(); }
    if (this.tween) {
      const t = Math.min(1, (now - this.tween.t0) / this.tween.dur), e = 1 - Math.pow(1 - t, 3);
      if (this.follow >= 0 && this.sim.nodes[this.follow]) { // keep aiming at the node while it drifts
        const n = this.sim.nodes[this.follow], dirLen = this.tween.p1.distanceTo(this.tween.t1v);
        const dir = this.tmp.copy(this.tween.p1).sub(this.tween.t1v).normalize();
        this.tween.t1v.set(n.x, n.y, n.z); this.tween.p1.copy(this.tween.t1v).addScaledVector(dir, dirLen);
      }
      this.controls.target.lerpVectors(this.tween.t0v, this.tween.t1v, e);
      this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, e);
      if (t >= 1) this.tween = null;
    } else if (this.follow >= 0 && this.sim.nodes[this.follow]) {
      const n = this.sim.nodes[this.follow];
      const d = this.tmp.set(n.x, n.y, n.z).sub(this.controls.target).multiplyScalar(this.still ? 1 : 0.12);
      this.controls.target.add(d); this.camera.position.add(d);
    } else if (this.fitDone && !this.still && !this.paused && !this.userActive) {
      // the clusters keep orbiting, so keep the camera on them: ease toward their centre, and back in if the view has drifted far away
      if (this.frameNo % (this.nova ? 5 : 45) === 0 || !this.frameB) this.frameB = this.sim.bounds();
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

  /** The few notes closest to the ship, for the names shown while flying. Worked out a few times a second, not every frame. */
  private refreshNear(): void {
    this.nearAt = true;
    const nodes = this.sim.nodes, cp = this.camera.position, r = this.nearRadius = Math.max(60, this.sim.bounds().radius * 0.22), r2 = r * r;
    const fd = this.fwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const best: { i: number; d: number }[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i], dx = n.x - cp.x, dy = n.y - cp.y, dz = n.z - cp.z, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2 || dx * fd.x + dy * fd.y + dz * fd.z < 0 || !this.host_solid(i)) continue; // close, in front of you, and showing
      best.push({ i, d: d2 });
    }
    best.sort((a, b) => a.d - b.d);
    this.nearLabels.length = 0;
    for (let k = 0; k < Math.min(NEAR_LABELS, best.length); k++) this.nearLabels.push(best[k].i);
  }

  private host_solid(i: number): boolean { const n = this.sim.nodes[i]; return !!n && !this.hidden.has(n.gi) && this.alpha[i] > 0.3; }

  private updateLabels(): void {
    const s = this.settings, nodes = this.sim.nodes, hc = effectiveHighContrast(s);
    if (this.nova && this.nova.stage !== "trace") { for (const l of this.labels) l.toggleClass("cg-hidden", true); return; }
    const want: number[] = [];
    const seen = new Set<number>();
    const add = (i: number) => { if (i >= 0 && !seen.has(i) && !this.hidden.has(nodes[i].gi) && !this.gCollapsed[nodes[i].gi]) { seen.add(i); want.push(i); } };
    if (this.reveal) for (let k = this.reveal.count - 1; k >= Math.max(0, this.reveal.count - 3); k--) add(this.reveal.order[k]); // the newest arrivals
    add(this.hover); add(this.selected); add(this.active); add(this.pilot.active ? this.aim : -1);
    const primary = this.hover >= 0 ? this.hover : this.selected;
    if (primary >= 0) {
      let top = this.adj[primary].slice();
      if (top.length > 8) top = top.sort((a, b) => nodes[b].deg - nodes[a].deg).slice(0, 8);
      top.forEach(add);
    }
    if (this.search) { let c = 0; for (const i of this.search) { add(i); if (++c > 14) break; } }
    else if (this.pilot.active) { // flying: only what you are aiming at or have locked, and whatever is close to the ship
      add(this.labelPriority[0] ?? -1); // the vault's centre (its most-connected note) is always named; nothing else is
      if (this.frameNo % 8 === 0 || !this.nearAt) this.refreshNear();
      for (const i of this.nearLabels) add(i);
    }
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
      const must = i === this.hover || i === this.selected || (this.pilot.active && i === this.aim);
      if (!must && placed.some(r => x < r.x + r.w && x + lw > r.x && y < r.y + r.h && y + lh > r.y)) continue;
      placed.push({ x, y, w: lw, h: lh });
      let el = this.labels[used];
      if (!el) { el = this.labelLayer.createDiv({ cls: "cg-label" }); this.labels[used] = el; }
      if (el.textContent !== n.name) el.textContent = n.name;
      // fade with real distance from the camera; labels never drop below 60% and are always opaque in high contrast
      const dist = this.camera.position.distanceTo(this.tmp2.set(n.x, n.y, n.z));
      const depth = hc ? 1 : Math.max(0.6, Math.min(1, 1.25 - 0.45 * (dist / (focusDist * 1.4))));
      const near = this.pilot.active && i !== this.labelPriority[0] ? clamp01(1.3 - dist / this.nearRadius) : 1; // flying: a name fades in as you come close (the vault's centre stays)
      el.style.opacity = String(must || hc ? 1 : Math.min(1, depth * near * Math.min(1, this.alpha[i] * 1.3)));
      el.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px) translate(-50%, -100%)`;
      el.classList.toggle("cg-label-strong", must);
      el.toggleClass("cg-hidden", false);
      used++;
    }
    for (let k = used; k < this.labels.length; k++) this.labels[k].toggleClass("cg-hidden", true);

    // a name and a count on every collapsed group
    let shownClusters = 0;
    for (let g = 0; g < this.groups.length; g++) {
      if (this.hidden.has(g) || this.exp[g] > 0.6) continue;
      const cx = this.gc.x[g], cy = this.gc.y[g], cz = this.gc.z[g];
      v.set(cx, cy, cz).project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) continue;
      if (this.pilot.active && (cx - cx0) * fx0 + (cy - cy0) * fy0 + (cz - cz0) * fz0 < 1) continue;
      let el = this.clusterLabels[shownClusters];
      if (!el) { el = this.labelLayer.createDiv({ cls: "cg-label cg-label-cluster" }); this.clusterLabels[shownClusters] = el; }
      const text = `${this.groups[g].label} (${this.groups[g].count})`;
      if (el.textContent !== text) el.textContent = text;
      const rise = this.clusterRadius(g) * 1.2 + 8;
      el.style.opacity = String(Math.min(1, (1 - this.exp[g]) * 1.4));
      el.style.transform = `translate(${Math.round((v.x * 0.5 + 0.5) * w)}px, ${Math.round((-v.y * 0.5 + 0.5) * h - rise)}px) translate(-50%, -100%)`;
      el.toggleClass("cg-hidden", false);
      shownClusters++;
    }
    for (let k = shownClusters; k < this.clusterLabels.length; k++) this.clusterLabels[k].toggleClass("cg-hidden", true);
  }
}
