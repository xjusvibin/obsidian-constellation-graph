import * as THREE from "three";
import {
  CLUSTER_HIT_SCALE, METEOR_COOLDOWN, METEOR_DAMAGE, METEOR_LIFE, METEOR_MAX_LIVE, METEOR_RADIUS, MISSILE_FUSE, MISSILE_REACH,
  MISSILE_SPEED, MISSILE_TURN, PICKUP_GRAB_RADIUS, PICKUP_RESPAWN_MS, meteorAt, meteorCount, meteorField, missileDamage,
  type BurstMsg, type Meteor, type Pickup, type PickupKind,
} from "./powerups";

/** What the power world needs from the rest of the plugin. */
export interface PowerHooks {
  selfId(): string;
  /** Where your ship is, if it is alive and flying. */
  ship(out: THREE.Vector3): boolean;
  /** Damage your own ship. True if it took the hit (it can be protected, dead or not in a fight). `by` is who to credit. */
  hitShip(damage: number, from: THREE.Vector3, by: string | null, missileId: string | null): boolean;
  /** The folded groups of your own constellation: where they are, how big, their colour and number. */
  clusters(): { x: number; y: number; z: number; r: number; color: string; g: number }[];
  breakCluster(g: number): void;
  sendBurst(b: BurstMsg): void;
  sendGrab(id: number): void;
  grabbed(kind: PickupKind): void;
  explode(x: number, y: number, z: number, size: number, color: string): void;
  sound(kind: "pickup" | "launch" | "boom" | "break"): void;
  /** Where a pilot is (you, or another pilot as drawn here), for a missile that is locked on to them. */
  pilotPosition(id: string, out: THREE.Vector3): boolean;
}

const MAX_MISSILES = 8;
const NO_CLUSTERS: ReturnType<PowerHooks["clusters"]> = [];
const LATENCY_LEAD = 0.05;
const KIND_COLOR = [0xff6a3a, 0x6ad8ff, 0x7dff9a];

interface Missile { target: string | null; id: string; owner: string; o: THREE.Vector3; d: THREE.Vector3; speed: number; travelled: number; prev: THREE.Vector3; head: THREE.Vector3 }
interface Burst { at: number; by: string | null; color: THREE.Color; meteors: Meteor[]; lastHit: Float64Array }

/**
 * Everything that floats, flies or drifts apart in the sky apart from ships and bolts: pickups, missiles and meteors.
 * Pickups, missiles and meteors are each drawn as one instanced mesh, and there is a hard cap on live meteors and missiles,
 * so the cost stays small however busy it gets. None of it touches a note: meteors are only pictures of a broken group.
 */
export class PowerWorld {
  private pickups: Pickup[] = [];
  private takenUntil: number[] = [];
  private pickupMesh: THREE.InstancedMesh;
  private missileMesh: THREE.InstancedMesh;
  private meteorMesh: THREE.InstancedMesh;
  private missiles: Missile[] = [];
  private bursts: Burst[] = [];
  private combat = false;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();
  private pos = { x: 0, y: 0, z: 0 };
  private tgt = new THREE.Vector3();
  private want = new THREE.Vector3();
  private owned: { dispose(): void }[] = [];

