import { forceSimulation, forceLink, forceManyBody, type Force, type ForceLink, type ForceManyBody, type Simulation as D3Simulation } from "d3-force-3d";
import type { GraphData, SimNode } from "./types";
import type { MotionLevel } from "./settings";
import type { HoleState } from "./blackhole";

const GAIN: Record<MotionLevel, number> = { off: 0, calm: 1, lively: 2.4 };
const STEP = 1 / 60;

/** A link as d3 sees it: ids at first, replaced by the node objects once the simulation has resolved them. */
interface SimLink { source: string | SimNode; target: string | SimNode }
const INFALL = 11;   // seconds the notes are given to fall into the black hole before it lets go
const INFALL_TFF = 8.5; // the free-fall time from the edge of the graph, which sets how strong gravity is
const SETTLE_MAX = 4.6; // seconds allowed for the layout to find its new resting shape

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function fibonacci(i: number, n: number): [number, number, number] {
  const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y)), a = i * 2.399963229728653;
  return [Math.cos(a) * r, y, Math.sin(a) * r];
}

/**
 * Force layout plus a continuous, gentle flow. Every cluster swirls around its own axis,
 * clusters drift around the centre, and a slow noise field keeps neighbours sliding past
 * each other, so the layout never freezes like a normal graph.
 */
export class Simulation {
  nodes: SimNode[] = [];
  srcs: SimNode[] = [];
  dsts: SimNode[] = [];

  private sim: D3Simulation<SimNode>;
  private linkForce: ForceLink<SimNode, SimLink>;
  private charge: ForceManyBody<SimNode>;
  private level: MotionLevel | null = null;
  private hole: { rh0: number; GM: number; absorbed: Uint8Array; count: number } | null = null;
  private holeOut: HoleState = { active: false, x: 0, y: 0, z: 0, rh: 6, frac: 0, axis: [0.28, 1, 0.18] };
  private spacing = 1; // scales the repel force, the link distance and the starting spread
  private avgTick = 0;
  private frameNo = 0;
  private dragIdx = -1;
  private lastDragged = -1;
  private rebound = 0; // seconds of spring-back left after a drag is released
  private rel = new Float32Array(0); // each note's offset from its cluster centre when the drag began
  private nova: { phase: "collapse" | "settle"; t: number } | null = null;
  private gain = 1;
  private time = 0;
  private acc = 0;
  private groups = 1;
  private axes: [number, number, number][] = [[0, 1, 0]];
  private cx = new Float64Array(1);
  private cy = new Float64Array(1);
  private cz = new Float64Array(1);
  private cn = new Float64Array(1);
  private origin: [number, number, number] = [0, 0, 0]; // where this constellation's middle is (a room puts each pilot's in a different place)

  constructor() {
    this.linkForce = forceLink<SimNode, SimLink>([]).id(d => d.id).distance(26).strength(0.3);
    this.charge = forceManyBody<SimNode>().strength(-30).theta(0.9).distanceMax(340);
    const flow: Force<SimNode> = Object.assign((_alpha: number) => this.flow(), {
      initialize: () => { /* nodes are tracked by this class */ },
    });
    this.sim = forceSimulation<SimNode>([], 3)
      .stop()
      .alphaDecay(0.02)
      .velocityDecay(0.34)
      .force("link", this.linkForce)
      .force("charge", this.charge)
      .force("flow", flow);
  }

  /** Changing the glow or a label size must not jolt the layout, so only an actual change of motion level reheats it. */
  setMotion(level: MotionLevel): void {
    this.gain = GAIN[level] ?? 0;
    if (level === this.level) return;
    this.level = level;
    this.sim.alphaTarget(this.gain === 0 ? 0 : 0.03);
    if (this.gain > 0 && this.sim.alpha() < 0.2) this.sim.alpha(0.2);
  }

