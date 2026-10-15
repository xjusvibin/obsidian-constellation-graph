import * as THREE from "three";
import type { AnonymousTopology, HitMsg, Pose, ShotMsg } from "./multiplayer";
import { buildShip, shipFromIndex, shipIndex, SHIP_SCALE, type Ship } from "./ship";
import { BOLT_REACH, SHIELD_MAX, weaponStats } from "./weapons";

/**
 * Where each pilot's constellation sits in the shared space. The first three form a triangle 1,500 units on a side, which is
 * about fifteen seconds at cruise speed and four on afterburner: close enough that you can see the next constellation glowing
 * from yours, far enough that two ordinary vaults never touch. The fourth sits across the gap from the first.
 */
export const WORLD_ORIGINS: [number, number, number][] = [[0, 0, 0], [1500, 0, 0], [-750, 0, 1299], [-750, 0, -1299]];
/** The colour of each pilot's ship, by place in the room. Your own ship is always cyan. */
export const SLOT_COLORS = ["#ffb347", "#c792ff", "#7dff9a", "#ff7a9a"];

const CORE = 0.34;           // as in the renderer: the solid part of a note sprite
const REMOTE_STARS = 1.15;    // other constellations are drawn with slightly larger, brighter stars, so they read from across the gap
const PIP_FROM = 45;         // beyond this distance a ship also gets a ring that stays the same size on screen, so it is never lost
const LATENCY_LEAD = 0.05;   // a shot is news by the time it arrives: the copy starts this many seconds along its way
const MAX_BOLTS = 48;
const MAX_BURSTS = 6;
const POSE_STALE_MS = 2500;  // a pilot we have not heard from for this long is hidden
const EDGE_MARGIN = 38;      // how far in from the edge of the view an off-screen pilot's marker sits

interface RemoteMap { points: THREE.Points; lines: THREE.LineSegments; ends: Int32Array; pos: Float32Array; ready: boolean }
interface Plate { shield: HTMLDivElement; lastSd: number; pip: HTMLDivElement; root: HTMLDivElement; name: HTMLDivElement; fill: HTMLDivElement; dist: HTMLDivElement; arrow: HTMLDivElement; lastDist: string; lastHp: number; edge: boolean }
interface RemoteShip { ship: Ship; plate: Plate; name: string; slot: number; color: string; pose: Pose | null; at: number; target: THREE.Vector3; shown: boolean; dead: boolean; scale: number }
interface RemoteBolt { owner: string; id: string; kind: 0 | 1; speed: number; o: THREE.Vector3; d: THREE.Vector3; travelled: number; head: THREE.Vector3; prev: THREE.Vector3 }
interface Burst { line: THREE.LineSegments; age: number; size: number; live: boolean }

/** Another pilot as a target: where their ship is drawn and how fast it is moving (for the lead pip). */
export interface RemoteTarget { id: string; x: number; y: number; z: number; vx: number; vy: number; vz: number; dist: number }

export interface RemoteHooks {
  /** Does this segment of a bolt's flight hit your own ship? (It also applies the damage.) */
  hitTest(a: THREE.Vector3, b: THREE.Vector3, kind: 0 | 1, travelled: number): boolean;
  /** You were hit by a bolt from this pilot. */
  struck(shooterId: string, shotId: string, at: [number, number, number]): void;
}

const fmtDist = (d: number): string => d >= 1000 ? `${(d / 1000).toFixed(1)}k` : String(Math.round(d / 10) * 10);

/**
 * Everything of the other pilots that is drawn in your scene: their constellations (as glowing points and faint links, in
 * their own corner of the shared space), their ships, the bolts they fire, and the bursts where things are hit. All of it
 * comes from a few validated numbers; none of it can reach a note, a file or anything outside this drawing.
 */
export class RemoteWorld {
  private maps = new Map<string, RemoteMap>();
  private ships = new Map<string, RemoteShip>();
  private bolts: RemoteBolt[] = [];
  private boltLines: THREE.LineSegments;
  private boltPos = new Float32Array(MAX_BOLTS * 6);
  private boltCol = new Float32Array(MAX_BOLTS * 6);
  private bursts: Burst[] = [];
  private burstGeo: THREE.BufferGeometry;
  private tmp = new THREE.Vector3();
  private look = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private tmpC = new THREE.Color();
  private targetList: RemoteTarget[] = [];