  constructor(private scene: THREE.Scene, private hooks: PowerHooks) {
    const mat = (opacity: number) => { const m = new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, depthTest: false }); this.owned.push(m); return m; };
    const geo = <T extends THREE.BufferGeometry>(g: T) => { this.owned.push(g); return g; };
    this.pickupMesh = new THREE.InstancedMesh(geo(new THREE.OctahedronGeometry(1, 0)), mat(0.95), 8);
    this.missileMesh = new THREE.InstancedMesh(geo(new THREE.OctahedronGeometry(1, 0)), mat(1), MAX_MISSILES);
    this.meteorMesh = new THREE.InstancedMesh(geo(new THREE.IcosahedronGeometry(1, 0)), mat(0.95), METEOR_MAX_LIVE);
    for (const [mesh, order] of [[this.pickupMesh, 5], [this.missileMesh, 5], [this.meteorMesh, 5]] as [THREE.InstancedMesh, number][]) {
      mesh.frustumCulled = false; mesh.renderOrder = order; mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(mesh);
    }
  }

  /** In a room damage is real; on your own, meteors and missiles are only a show. */
  setCombat(on: boolean): void { this.combat = on; }

  setVisible(on: boolean): void { this.pickupMesh.visible = this.missileMesh.visible = this.meteorMesh.visible = on; }

  setLayout(pickups: Pickup[]): void {
    this.pickups = pickups; this.takenUntil = pickups.map(() => 0);
    this.pickupMesh.count = pickups.length;
    pickups.forEach((p, i) => this.pickupMesh.setColorAt(i, this.c.setHex(KIND_COLOR[p.kind])));
    if (this.pickupMesh.instanceColor) this.pickupMesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    this.pickups = []; this.takenUntil = []; this.missiles.length = 0; this.bursts.length = 0;
    this.pickupMesh.count = 0; this.missileMesh.count = 0; this.meteorMesh.count = 0;
  }

  /** Someone else took this pickup. */
  remoteGrab(id: number, now: number): void { if (this.pickups[id]) this.takenUntil[id] = now + PICKUP_RESPAWN_MS; }

  /** A missile leaves a ship (yours or another pilot's). `speed` is the ship's own speed, which the missile keeps. */
  launch(id: string, owner: string, o: THREE.Vector3, d: THREE.Vector3, speed: number, remote = false, target: string | null = null): void {
    if (this.missiles.length >= MAX_MISSILES) this.missiles.shift();
    if (remote) o = o.clone().addScaledVector(d.clone().normalize(), speed * LATENCY_LEAD); // a shot is news by the time it arrives
    const dir = d.clone().normalize();
    this.missiles.push({ target, id, owner, o: o.clone(), d: dir, speed, travelled: 0, prev: o.clone(), head: o.clone() });
    this.hooks.sound("launch");
  }

  /** One of your missiles hit another pilot (they told you so): it goes off there. */
  detonate(id: string): void {
    const i = this.missiles.findIndex(m => m.id === id); if (i < 0) return;
    const m = this.missiles[i]; this.missiles.splice(i, 1);
    this.hooks.explode(m.head.x, m.head.y, m.head.z, 9, "#ff9a5a");
  }

  /** A group was broken: its meteors fly out. They are the same on every computer, from the seed. */
  addBurst(b: BurstMsg, now: number): void {
    const meteors = meteorField(b.seed, b.c, b.r, meteorCount(b.r));
    this.bursts.push({ at: now, by: b.by, color: new THREE.Color(b.col).lerp(new THREE.Color(0xffffff), 0.25), meteors, lastHit: new Float64Array(meteors.length) });
    let live = this.bursts.reduce((n, x) => n + x.meteors.length, 0);
    while (live > METEOR_MAX_LIVE && this.bursts.length > 1) live -= this.bursts.shift()!.meteors.length; // the oldest go first
    this.hooks.explode(b.c[0], b.c[1], b.c[2], Math.max(10, b.r * 2), b.col);
    this.hooks.sound("break");
  }

  update(dt: number, now: number): void {
    const alive = this.hooks.ship(this.v3), self = this.hooks.selfId();
    this.stepPickups(now, alive);
    this.stepMissiles(dt, alive, self);
    this.stepMeteors(now, alive, self);
  }

  // ----------------------------------------------------------------- pickups

  private stepPickups(now: number, alive: boolean): void {
    const t = now / 1000;
    for (let i = 0; i < this.pickups.length; i++) {
      const p = this.pickups[i], taken = now < this.takenUntil[i];
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), t * 1.1 + i);
      this.q2.setFromAxisAngle(this.v.set(1, 0, 0), 0.4);
      this.q.multiply(this.q2);
      const bob = Math.sin(t * 1.6 + i * 1.7) * 2.2, sc = taken ? 0 : 3.4;
      this.m4.compose(this.v2.set(p.x, p.y + bob, p.z), this.q, this.s.set(sc, sc, sc));
      this.pickupMesh.setMatrixAt(i, this.m4);
      if (!taken && alive && this.v3.distanceTo(this.v2) < PICKUP_GRAB_RADIUS + 3) {
        this.takenUntil[i] = now + PICKUP_RESPAWN_MS;
        this.hooks.sendGrab(p.id); this.hooks.grabbed(p.kind); this.hooks.sound("pickup");
      }
    }
    this.pickupMesh.instanceMatrix.needsUpdate = true;
  }

  // ----------------------------------------------------------------- missiles

  private stepMissiles(dt: number, alive: boolean, self: string): void {
    const clusters = this.missiles.length ? this.hooks.clusters() : NO_CLUSTERS;
    for (let k = this.missiles.length - 1; k >= 0; k--) {
      const m = this.missiles[k];
      if (m.target && this.hooks.pilotPosition(m.target, this.tgt)) { // locked on: turn toward the pilot, but only so fast, so it can be dodged
        const want = this.want.copy(this.tgt).sub(m.head), len = want.length();
        if (len > 1e-3) {
          want.divideScalar(len);
          const angle = Math.acos(Math.max(-1, Math.min(1, m.d.dot(want))));
          if (angle > 1e-4) m.d.lerp(want, Math.min(1, (MISSILE_TURN * dt) / angle)).normalize();
        }
      }
      const step = (m.speed + MISSILE_SPEED) * dt;
      m.prev.copy(m.head); m.head.addScaledVector(m.d, step); m.travelled += step;
      let done = false;
      // another pilot's missile near your ship: you decide whether it hit
      if (m.owner !== self && alive) {
        const d = this.segmentDistance(m.prev, m.head, this.v3);
        if (d <= MISSILE_FUSE) {
          if (this.combat) this.hooks.hitShip(missileDamage(d), m.head, m.owner, m.id);
          done = true;
        }
      }
      // any missile on one of your folded groups breaks it
      if (!done) for (const c of clusters) {
        const d = this.segmentDistance(m.prev, m.head, this.v2.set(c.x, c.y, c.z));
        if (d <= c.r * CLUSTER_HIT_SCALE) { this.breakGroup(c, m.owner === self ? self : m.owner); done = true; break; }
      }
      if (done || m.travelled > MISSILE_REACH) {
        this.missiles.splice(k, 1);
        this.hooks.explode(m.head.x, m.head.y, m.head.z, done ? 9 : 4, "#ff9a5a"); this.hooks.sound("boom");
      }
    }
    this.missileMesh.count = this.missiles.length;
    this.missiles.forEach((m, i) => {
      this.q.setFromUnitVectors(this.v.set(0, 0, 1), m.d);
      this.m4.compose(m.head, this.q, this.s.set(0.7, 0.7, 2.6));
      this.missileMesh.setMatrixAt(i, this.m4);
      this.missileMesh.setColorAt(i, this.c.setHex(0xffb070));
    });
    this.missileMesh.instanceMatrix.needsUpdate = true;
    if (this.missileMesh.instanceColor) this.missileMesh.instanceColor.needsUpdate = true;
  }

  private breakGroup(c: { x: number; y: number; z: number; r: number; color: string; g: number }, by: string | null): void {
    const msg: BurstMsg = { g: c.g, seed: Math.floor(Math.random() * 0xffffffff), c: [c.x, c.y, c.z], r: Math.min(60, c.r), col: c.color, by };
    this.hooks.breakCluster(c.g);   // the group opens (the notes fly back out as they always do), and
    this.hooks.sendBurst(msg);       // everyone sees the same meteors
    this.addBurst(msg, performance.now());
  }

  /** The distance from a point to the segment a-b. */
  private segmentDistance(a: THREE.Vector3, b: THREE.Vector3, p: THREE.Vector3): number {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, len2 = abx * abx + aby * aby + abz * abz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2)) : 0;
    return Math.hypot(a.x + abx * t - p.x, a.y + aby * t - p.y, a.z + abz * t - p.z);
  }

  // ----------------------------------------------------------------- meteors

  private stepMeteors(now: number, alive: boolean, self: string): void {
    let n = 0;
    for (let b = this.bursts.length - 1; b >= 0; b--) {
      const burst = this.bursts[b], age = (now - burst.at) / 1000;
      if (age > METEOR_LIFE) { this.bursts.splice(b, 1); continue; }
      for (let i = 0; i < burst.meteors.length && n < METEOR_MAX_LIVE; i++) {
        const m = burst.meteors[i];
        meteorAt(m, age, this.pos);
        const fade = age > METEOR_LIFE - 2 ? (METEOR_LIFE - age) / 2 : 1, size = m.size * fade;
        this.q.setFromAxisAngle(this.v.set(m.dy, m.dz, m.dx).normalize(), age * (1 + i * 0.13));
        this.m4.compose(this.v2.set(this.pos.x, this.pos.y, this.pos.z), this.q, this.s.set(size, size, size));
        this.meteorMesh.setMatrixAt(n, this.m4); this.meteorMesh.setColorAt(n, burst.color);
        n++;
        // your own computer decides whether a meteor hit your ship (and not one you broke yourself)
        if (alive && this.combat && burst.by !== self && age > 0.3 && now - burst.lastHit[i] > METEOR_COOLDOWN * 1000
            && this.v3.distanceTo(this.v2) < METEOR_RADIUS + size * 0.6) {
          burst.lastHit[i] = now;
          this.hooks.hitShip(METEOR_DAMAGE, this.v2, burst.by, null);
        }
      }
    }
    this.meteorMesh.count = n;
    this.meteorMesh.instanceMatrix.needsUpdate = true;
    if (this.meteorMesh.instanceColor) this.meteorMesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.clear();
    for (const m of [this.pickupMesh, this.missileMesh, this.meteorMesh]) { this.scene.remove(m); m.dispose(); }
    this.owned.forEach(o => o.dispose());
  }
}