  /** Move the whole constellation so its middle is at (x, y, z). Everything keeps its shape; the gentle pull toward the middle follows. */
  setOrigin(x: number, y: number, z: number): void {
    const dx = x - this.origin[0], dy = y - this.origin[1], dz = z - this.origin[2];
    this.origin = [x, y, z];
    for (const n of this.nodes) {
      n.x += dx; n.y += dy; n.z += dz;
      if (n.fx != null) n.fx += dx; if (n.fy != null) n.fy += dy; if (n.fz != null) n.fz += dz;
    }
  }

  /** Spread the layout out (above 1) or pull it together (below 1). True when it changed, so the caller can rebuild the layout. */
  setSpacing(k: number): boolean {
    if (Math.abs(k - this.spacing) < 1e-3) return false;
    this.spacing = k;
    this.charge.strength(-30 * k); this.linkForce.distance(26 * k);
    return true;
  }

  /** Cheaper repulsion on big vaults: a wider Barnes-Hut opening angle and a shorter reach. */
  setScale(n: number): void {
    this.charge.theta(n > 6000 ? 1.4 : n > 2500 ? 1.15 : 0.9).distanceMax(n > 6000 ? 160 : n > 2500 ? 240 : 340);
  }

  /**
   * Grab a note. It is pinned to wherever dragTo() puts it, the layout is heated so its neighbours are tugged along
   * through their links, and every note's resting place (relative to its cluster) is remembered for the spring-back.
   */
  beginDrag(i: number): void {
    const n = this.nodes[i]; if (!n) return;
    this.measureCentres();
    this.rel = new Float32Array(this.nodes.length * 3);
    this.nodes.forEach((p, k) => {
      this.rel[k * 3] = p.x - this.cx[p.gi]; this.rel[k * 3 + 1] = p.y - this.cy[p.gi]; this.rel[k * 3 + 2] = p.z - this.cz[p.gi];
    });
    this.dragIdx = i; this.lastDragged = i; this.rebound = 0;
    this.sim.alphaTarget(0.3);
    if (this.sim.alpha() < 0.3) this.sim.alpha(0.3);
  }

  dragTo(x: number, y: number, z: number): void {
    const n = this.nodes[this.dragIdx]; if (!n) return;
    n.fx = x; n.fy = y; n.fz = z;
  }

  /** Let go. The note and everything it disturbed spring back, with a small overshoot, or snap back at once when `instant`. */
  endDrag(instant: boolean): void {
    const n = this.nodes[this.dragIdx];
    if (n) { n.fx = null; n.fy = null; n.fz = null; }
    const valid = this.rel.length === this.nodes.length * 3 && !!n;
    this.dragIdx = -1;
    this.sim.alphaTarget(this.gain === 0 ? 0 : 0.03);
    if (!valid) return;
    if (instant) {
      this.measureCentres();
      this.nodes.forEach((p, k) => {
        p.x = this.cx[p.gi] + this.rel[k * 3]; p.y = this.cy[p.gi] + this.rel[k * 3 + 1]; p.z = this.cz[p.gi] + this.rel[k * 3 + 2];
        p.vx = p.vy = p.vz = 0;
      });
      if (this.gain === 0) this.sim.alpha(0);
      return;
    }
    this.rebound = 1.8;
  }

  get dragging(): boolean { return this.dragIdx >= 0; }

  private measureCentres(): void {
    this.cx.fill(0); this.cy.fill(0); this.cz.fill(0); this.cn.fill(0);
    for (const n of this.nodes) { this.cx[n.gi] += n.x; this.cy[n.gi] += n.y; this.cz[n.gi] += n.z; this.cn[n.gi]++; }
    for (let i = 0; i < this.groups; i++) { const c = this.cn[i] || 1; this.cx[i] /= c; this.cy[i] /= c; this.cz[i] /= c; }
  }

