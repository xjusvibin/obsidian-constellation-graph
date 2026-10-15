import * as THREE from "three";
import { buildShip, paintShip, SHIP_SCALE, type Ship } from "./ship";
import { hitRadius } from "./weapons";

/** Practice drones for flying alone: a few target ships circle your constellation; shoot them all and a faster, tougher wave follows. Nothing here touches the network. */
export interface WaveSpec { count: number; hp: number; speed: number }

/** Wave 1 is two slow drones; each wave adds one (up to eight), more hull and more speed (capped). */
export function waveSpec(wave: number): WaveSpec {
  const w = Math.max(1, Math.floor(wave));
  return { count: Math.min(8, 1 + w), hp: Math.min(120, 30 + w * 10), speed: Math.min(1.8, 0.5 + w * 0.12) };
}

/** Distance along a ray (unit direction) to the first point inside a sphere, or -1 for a miss or a sphere behind the origin. */
export function rayHit(o: readonly number[], d: readonly number[], c: readonly number[], r: number): number {
  const lx = c[0] - o[0], ly = c[1] - o[1], lz = c[2] - o[2];
  const t = lx * d[0] + ly * d[1] + lz * d[2];                // closest approach along the ray
  const d2 = lx * lx + ly * ly + lz * lz - t * t;             // squared distance of that approach from the centre
  if (d2 > r * r) return -1;
  const half = Math.sqrt(r * r - d2), t0 = t - half, t1 = t + half;
  if (t1 < 0) return -1;
  return Math.max(0, t0);
}

export interface Orbit { c: [number, number, number]; e1: [number, number, number]; e2: [number, number, number]; radius: number; phase: number; w: number; wob: number; wobPhase: number }

const hash = (n: number): number => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

/** A slow loop around the middle of the graph on a tilted plane, breathing in and out a little so a drone is never an easy straight line. */
export function makeOrbit(seed: number, centre: readonly number[], radius: number, speed: number): Orbit {
  const a = new THREE.Vector3(hash(seed) - 0.5, hash(seed + 1) - 0.5, hash(seed + 2) - 0.5);
  if (a.lengthSq() < 1e-6) a.set(0, 1, 0);
  a.normalize();
  const e1 = new THREE.Vector3(1, 0, 0); if (Math.abs(a.x) > 0.9) e1.set(0, 0, 1);
  e1.crossVectors(a, e1).normalize();
  const e2 = new THREE.Vector3().crossVectors(a, e1).normalize();
  const dir = hash(seed + 3) < 0.5 ? -1 : 1;
  return {
    c: [centre[0], centre[1], centre[2]], e1: [e1.x, e1.y, e1.z], e2: [e2.x, e2.y, e2.z],
    radius: radius * (0.8 + hash(seed + 4) * 0.5), phase: hash(seed + 5) * Math.PI * 2,
    w: dir * speed * (0.8 + hash(seed + 6) * 0.5), wob: 0.12 + hash(seed + 7) * 0.12, wobPhase: hash(seed + 8) * Math.PI * 2,
  };
}

export function orbitAt(o: Orbit, t: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const ang = o.phase + o.w * t, r = o.radius * (1 + o.wob * Math.sin(t * 0.6 + o.wobPhase)), cs = Math.cos(ang) * r, sn = Math.sin(ang) * r;
  out[0] = o.c[0] + o.e1[0] * cs + o.e2[0] * sn; out[1] = o.c[1] + o.e1[1] * cs + o.e2[1] * sn; out[2] = o.c[2] + o.e1[2] * cs + o.e2[2] * sn;
  return out;
}

interface Drone { ship: Ship; orbit: Orbit; hp: number; alive: boolean; pos: THREE.Vector3; prev: THREE.Vector3 }

export interface DroneHit { index: number; dist: number; point: THREE.Vector3 }

const SCALE = SHIP_SCALE * 4; // well larger than a pilot's ship, so a target is easy to find from across the graph
const NEXT_WAVE_MS = 2600;
const UP = new THREE.Vector3(0, 1, 0);

export class DroneField {
  private drones: Drone[] = [];
  private running = false;
  private wave = 0;
  private kills = 0;
  private t = 0;
  private nextAt = 0;
  private centre: [number, number, number] = [0, 0, 0];
  private radius = 200;
  private cruise = 30;
  private tmpM = new THREE.Matrix4();
  private tmpV = new THREE.Vector3();
  private tmpO: [number, number, number] = [0, 0, 0];

