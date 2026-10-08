import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { Simulation } from "./sim";
import type { GraphData, GraphRenderer, RendererCallbacks, SimNode } from "./types";
import { ConstellationSettings, effectiveAutoRotate, effectiveHighContrast, effectiveMotion } from "./settings";

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

function baseRadius(deg: number): number {
  return Math.min(5.5, 0.9 + Math.sqrt(deg) * 0.5);
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
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
  private renderPass: RenderPass;
  private bloom: UnrealBloomPass;
  private canvas: HTMLCanvasElement;
  private labelLayer: HTMLDivElement;
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
  private down = { x: 0, y: 0 };
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

    this.flashEl = document.createElement("div");
    this.flashEl.className = "cg-flash";
    this.flashEl.setAttribute("aria-hidden", "true");
    container.appendChild(this.flashEl);

    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "cg-labels";
    this.labelLayer.setAttribute("aria-hidden", "true");
    container.appendChild(this.labelLayer);

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

    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("pointerdown", this.onPointerDown, true); // capture: claim a drag before the orbit controls do
    this.canvas.addEventListener("pointercancel", this.onPointerCancel);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("dblclick", this.onDblClick);
    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.io = new IntersectionObserver(es => { this.visible = es[es.length - 1].isIntersecting; this.stale = true; });
    this.io.observe(container);
    this.resize();
    this.applySettings(settings);
    this.raf = requestAnimationFrame(this.frame);
  }

  // ----------------------------------------------------------------- public API

  get nodes(): SimNode[] { return this.sim.nodes; }
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
    this.dirty = true; this.stale = true;
  }

  /** The camera drifts only when nothing needs a steady target: not while you hover, select, drag or have just let go. */
  private updateRotate(): void {
    this.controls.autoRotate = effectiveAutoRotate(this.settings) && !this.paused && this.selected < 0 && this.hover < 0
      && !this.userActive && !this.drag && performance.now() >= this.rotateBlockedUntil;
  }

  setPaused(p: boolean): void { this.paused = p; this.updateRotate(); }

  setHover(i: number): void { if (i !== this.hover) { this.hover = i; this.dirty = true; this.updateRotate(); this.cb.onHover(i); } }
  setSelected(i: number, fly = true): void {
    this.selected = i; this.follow = i; this.dirty = true; this.stale = true;
    this.updateRotate();
    if (i >= 0 && fly) this.flyTo(i);
  }
  setActive(i: number): void { if (i !== this.active) { this.active = i; this.dirty = true; } }
  setSearch(matches: Set<number> | null): void { this.search = matches; this.dirty = true; }
  setHidden(groupIndex: number, hide: boolean): void { hide ? this.hidden.add(groupIndex) : this.hidden.delete(groupIndex); this.dirty = true; }
  isHidden(groupIndex: number): boolean { return this.hidden.has(groupIndex); }

  flyTo(i: number): void {
    const n = this.sim.nodes[i]; if (!n) return;
    const dir = this.tmp.copy(this.camera.position).sub(this.controls.target);
    if (dir.lengthSq() < 1) dir.set(0.3, 0.2, 1);
    dir.normalize();
    const to = new THREE.Vector3(n.x, n.y, n.z);
    this.startTween(to.clone().addScaledVector(dir, 85 + baseRadius(n.deg) * 6), to, 1300);
  }

  resetView(): void {
    this.follow = -1; this.autoFrame = true;
    const b = this.sim.bounds();
    const dir = this.tmp.copy(this.camera.position).sub(this.controls.target);
    if (dir.lengthSq() < 1) dir.set(0.4, 0.25, 1);
    dir.normalize();
    // fit the narrower of the vertical and horizontal fields of view, so tall, thin panes still frame everything
    const v = (FOV * Math.PI) / 360, h = Math.atan(Math.tan(v) * this.camera.aspect);
    const dist = this.fitDistance(b.radius);
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
    this.uniforms.uPulse.value = 1; this.uniforms.uNova.value = 0; this.flashEl.style.opacity = "0";
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
    return (radius / Math.sin(Math.min(v, h))) * 1.02;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.resumeTimer);
    this.ro.disconnect(); this.io.disconnect();
    this.controls.removeEventListener("start", this.onControlStart);
    this.controls.removeEventListener("end", this.onControlEnd);
    this.controls.dispose();
    for (const [ev, fn] of [
      ["pointermove", this.onPointerMove], ["pointerleave", this.onPointerLeave], ["pointercancel", this.onPointerCancel],
      ["pointerup", this.onPointerUp], ["dblclick", this.onDblClick],
      ["webglcontextlost", this.onContextLost], ["webglcontextrestored", this.onContextRestored],
    ] as [string, EventListener][]) this.canvas.removeEventListener(ev, fn);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown, true);
    this.disposeNodes();
    this.stars.geometry.dispose(); (this.stars.material as THREE.Material).dispose();
    // EffectComposer.dispose() does not free its passes, and browsers cap live WebGL contexts
    this.bloom.dispose(); this.renderPass.dispose(); this.composer.dispose();
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
    for (const o of [this.nodePoints, this.lines]) {
      if (!o) continue;
      this.scene.remove(o); o.geometry.dispose(); (o.material as THREE.Material).dispose();
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
    this.scene.add(this.nodePoints);

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
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = "100%"; this.canvas.style.height = "100%";
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h); // also resizes every pass
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.uniforms.uScale.value = (h * this.renderer.getPixelRatio()) / (2 * Math.tan((FOV * Math.PI) / 360));
    this.stale = true;
  }

  // ----------------------------------------------------------------- interaction

  private onContextLost = (e: Event) => { e.preventDefault(); this.contextLost = true; };
  private onContextRestored = () => { this.contextLost = false; this.stale = true; this.resize(); };

  private onControlStart = () => { clearTimeout(this.resumeTimer); this.controls.autoRotate = false; this.tween = null; this.autoFrame = false; this.userActive = true; this.updateRotate(); };
  private onControlEnd = () => {
    this.userActive = false;
    clearTimeout(this.resumeTimer);
    this.rotateBlockedUntil = performance.now() + 3500;
    this.resumeTimer = window.setTimeout(() => this.updateRotate(), 3550);
    this.updateRotate();
  };

  private setPointer(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.x = e.clientX - r.left; this.pointer.y = e.clientY - r.top; this.pointer.inside = true;
  }
  private onPointerMove = (e: PointerEvent) => {
    this.setPointer(e); this.pointer.moved = true;
    if (this.drag) this.dragMove(e);
  };
  private onPointerLeave = () => { this.pointer.inside = false; this.pointer.moved = true; };
  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.down.x = e.clientX; this.down.y = e.clientY;
    this.setPointer(e); this.setHover(this.pick()); // touch taps never fire a move first
    if (this.hover >= 0) this.dragStart(e, this.hover);
  };
  private onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const wasDrag = this.drag?.moved ?? false;
    if (this.drag) this.dragEnd();
    if (wasDrag || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) return; // it was a drag, not a click
    this.setPointer(e); this.setHover(this.pick()); // the node may have drifted since the last move
    if (this.hover >= 0) {
      if (e.ctrlKey || e.metaKey) this.cb.onOpen(this.hover, true);
      else { this.setSelected(this.hover); this.cb.onSelect(this.hover); }
    } else if (this.selected >= 0) { this.setSelected(-1); this.cb.onSelect(-1); }
  };
  private onPointerCancel = () => { if (this.drag) this.dragEnd(); };

  /** Grab a note: the orbit controls stand down, and the note follows the pointer on a plane facing the camera. */
  private dragStart(e: PointerEvent, i: number): void {
    const n = this.sim.nodes[i]; if (!n || this.nova) return;
    const normal = this.camera.getWorldDirection(this.tmp2.set(0, 0, 0)).clone();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(n.x, n.y, n.z));
    this.drag = { i, plane, offset: new THREE.Vector3(), moved: false, pointerId: e.pointerId };
    this.controls.enabled = false; // OrbitControls checks this before it starts a gesture
    const at = this.pointerOnPlane(e, plane);
    if (at) this.drag.offset.set(n.x - at.x, n.y - at.y, n.z - at.z); // so the note does not jump to the cursor
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    this.userActive = true; this.autoFrame = false;
    clearTimeout(this.resumeTimer); this.controls.autoRotate = false; this.tween = null;
    this.sim.beginDrag(i);
    this.canvas.style.cursor = "grabbing";
  }

  private dragMove(e: PointerEvent): void {
    const d = this.drag; if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 4) return; // still a click
    d.moved = true;
    const at = this.pointerOnPlane(e, d.plane); if (!at) return;
    this.sim.dragTo(at.x + d.offset.x, at.y + d.offset.y, at.z + d.offset.z);
    this.stale = true;
  }

  private dragEnd(): void {
    const d = this.drag; if (!d) return;
    this.drag = null;
    this.controls.enabled = true;
    try { this.canvas.releasePointerCapture(d.pointerId); } catch { /* already released */ }
    this.sim.endDrag(this.still); // with reduced motion the notes return at once instead of bouncing
    this.userActive = false; this.stale = true;
    this.canvas.style.cursor = this.hover >= 0 ? "pointer" : "grab";
    this.onControlEnd();
  }

  private pointerOnPlane(e: PointerEvent, plane: THREE.Plane): THREE.Vector3 | null {
    const r = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    return this.ray.ray.intersectPlane(plane, this.hit) ? this.hit : null;
  }
  private onDblClick = () => { if (this.hover >= 0) this.cb.onOpen(this.hover, false); };

  private pick(): number {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, dpr = this.renderer.getPixelRatio();
    const v = this.tmp, nodes = this.sim.nodes;
    let best = -1, bestScore = 1e9;
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i];
      if (this.hidden.has(p.gi) || this.alpha[i] < 0.3) continue;
      v.set(p.x, p.y, p.z).project(this.camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - this.pointer.x, sy - this.pointer.y);
      if (d > 60) continue;
      const dist = this.camera.position.distanceTo(this.tmp2.set(p.x, p.y, p.z)) || 1;
      const sprite = Math.min(190, Math.max(7, (this.size[i] * this.uniforms.uScale.value) / dist)) / dpr; // CSS pixels
      const reach = Math.max(10, sprite * CORE * 0.5 + 6);
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
    this.raf = requestAnimationFrame(this.frame);
    if (!this.visible || document.hidden || this.contextLost) { this.last = now; return; }
    const dt = Math.min(0.1, (now - this.last) / 1000 || 0.016);
    this.last = now; this.age += dt; this.frameNo++;
    if (!this.nodePoints) return;

    let moving = false;
    if (!this.paused) { this.sim.step(dt); moving = this.sim.isActive(); }
    if (!this.drag && (this.pointer.moved || (this.pointer.inside && moving && this.frameNo % 8 === 0))) {
      this.pointer.moved = false;
      this.setHover(this.pointer.inside ? this.pick() : -1);
      this.canvas.style.cursor = this.hover >= 0 ? "pointer" : "grab";
    }
    this.updateShows(dt);
    if (this.dirty) this.recomputeTargets();

    const animating = this.updateBuffers(dt, moving || this.stale);
    this.updateCamera(now);
    const camMoved = this.controls.update(dt);
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
        this.flashEl.style.opacity = "0";
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
      this.uniforms.uNova.value = 0; this.uniforms.uPulse.value = 1; this.novaBloom = 0; this.flashEl.style.opacity = "0";
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
        if (primary >= 0 && !lit.has(i)) a *= 0.13;
        if (this.search && !this.search.has(i)) a *= 0.14;
      }
      this.tAlpha[i] = a;
      let s = this.baseSize[i], e = 0;
      if (i === primary) { s *= 1.5; e = 0.9; }
      else if (primary >= 0 && lit.has(i)) s *= 1.12;
      if (i === this.selected) e = 1;
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

  private updateLabels(): void {
    const s = this.settings, nodes = this.sim.nodes, hc = effectiveHighContrast(s);
    if (this.nova && this.nova.stage !== "trace") { for (const l of this.labels) l.style.display = "none"; return; }
    const want: number[] = [];
    const seen = new Set<number>();
    const add = (i: number) => { if (i >= 0 && !seen.has(i) && !this.hidden.has(nodes[i].gi)) { seen.add(i); want.push(i); } };
    if (this.reveal) for (let k = this.reveal.count - 1; k >= Math.max(0, this.reveal.count - 3); k--) add(this.reveal.order[k]); // the newest arrivals
    add(this.hover); add(this.selected); add(this.active);
    const primary = this.hover >= 0 ? this.hover : this.selected;
    if (primary >= 0) {
      let top = this.adj[primary].slice();
      if (top.length > 8) top = top.sort((a, b) => nodes[b].deg - nodes[a].deg).slice(0, 8);
      top.forEach(add);
    }
    if (this.search) { let c = 0; for (const i of this.search) { add(i); if (++c > 14) break; } }
    else if (primary < 0) for (let k = 0; k < this.labelPriority.length && want.length < s.labelCount + 3; k++) add(this.labelPriority[k]);

    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, v = this.tmp, placed = this.placed;
    placed.length = 0;
    const fs = s.labelSize, focusDist = this.camera.position.distanceTo(this.controls.target) || 1;
    let used = 0;
    for (const i of want) {
      const n = nodes[i];
      v.set(n.x, n.y, n.z).project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) continue;
      const sx = (v.x * 0.5 + 0.5) * w, rise = baseRadius(n.deg) * 2.2 + 6, sy = (-v.y * 0.5 + 0.5) * h - rise;
      const lw = Math.min(260, n.name.length * fs * 0.56 + 14), lh = fs + 8;
      const x = sx - lw / 2, y = sy - lh;
      const must = i === this.hover || i === this.selected;
      if (!must && placed.some(r => x < r.x + r.w && x + lw > r.x && y < r.y + r.h && y + lh > r.y)) continue;
      placed.push({ x, y, w: lw, h: lh });
      let el = this.labels[used];
      if (!el) { el = document.createElement("div"); el.className = "cg-label"; this.labelLayer.appendChild(el); this.labels[used] = el; }
      if (el.textContent !== n.name) el.textContent = n.name;
      // fade with real distance from the camera; labels never drop below 60% and are always opaque in high contrast
      const dist = this.camera.position.distanceTo(this.tmp2.set(n.x, n.y, n.z));
      const depth = hc ? 1 : Math.max(0.6, Math.min(1, 1.25 - 0.45 * (dist / (focusDist * 1.4))));
      el.style.opacity = String(must || hc ? 1 : Math.min(1, depth * Math.min(1, this.alpha[i] * 1.3)));
      el.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px) translate(-50%, -100%)`;
      el.classList.toggle("cg-label-strong", must);
      el.style.display = "";
      used++;
    }
    for (let k = used; k < this.labels.length; k++) this.labels[k].style.display = "none";
  }
}