  /**
   * Begin the black hole: a horizon forms at the middle of the graph and gravity pulls every note in. Each note starts with a
   * sideways speed around the disk's axis, so they swirl in on spirals instead of falling straight, and they are swallowed
   * when they cross the horizon (which grows as it feeds). When it has fed, it lets go in a burst and the layout re-forms.
   */
  novaStart(axisIn?: [number, number, number]): void {
    const b = this.bounds(), N = Math.max(1, this.nodes.length), R = Math.max(60, b.radius);
    const GM = (Math.PI * Math.PI / 4) * R * R * R / (2 * INFALL_TFF * INFALL_TFF); // free-fall from rest at R takes INFALL_TFF seconds
    const axis = this.holeOut.axis; if (axisIn) { axis[0] = axisIn[0]; axis[1] = axisIn[1]; axis[2] = axisIn[2]; }
    const al = Math.hypot(axis[0], axis[1], axis[2]); axis[0] /= al; axis[1] /= al; axis[2] /= al;
    const rh0 = 0.05 * R + 3;
    this.hole = { rh0, GM, absorbed: new Uint8Array(N), count: 0 };
    const h = this.holeOut; h.active = true; h.x = b.cx; h.y = b.cy; h.z = b.cz; h.rh = rh0; h.frac = 0;
    this.nodes.forEach((n, i) => {
      const dx = n.x - b.cx, dy = n.y - b.cy, dz = n.z - b.cz, r = Math.max(1, Math.hypot(dx, dy, dz));
      let tx = axis[1] * dz - axis[2] * dy, ty = axis[2] * dx - axis[0] * dz, tz = axis[0] * dy - axis[1] * dx; // around the axis
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      const v = Math.sqrt(GM / Math.max(r, rh0)) * (0.3 + 0.35 * hash(i + 41)) * STEP; // below circular speed: they spiral in
      n.vx = tx * v; n.vy = ty * v; n.vz = tz * v;
    });
    this.nova = { phase: "collapse", t: 0 };
    this.charge.strength(0); this.linkForce.strength(0); // nothing but gravity matters while they fall (repulsion between notes crowded at the middle would fling them out)
    this.sim.velocityDecay(0.004);
    this.sim.alphaTarget(0.35);
    this.sim.alpha(0.5);
  }

  /** What the picture needs: where the hole is, how big it has grown and how much of the graph it has eaten. */
  holeState(): HoleState { return this.holeOut; }

  /** Which notes have been swallowed (so they are not drawn), or null when there is no hole. */
  get swallowed(): Uint8Array | null { return this.hole ? this.hole.absorbed : null; }

  /** "collapse" -> "settle" (just blasted) -> "idle" once the layout has found its new shape. */
  get novaPhase(): "idle" | "collapse" | "settle" { return this.nova ? this.nova.phase : "idle"; }

  novaCancel(): void {
    if (!this.nova) return;
    this.nova = null; this.hole = null; this.holeOut.active = false;
    this.sim.velocityDecay(0.34); this.linkForce.strength(0.3);
    this.charge.strength(-30 * this.spacing);
    this.sim.alphaTarget(this.gain === 0 ? 0 : 0.03);
  }

  /** With motion off: skip the show and just re-run the layout from a compressed start, instantly. */
  relayout(): void {
    this.novaCancel();
    this.measureCentres();
    let sx = 0, sy = 0, sz = 0;
    for (const n of this.nodes) { sx += n.x; sy += n.y; sz += n.z; }
    const N = Math.max(1, this.nodes.length), cx = sx / N, cy = sy / N, cz = sz / N;
    this.nodes.forEach((n, i) => {
      n.x = cx + (hash(i + 3) - 0.5) * 20; n.y = cy + (hash(i + 5) - 0.5) * 20; n.z = cz + (hash(i + 8) - 0.5) * 20;
      n.vx = n.vy = n.vz = 0;
    });
    this.sim.alpha(1);
    this.settle(this.nodes.length > 4000 ? 140 : 360);
  }