  // a soft red glow around every drone, so a target can be found from across the graph
  private haloGeo = new THREE.SphereGeometry(2.4, 12, 8);
  private haloMat = new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });

  constructor(private scene: THREE.Scene) {}

  get active(): boolean { return this.running; }
  get info(): { wave: number; alive: number; total: number; kills: number } { return { wave: this.wave, alive: this.drones.filter(d => d.alive).length, total: this.drones.length, kills: this.kills }; }

  start(centre: readonly number[], radius: number, cruise: number): void {
    this.stop();
    this.running = true; this.wave = 0; this.kills = 0; this.t = 0; this.nextAt = 0;
    this.centre = [centre[0], centre[1], centre[2]]; this.radius = Math.max(100, radius * 0.85 + 50); this.cruise = Math.max(10, cruise);
    this.spawnWave();
  }

  stop(): void {
    this.running = false;
    this.clearShips();
  }

  dispose(): void { this.stop(); this.haloGeo.dispose(); this.haloMat.dispose(); }

  private clearShips(): void {
    for (const d of this.drones) { this.scene.remove(d.ship.group); d.ship.dispose(); }
    this.drones = [];
  }

  private spawnWave(): void {
    this.wave++;
    const spec = waveSpec(this.wave);
    for (let k = 0; k < spec.count; k++) {
      const ship = buildShip("dart");
      ship.group.scale.setScalar(SCALE);
      paintShip(ship, "#ff5a5a");
      ship.lights.forEach(l => { l.visible = false; }); // the hulls glow by themselves; a light per drone would slow the scene
      const halo = new THREE.Mesh(this.haloGeo, this.haloMat); halo.renderOrder = 7; ship.group.add(halo);
      this.scene.add(ship.group);
      const orbit = makeOrbit(this.wave * 31 + k * 7, this.centre, this.radius, (spec.speed * this.cruise) / this.radius);
      const p = new THREE.Vector3(...orbitAt(orbit, this.t));
      this.drones.push({ ship, orbit, hp: spec.hp, alive: true, pos: p, prev: p.clone() });
      ship.group.position.copy(p);
    }
  }

  /** Move every drone along its loop; start the next wave a moment after the last one falls. `now` is in milliseconds. Returns true when a new wave has just begun. */
  update(dt: number, now: number): boolean {
    if (!this.running) return false;
    this.t += dt;
    let alive = 0;
    for (const d of this.drones) {
      if (!d.alive) continue;
      alive++;
      d.prev.copy(d.pos);
      d.pos.set(...orbitAt(d.orbit, this.t, this.tmpO));
      d.ship.group.position.copy(d.pos);
      if (d.pos.distanceToSquared(d.prev) > 1e-8) { this.tmpM.lookAt(d.prev, d.pos, UP); d.ship.group.quaternion.setFromRotationMatrix(this.tmpM); }
    }
    if (!alive) {
      if (!this.nextAt) this.nextAt = now + NEXT_WAVE_MS;
      else if (now >= this.nextAt) { this.nextAt = 0; this.clearShips(); this.spawnWave(); return true; }
    }
    return false;
  }

  /** The nearest drone a bolt from `from` along the unit direction `dir` would hit within `reach`, if any. */
  trace(from: THREE.Vector3, dir: THREE.Vector3, reach: number): DroneHit | null {
    let best: DroneHit | null = null;
    const speed = this.cruise * waveSpec(this.wave).speed;
    this.drones.forEach((d, index) => {
      if (!d.alive) return;
      const r = hitRadius(from.distanceTo(d.pos), speed) * 1.6; // generous: these are practice targets
      const hit = rayHit([from.x, from.y, from.z], [dir.x, dir.y, dir.z], [d.pos.x, d.pos.y, d.pos.z], r);
      if (hit < 0 || hit > reach) return;
      if (!best || hit < best.dist) best = { index, dist: hit, point: from.clone().addScaledVector(dir, hit) };
    });
    return best;
  }

  /** The smallest angle (radians) between a view direction and any live drone, or null when there is none. Used for the controller's aim assist. */
  angleTo(from: THREE.Vector3, dir: THREE.Vector3): number | null {
    let best: number | null = null;
    for (const d of this.drones) {
      if (!d.alive) continue;
      const toward = this.tmpV.copy(d.pos).sub(from), len = toward.length();
      if (len < 1e-6) continue;
      const a = Math.acos(Math.max(-1, Math.min(1, toward.dot(dir) / len)));
      if (best === null || a < best) best = a;
    }
    return best;
  }

  /** Damage one drone. Returns true when it is destroyed. */
  damage(index: number, amount: number): boolean {
    const d = this.drones[index]; if (!d?.alive) return false;
    d.hp -= amount;
    if (d.hp > 0) return false;
    d.alive = false; d.ship.group.visible = false; this.kills++;
    return true;
  }
}
