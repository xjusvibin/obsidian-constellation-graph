/**
 * Powerups, missiles and meteors: the parts that must come out the same on every computer in a room, with nothing three.js in them.
 * Pickups are laid out from a seed (the room code), so nobody has to be told where they are; a missile's flight and a meteor
 * burst are fixed by a few numbers (an origin, a direction, a seed), so every computer draws the same thing. Whether a ship was
 * hit is always decided by the pilot who owns that ship, as with bolts.
 */

export type PickupKind = 0 | 1 | 2; // missile, shield cell, overdrive
export const PICKUP_NAMES = ["Missile", "Shield cell", "Overdrive"] as const;
export const PICKUP_COUNT = 6;
export const PICKUP_RESPAWN_MS = 30_000;
export const PICKUP_GRAB_RADIUS = 7;
export const MISSILES_MAX = 2;

export const MISSILE_SPEED = 420;
export const MISSILE_REACH = 900;
export const MISSILE_FUSE = 8;        // within this distance of a ship it goes off
export const MISSILE_DAMAGE = 60;     // at the ship's middle; half of that at the edge of the fuse distance
export const CLUSTER_HIT_SCALE = 1.1; // a folded group counts a little bigger than it is drawn

export const METEOR_MAX_LIVE = 64;
export const METEOR_PER_BURST_MAX = 24;
export const METEOR_LIFE = 20;        // seconds
export const METEOR_DAMAGE = 15;
export const METEOR_RADIUS = 2.6;     // how close one must pass to a ship to hit it
export const METEOR_COOLDOWN = 1;     // seconds before the same meteor can hit the same ship again

/** A small, fast, seedable random number generator (mulberry32): the same seed always gives the same numbers. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number from a string (a room code), for seeding. */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export interface Pickup { id: number; kind: PickupKind; x: number; y: number; z: number }

/**
 * Where the pickups float. They sit on a ring around `centre`, evenly spaced with a little jitter from the seed, at varying
 * heights. At least two are missiles, and the rest are shield cells and overdrives, so every computer makes the same set.
 */
export function pickupLayout(seed: string, centre: [number, number, number], radius: number): Pickup[] {
  const r = rng(hashSeed(seed));
  const kinds: PickupKind[] = [0, 0, 1, 2, 0, 1];
  for (let i = kinds.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; } // shuffled by the seed
  const out: Pickup[] = [];
  for (let k = 0; k < PICKUP_COUNT; k++) {
    const a = ((k + (r() - 0.5) * 0.4) / PICKUP_COUNT) * Math.PI * 2, rad = radius * (0.85 + r() * 0.3);
    out.push({ id: k, kind: kinds[k], x: centre[0] + Math.cos(a) * rad, y: centre[1] + (r() - 0.5) * radius * 0.3, z: centre[2] + Math.sin(a) * rad });
  }
  return out;
}

export interface Meteor { x: number; y: number; z: number; dx: number; dy: number; dz: number; speed: number; size: number }

/** How many meteors a burst throws, from the size of the group that was broken. */
export function meteorCount(groupRadius: number): number {
  return Math.max(8, Math.min(METEOR_PER_BURST_MAX, Math.round(groupRadius * 1.6)));
}

/** The meteors of one burst: all fixed by the seed, the middle of the broken group and its size, so every computer agrees. */
export function meteorField(seed: number, centre: [number, number, number], groupRadius: number, count: number): Meteor[] {
  const r = rng(seed), out: Meteor[] = [];
  for (let i = 0; i < count; i++) {
    const u = r() * 2 - 1, t = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    const dx = Math.cos(t) * s, dy = u, dz = Math.sin(t) * s, off = groupRadius * 0.5 * r();
    out.push({ x: centre[0] + dx * off, y: centre[1] + dy * off, z: centre[2] + dz * off, dx, dy, dz, speed: 25 + r() * 70, size: 1.2 + r() * 1.8 });
  }
  return out;
}

/** Where a meteor is `t` seconds after the burst. */
export function meteorAt(m: Meteor, t: number, out: { x: number; y: number; z: number }): void {
  out.x = m.x + m.dx * m.speed * t; out.y = m.y + m.dy * m.speed * t; out.z = m.z + m.dz * m.speed * t;
}

/** Damage of a missile that goes off `dist` from a ship's middle, or 0 when it is outside the fuse distance. */
export function missileDamage(dist: number): number {
  if (dist > MISSILE_FUSE) return 0;
  return MISSILE_DAMAGE * (1 - 0.5 * (dist / MISSILE_FUSE));
}

/** What the messages about missiles, bursts and pickups may contain. Everything else is refused. */
const finite3 = (v: unknown, max: number): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= max);

export interface MissileMsg { id: string; o: [number, number, number]; d: [number, number, number]; s: number }
export function validMissile(v: unknown): v is MissileMsg {
  if (!v || typeof v !== "object") return false;
  const m = v as MissileMsg;
  return typeof m.id === "string" && m.id.length > 0 && m.id.length <= 64 && finite3(m.o, 100_000) && finite3(m.d, 1.01) && typeof m.s === "number" && Number.isFinite(m.s) && m.s >= 0 && m.s <= 20_000;
}

export interface BurstMsg { g: number; seed: number; c: [number, number, number]; r: number; col: string; by: string | null }
export function validBurst(v: unknown): v is BurstMsg {
  if (!v || typeof v !== "object") return false;
  const b = v as BurstMsg;
  return Number.isSafeInteger(b.g) && b.g >= 0 && b.g < 4096 && Number.isSafeInteger(b.seed) && b.seed >= 0 && b.seed <= 0xffffffff && finite3(b.c, 100_000)
    && typeof b.r === "number" && Number.isFinite(b.r) && b.r > 0 && b.r <= 60 && typeof b.col === "string" && /^#[0-9a-f]{6}$/i.test(b.col)
    && (b.by === null || (typeof b.by === "string" && b.by.length > 0 && b.by.length <= 64));
}

export function validGrab(v: unknown): v is number { return Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < PICKUP_COUNT; }