  /** True while the layout is still moving; when it is not, the caller can skip all per-frame work. */
  isActive(): boolean {
    return this.gain > 0 || this.sim.alpha() > this.sim.alphaMin();
  }

  /** Run the layout to rest immediately (used when motion is off, so nothing visibly flies around). */
  settle(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.sim.tick(1);
    this.sim.alpha(0);
  }

  setData(data: GraphData): void {
    const old = new Map(this.nodes.map(n => [n.id, n]));
    const gIndex = new Map(data.groups.map((g, i) => [g.key, i]));
    this.groups = Math.max(1, data.groups.length);
    const N = Math.max(1, data.nodes.length);
    const R = 26 * Math.cbrt(N) * this.spacing;
    const spread = (9 + 3.2 * Math.cbrt(N / this.groups)) * this.spacing;

    this.axes = [];
    for (let g = 0; g < this.groups; g++) {
      const [x, y, z] = fibonacci((g * 5 + 2) % Math.max(1, this.groups * 3), this.groups * 3);
      const sign = g % 2 ? -1 : 1;
      this.axes.push([x * sign, y * sign, z * sign]);
    }
    this.cx = new Float64Array(this.groups); this.cy = new Float64Array(this.groups);
    this.cz = new Float64Array(this.groups); this.cn = new Float64Array(this.groups);

    const adj = new Map<string, string[]>();
    for (const l of data.links) {
      (adj.get(l.source) ?? adj.set(l.source, []).get(l.source)!).push(l.target);
      (adj.get(l.target) ?? adj.set(l.target, []).get(l.target)!).push(l.source);
    }

    const next: SimNode[] = data.nodes.map((r, index) => {
      const gi = gIndex.get(r.group) ?? this.groups - 1;
      const existing = old.get(r.id);
      if (existing) { Object.assign(existing, { name: r.name, group: r.group, deg: r.deg, gi, index }); return existing; }
      let px = 0, py = 0, pz = 0, found = 0;
      for (const nb of adj.get(r.id) ?? []) {
        const o = old.get(nb);
        if (o) { px += o.x; py += o.y; pz += o.z; found++; }
      }
      const h = index + 1;
      let x: number, y: number, z: number;
      if (found) {
        x = px / found + (hash(h) - 0.5) * 8; y = py / found + (hash(h + 9) - 0.5) * 8; z = pz / found + (hash(h + 19) - 0.5) * 8;
      } else {
        const [fx, fy, fz] = fibonacci(gi, this.groups);
        x = this.origin[0] + fx * R + (hash(h) - 0.5) * 2 * spread; y = this.origin[1] + fy * R + (hash(h + 9) - 0.5) * 2 * spread; z = this.origin[2] + fz * R + (hash(h + 19) - 0.5) * 2 * spread;
      }
      return { ...r, index, gi, x, y, z, vx: 0, vy: 0, vz: 0, phase: hash(h + 33) * 6.283, speed: 0.7 + hash(h + 51) * 0.6 };
    });

    this.linkForce.links([]);
    this.nodes = next;
    this.sim.nodes(next);
    const links: SimLink[] = data.links.map(l => ({ source: l.source, target: l.target }));
    this.linkForce.links(links);
    this.srcs = links.map(l => l.source as SimNode);
    this.dsts = links.map(l => l.target as SimNode);
    this.sim.alpha(Math.max(this.sim.alpha(), old.size ? 0.35 : 1));
  }

  /** Advance the layout by real time, in fixed 60 Hz steps so speed does not depend on refresh rate. */
  step(dt: number): void {
    if (!this.isActive()) { this.acc = 0; return; }
    this.frameNo++;
    // if a tick is expensive (huge vault, slow machine), run the layout at half rate instead of dropping frames
    if (this.avgTick > 10 && this.frameNo % 2) return;
    this.acc += Math.min(dt, 0.1);
    let n = 0;
    const budget = this.avgTick > 6 ? 1 : 3;
    while (this.acc >= STEP && n < budget) {
      const t0 = performance.now();
      this.time += STEP;
      this.sim.tick(1);
      this.acc -= STEP;
      this.avgTick = this.avgTick * 0.9 + (performance.now() - t0) * 0.1;
      n++;
    }
    if (n === budget) this.acc = 0;
  }