  constructor(
    private scene: THREE.Scene,
    private labelLayer: HTMLElement,
    private camera: THREE.PerspectiveCamera,
    private pointMaterial: () => THREE.ShaderMaterial,
    private hooks: RemoteHooks,
  ) {
    const g = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(this.boltPos, 3); pa.setUsage(THREE.DynamicDrawUsage); g.setAttribute("position", pa);
    const ca = new THREE.BufferAttribute(this.boltCol, 3); ca.setUsage(THREE.DynamicDrawUsage); g.setAttribute("color", ca);
    g.setDrawRange(0, 0);
    this.boltLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    this.boltLines.frustumCulled = false; this.boltLines.renderOrder = 5;
    scene.add(this.boltLines);
    this.burstGeo = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1, 0));
  }

  get any(): boolean { return this.maps.size > 0 || this.ships.size > 0 || this.bolts.length > 0; }

  /** The other pilots who are flying right now, as targets. The list is reused every frame; do not keep it. */
  get targets(): readonly RemoteTarget[] { return this.targetList; }

  /** The pilots you could watch, in a steady order. */
  get watchable(): string[] { return [...this.ships.entries()].filter(([, s]) => s.shown).map(([id]) => id); }

  /** Where a pilot's ship is and which way it faces, for the spectator camera. */
  followState(id: string, outPos: THREE.Vector3, outQuat: THREE.Quaternion, outVel: THREE.Vector3): { name: string; color: string; scale: number } | null {
    const s = this.ships.get(id); if (!s || !s.shown || !s.pose) return null;
    outPos.copy(s.ship.group.position); outQuat.copy(s.ship.group.quaternion); outVel.set(s.pose.v[0], s.pose.v[1], s.pose.v[2]);
    return { name: s.name, color: s.color, scale: s.scale };
  }

  // ----------------------------------------------------------------- what arrives

  setTopology(id: string, topology: AnonymousTopology, name: string, slot: number): void {
    this.removeMap(id);
    const n = topology.nodes.length, ids = new Map<string, number>();
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), alpha = new Float32Array(n).fill(0.85), emph = new Float32Array(n);
    topology.nodes.forEach((node, i) => {
      ids.set(node.id, i);
      const c = new THREE.Color(topology.groups[node.group]?.color ?? "#8b93a7");
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      size[i] = ((Math.min(5.5, 0.9 + Math.sqrt(node.degree) * 0.5) * 2) / CORE) * REMOTE_STARS;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1)); geo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1)); geo.setAttribute("aEmph", new THREE.BufferAttribute(emph, 1));
    const points = new THREE.Points(geo, this.pointMaterial());
    points.frustumCulled = false; points.renderOrder = 2; points.visible = false;
    const ends = new Int32Array(topology.links.length * 2);
    topology.links.forEach((l, k) => { ends[k * 2] = ids.get(l[0]) ?? 0; ends[k * 2 + 1] = ids.get(l[1]) ?? 0; });
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(ends.length * 3), 3));
    const lc = new Float32Array(ends.length * 3);
    for (let k = 0; k < ends.length; k++) { lc[k * 3] = col[ends[k] * 3] * 0.3; lc[k * 3 + 1] = col[ends[k] * 3 + 1] * 0.3; lc[k * 3 + 2] = col[ends[k] * 3 + 2] * 0.3; }
    lg.setAttribute("color", new THREE.BufferAttribute(lc, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    lines.frustumCulled = false; lines.renderOrder = 1; lines.visible = false;
    this.scene.add(points, lines);
    this.maps.set(id, { points, lines, ends, pos, ready: false });
    this.ensureShip(id, name, slot);
  }

  setPositions(id: string, positions: Float32Array): void {
    const m = this.maps.get(id); if (!m || positions.length !== m.pos.length) return;
    m.pos.set(positions);
    const pa = m.points.geometry.getAttribute("position") as THREE.BufferAttribute; pa.needsUpdate = true;
    const la = m.lines.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let k = 0; k < m.ends.length; k++) { const s = m.ends[k] * 3; la.array[k * 3] = m.pos[s]; la.array[k * 3 + 1] = m.pos[s + 1]; la.array[k * 3 + 2] = m.pos[s + 2]; }
    la.needsUpdate = true;
    m.ready = true; m.points.visible = true; m.lines.visible = true;
  }

  private makePlate(color: string): Plate {
    const pip = this.labelLayer.createDiv({ cls: "cg-pip" });
    pip.style.setProperty("--plate", color); pip.toggleClass("cg-hidden", true);
    const root = this.labelLayer.createDiv({ cls: "cg-plate" });
    root.style.setProperty("--plate", color);
    const arrow = root.createDiv({ cls: "cg-plate-arrow" });
    const name = root.createDiv({ cls: "cg-plate-name" });
    const shield = root.createDiv({ cls: "cg-plate-shieldbar" }).createDiv({ cls: "cg-plate-shieldfill" });
    const bar = root.createDiv({ cls: "cg-plate-bar" });
    const fill = bar.createDiv({ cls: "cg-plate-fill" });
    const dist = root.createDiv({ cls: "cg-plate-dist" });
    root.toggleClass("cg-hidden", true);
    return { shield, lastSd: -1, pip, root, name, fill, dist, arrow, lastDist: "", lastHp: -1, edge: false };
  }

  private newModel(kindIndex: number, color: string): Ship {
    const ship = buildShip(shipFromIndex(kindIndex));
    ship.group.scale.setScalar(SHIP_SCALE); ship.group.visible = false;
    ship.outline.color.set(color);
    this.scene.add(ship.group); ship.lights.forEach(l => { l.visible = true; this.scene.add(l); });
    return ship;
  }

  private dropModel(ship: Ship): void { this.scene.remove(ship.group); ship.lights.forEach(l => this.scene.remove(l)); ship.dispose(); }

  private ensureShip(id: string, name: string, slot: number): RemoteShip {
    let s = this.ships.get(id);
    if (s) { s.name = name; s.slot = slot; s.plate.name.textContent = name; return s; }
    const color = SLOT_COLORS[Math.max(0, Math.min(3, slot))];
    const plate = this.makePlate(color);
    plate.name.textContent = name;
    s = { ship: this.newModel(0, color), plate, name, slot, color, pose: null, at: 0, target: new THREE.Vector3(), shown: false, dead: false, scale: SHIP_SCALE };
    this.ships.set(id, s);
    return s;
  }

  setPose(id: string, pose: Pose): void {
    const s = this.ships.get(id); if (!s) return;
    const wasDead = s.dead, want = pose.sh ?? 0;
    if (shipIndex(s.ship.kind) !== want) { // they picked a different ship
      const old = s.ship; s.ship = this.newModel(want, s.color);
      s.ship.group.position.copy(old.group.position); s.ship.group.quaternion.copy(old.group.quaternion); this.dropModel(old);
    }
    s.pose = pose; s.at = performance.now(); s.dead = pose.hp <= 0;
    if (s.dead && !wasDead && s.shown) this.burst(pose.p[0], pose.p[1], pose.p[2], 14, s.color);
    if (!s.shown && pose.ac && !s.dead) { s.ship.group.position.set(...pose.p); s.ship.group.quaternion.set(...pose.q).normalize(); }
  }

  addShot(id: string, shot: ShotMsg): void {
    if (this.bolts.length >= MAX_BOLTS) this.bolts.shift();
    const o = new THREE.Vector3(...shot.o), d = new THREE.Vector3(...shot.d).normalize();
    const kind: 0 | 1 = shot.w === 1 ? 1 : 0, speed = weaponStats(kind).speed + (shot.s ?? 0); // a bolt inherits its ship's speed, as it does on the shooter's screen
    const lead = speed * LATENCY_LEAD;
    this.bolts.push({ owner: id, id: shot.id, kind, speed, o, d, travelled: lead, head: o.clone().addScaledVector(d, lead), prev: o.clone() });
  }

  /** A burst of wireframe at a point (a missile going off, a group breaking). */
  explode(x: number, y: number, z: number, size: number, color: string): void { this.burst(x, y, z, size, color); }

  showHit(hit: HitMsg): void { this.burst(hit.at[0], hit.at[1], hit.at[2], 6, "#ffb27a"); }

  remove(id: string): void {
    this.removeMap(id);
    const s = this.ships.get(id);
    if (s) { this.dropModel(s.ship); s.plate.root.remove(); s.plate.pip.remove(); this.ships.delete(id); }
    this.bolts = this.bolts.filter(b => b.owner !== id);
  }

  private removeMap(id: string): void {
    const m = this.maps.get(id); if (!m) return;
    this.scene.remove(m.points, m.lines);
    m.points.geometry.dispose(); (m.points.material as THREE.Material).dispose(); m.lines.geometry.dispose(); (m.lines.material as THREE.Material).dispose();
    this.maps.delete(id);
  }

  clear(): void {
    for (const id of [...new Set([...this.maps.keys(), ...this.ships.keys()])]) this.remove(id);
    this.bolts = []; this.targetList.length = 0;
    for (const b of this.bursts) { b.live = false; b.line.visible = false; }
  }

  // ----------------------------------------------------------------- per frame

  update(dt: number, width: number, height: number): void {
    const now = performance.now(), cam = this.camera.position;
    this.look.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let targets = 0;
    for (const [id, s] of this.ships) {
      const p = s.pose, alive = !!p && p.ac && !s.dead && now - s.at < POSE_STALE_MS;
      s.ship.group.visible = alive; s.shown = alive;
      if (!alive || !p) { s.plate.root.toggleClass("cg-hidden", true); s.plate.pip.toggleClass("cg-hidden", true); continue; }
      const age = Math.min(0.25, (now - s.at) / 1000); // ease toward where the pilot is now (their last pose, carried forward by their speed)
      s.target.set(p.p[0] + p.v[0] * age, p.p[1] + p.v[1] * age, p.p[2] + p.v[2] * age);
      const k = 1 - Math.exp(-dt * 14), g = s.ship.group;
      g.position.lerp(s.target, k);
      g.quaternion.slerp(this.q.set(...p.q).normalize(), k);
      const dist = cam.distanceTo(g.position); // the same size as your own ship, wherever they are
      g.updateMatrixWorld(true);
      const speed = Math.hypot(p.v[0], p.v[1], p.v[2]);
      const len = 0.35 + Math.min(1, speed / 350) * 2 + (p.bo ? 1.2 : 0);
      for (const f of s.ship.flames) f.scale.set(f.scale.x, len, f.scale.z);
      s.ship.outline.opacity = p.pr ? 0.35 + 0.35 * Math.sin(now * 0.02) : 0.9; // a ship that has just respawned shimmers
      this.plate(s, g.position, dist, p.hp, p.sd ?? 0, width, height);
      let t = this.targetList[targets];
      if (!t) { t = { id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, dist: 0 }; this.targetList[targets] = t; }
      t.id = id; t.x = g.position.x; t.y = g.position.y; t.z = g.position.z; t.vx = p.v[0]; t.vy = p.v[1]; t.vz = p.v[2]; t.dist = dist; targets++;
    }
    this.targetList.length = targets;
    this.stepBolts(dt);
    this.stepBursts(dt);
  }

  /** The nameplate: name, health and distance above the ship, or pinned to the edge of the view with an arrow when the pilot is off-screen. */
  private plate(s: RemoteShip, pos: THREE.Vector3, dist: number, hp: number, sd: number, w: number, h: number): void {
    const el = s.plate, cam = this.camera.position, look = this.look;
    const ahead = (pos.x - cam.x) * look.x + (pos.y - cam.y) * look.y + (pos.z - cam.z) * look.z > 1;
    this.tmp.copy(pos).project(this.camera);
    let sx = (this.tmp.x * 0.5 + 0.5) * w, sy = (-this.tmp.y * 0.5 + 0.5) * h - 26;
    const off = !ahead || this.tmp.z > 1 || sx < EDGE_MARGIN || sx > w - EDGE_MARGIN || sy < EDGE_MARGIN || sy > h - EDGE_MARGIN;
    if (off) { // the direction to them in the camera's own space, so it is right even when they are behind you
      this.tmp.copy(pos).applyMatrix4(this.camera.matrixWorldInverse);
      const dx = this.tmp.x, dy = -this.tmp.y, len = Math.hypot(dx, dy) || 1;
      const sc = Math.min((w / 2 - EDGE_MARGIN) / (Math.abs(dx / len) || 1e-6), (h / 2 - EDGE_MARGIN) / (Math.abs(dy / len) || 1e-6));
      sx = w / 2 + (dx / len) * sc; sy = h / 2 + (dy / len) * sc;
      el.arrow.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    }
    const showPip = !off && dist > PIP_FROM;
    el.pip.toggleClass("cg-hidden", !showPip);
    if (showPip) el.pip.style.transform = `translate(${Math.round((this.tmp.x * 0.5 + 0.5) * w)}px, ${Math.round((-this.tmp.y * 0.5 + 0.5) * h)}px) translate(-50%, -50%)`;
    if (off !== el.edge) { el.edge = off; el.root.classList.toggle("cg-plate-edge", off); }
    el.root.toggleClass("cg-hidden", false);
    const d = fmtDist(dist); if (d !== el.lastDist) { el.lastDist = d; el.dist.textContent = d; }
    const sdi = Math.round(sd); if (sdi !== el.lastSd) { el.lastSd = sdi; el.shield.style.width = `${Math.round((sdi / SHIELD_MAX) * 100)}%`; }
    const hpi = Math.round(hp); if (hpi !== el.lastHp) { el.lastHp = hpi; el.fill.style.width = `${hpi}%`; el.root.classList.toggle("cg-plate-low", hpi <= 30); }
    el.root.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px) translate(-50%, ${off ? "-50%" : "-100%"})`;
  }

  private stepBolts(dt: number): void {
    let out = 0;
    for (let k = this.bolts.length - 1; k >= 0; k--) {
      const b = this.bolts[k];
      const w = weaponStats(b.kind);
      b.prev.copy(b.head); b.travelled += b.speed * dt;
      b.head.copy(b.o).addScaledVector(b.d, b.travelled);
      if (b.travelled > BOLT_REACH) { this.bolts.splice(k, 1); continue; }
      if (this.hooks.hitTest(b.prev, b.head, b.kind, b.travelled)) { // it hit you
        this.hooks.struck(b.owner, b.id, [b.head.x, b.head.y, b.head.z]);
        this.burst(b.head.x, b.head.y, b.head.z, 5, "#ff8a6a");
        this.bolts.splice(k, 1); continue;
      }
      if (out >= MAX_BOLTS) continue;
      const tail = Math.max(0, b.travelled - w.length), o = out * 6;
      const c = this.tmpC.set(w.color[0], w.color[1], w.color[2]); // a blaster bolt is hot red-white, a cannon round is gold, whoever fired it
      this.boltPos[o] = b.o.x + b.d.x * tail; this.boltPos[o + 1] = b.o.y + b.d.y * tail; this.boltPos[o + 2] = b.o.z + b.d.z * tail;
      this.boltPos[o + 3] = b.head.x; this.boltPos[o + 4] = b.head.y; this.boltPos[o + 5] = b.head.z;
      this.boltCol[o] = c.r * 0.2; this.boltCol[o + 1] = c.g * 0.2; this.boltCol[o + 2] = c.b * 0.2;
      this.boltCol[o + 3] = c.r; this.boltCol[o + 4] = c.g; this.boltCol[o + 5] = c.b;
      out++;
    }
    const geo = this.boltLines.geometry;
    geo.setDrawRange(0, out * 2);
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  private burst(x: number, y: number, z: number, size: number, color: string): void {
    let b = this.bursts.find(v => !v.live);
    if (!b && this.bursts.length < MAX_BURSTS) {
      const line = new THREE.LineSegments(this.burstGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
      line.renderOrder = 4; line.frustumCulled = false; this.scene.add(line);
      b = { line, age: 0, size, live: false }; this.bursts.push(b);
    }
    if (!b) b = this.bursts[0];
    (b.line.material as THREE.LineBasicMaterial).color.set(color);
    b.age = 0; b.size = size; b.live = true; b.line.visible = true; b.line.position.set(x, y, z);
  }

  private stepBursts(dt: number): void {
    for (const b of this.bursts) {
      if (!b.live) continue;
      b.age += dt; const t = b.age / 0.45;
      if (t >= 1) { b.live = false; b.line.visible = false; continue; }
      b.line.scale.setScalar(b.size * (0.6 + 5 * (1 - Math.pow(1 - t, 3))));
      (b.line.material as THREE.LineBasicMaterial).opacity = 0.9 * (1 - t);
    }
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.boltLines); this.boltLines.geometry.dispose(); (this.boltLines.material as THREE.Material).dispose();
    for (const b of this.bursts) { this.scene.remove(b.line); (b.line.material as THREE.Material).dispose(); }
    this.burstGeo.dispose();
  }
}