  /** Centre and radius that contain ~97% of the nodes, for framing the camera. */
  bounds(): { cx: number; cy: number; cz: number; radius: number } {
    const n = this.nodes.length;
    if (!n) return { cx: 0, cy: 0, cz: 0, radius: 100 };
    let sx = 0, sy = 0, sz = 0;
    for (const p of this.nodes) { sx += p.x; sy += p.y; sz += p.z; }
    const cx = sx / n, cy = sy / n, cz = sz / n;
    const d = this.nodes.map(p => Math.hypot(p.x - cx, p.y - cy, p.z - cz)).sort((a, b) => a - b);
    return { cx, cy, cz, radius: Math.max(40, d[Math.floor((n - 1) * 0.97)]) };
  }

  private flow(): void {
    const nodes = this.nodes, G = this.groups, t = this.time;
    // after the blast the flow fades back in so the layout can organise itself before the swirl resumes
    const g = this.gain * (this.nova && this.nova.phase === "settle" ? Math.min(1, this.nova.t / 3) : 1);
    this.cx.fill(0); this.cy.fill(0); this.cz.fill(0); this.cn.fill(0);
    for (const n of nodes) { this.cx[n.gi] += n.x; this.cy[n.gi] += n.y; this.cz[n.gi] += n.z; this.cn[n.gi]++; }
    for (let i = 0; i < G; i++) { const c = this.cn[i] || 1; this.cx[i] /= c; this.cy[i] /= c; this.cz[i] /= c; }

    if (this.nova && this.novaTick(nodes)) return;

    // spring-back after a drag: underdamped on purpose, so it overshoots and settles like a rubber band
    const springing = this.rebound > 0 && this.rel.length === nodes.length * 3;
    if (this.rebound > 0) this.rebound -= STEP;
    if (springing && this.rebound <= 0) { this.sim.alpha(Math.min(this.sim.alpha(), 0.05)); }

    for (const n of nodes) {
      const gi = n.gi;
      if (springing) {
        const k = n.index === this.lastDragged ? 0.22 : 0.1;
        n.vx += (this.cx[gi] + this.rel[n.index * 3] - n.x) * k;
        n.vy += (this.cy[gi] + this.rel[n.index * 3 + 1] - n.y) * k;
        n.vz += (this.cz[gi] + this.rel[n.index * 3 + 2] - n.z) * k;
      }
      // keep clusters readable and the whole thing near the origin
      n.vx += (this.cx[gi] - n.x) * 0.010 - (n.x - this.origin[0]) * 0.0007;
      n.vy += (this.cy[gi] - n.y) * 0.010 - (n.y - this.origin[1]) * 0.0007;
      n.vz += (this.cz[gi] - n.z) * 0.010 - (n.z - this.origin[2]) * 0.0007;
      if (!g) continue;

      // swirl around the cluster's own axis; inner nodes move faster than outer ones
      const dx = n.x - this.cx[gi], dy = n.y - this.cy[gi], dz = n.z - this.cz[gi];
      const r = Math.hypot(dx, dy, dz) + 1e-3, [ax, ay, az] = this.axes[gi];
      let tx = ay * dz - az * dy, ty = az * dx - ax * dz, tz = ax * dy - ay * dx;
      const tl = Math.hypot(tx, ty, tz) + 1e-3, f = (0.034 * g * n.speed) / (1 + r / 70);
      n.vx += (tx / tl) * f; n.vy += (ty / tl) * f; n.vz += (tz / tl) * f;

      // clusters circle the origin as a whole
      const ox = n.x - this.origin[0], oz = n.z - this.origin[2], rr = Math.hypot(ox, oz) + 1e-3, fo = (0.014 * g) / (1 + rr / 120);
      n.vx += (-oz / rr) * fo; n.vz += (ox / rr) * fo;

      // slow noise so neighbours slide past each other
      const dr = 0.011 * g;
      n.vx += Math.sin(n.y * 0.031 + t * 0.21 + n.phase) * dr;
      n.vy += Math.sin(n.z * 0.027 + t * 0.17 + n.phase * 1.3) * dr;
      n.vz += Math.sin(n.x * 0.029 + t * 0.19 + n.phase * 0.7) * dr;
    }
  }

  /** Returns true when it has fully handled this tick (the crush), false to let the normal forces run (the settle). */
  private novaTick(nodes: SimNode[]): boolean {
    const nv = this.nova!;
    nv.t += STEP;
    if (nv.phase === "collapse") {
      const h = this.hole!, N = Math.max(1, nodes.length), ho = this.holeOut, gm = h.GM * STEP * STEP;
      ho.frac = h.count / N; ho.rh = h.rh0 * (1 + 0.9 * Math.sqrt(ho.frac)); // it grows as it feeds
      const hx = ho.x, hy = ho.y, hz = ho.z, rh2 = ho.rh * ho.rh;
      for (const n of nodes) {
        if (h.absorbed[n.index]) { n.x = hx; n.y = hy; n.z = hz; n.vx = n.vy = n.vz = 0; continue; }
        const dx = n.x - hx, dy = n.y - hy, dz = n.z - hz, r2 = dx * dx + dy * dy + dz * dz;
        if (r2 < rh2) { h.absorbed[n.index] = 1; h.count++; n.x = hx; n.y = hy; n.z = hz; n.vx = n.vy = n.vz = 0; continue; } // past the horizon
        const r = Math.sqrt(r2) || 1, a = gm / (r2 + 25);                                                                 // gravity, softened near the middle
        n.vx -= (dx / r) * a; n.vy -= (dy / r) * a; n.vz -= (dz / r) * a;
        const visc = 1 - 0.25 * STEP;                                                                                       // a little accretion drag, so orbits shrink
        n.vx *= visc; n.vy *= visc; n.vz *= visc;
      }
      if (nv.t >= INFALL || h.count >= N * 0.97) this.blast(nodes, hx, hy, hz);
      return true;
    }
    // settle: done when the layout has calmed down, or after the time limit
    if (nv.t > SETTLE_MAX || (nv.t > 2.2 && this.sim.alpha() < 0.07)) this.novaCancel();
    return false;
  }

  /** The explosion: every note is thrown outward along its own direction, with a sideways twist so it spirals. */
  private blast(nodes: SimNode[], cx: number, cy: number, cz: number): void {
    this.hole = null; this.holeOut.active = false;
    this.sim.velocityDecay(0.34); this.linkForce.strength(0.3);
    this.charge.strength(-30 * this.spacing);
    nodes.forEach((n, i) => {
      let dx = n.x - cx, dy = n.y - cy, dz = n.z - cz, r = Math.hypot(dx, dy, dz);
      if (r < 1e-3) { dx = hash(i + 11) - 0.5; dy = hash(i + 17) - 0.5; dz = hash(i + 23) - 0.5; r = Math.hypot(dx, dy, dz) || 1; }
      dx /= r; dy /= r; dz /= r;
      const speed = 30 + hash(i + 29) * 24, [ax, ay, az] = this.axes[n.gi];
      const sx = ay * dz - az * dy, sy = az * dx - ax * dz, sz = ax * dy - ay * dx; // sideways, around the cluster axis
      n.vx = dx * speed + sx * speed * 0.4; n.vy = dy * speed + sy * speed * 0.4; n.vz = dz * speed + sz * speed * 0.4;
    });
    this.sim.alpha(1);
    this.sim.alphaTarget(0.02);
    this.nova = { phase: "settle", t: 0 };
  }}
