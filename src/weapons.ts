/**
 * The two guns. The blaster is quick and light and runs hot: hold the trigger and it overheats, then it is off for a moment.
 * The cannon fires heavy rounds that hit three times as hard, but each ship carries a limited number of them per life
 * (they come back when you respawn). Used by your own ship and by the bolts other pilots fire, so both sides agree.
 */
export interface WeaponStats { speed: number; length: number; damage: number; color: [number, number, number] }

export const BLASTER: WeaponStats = { speed: 1500, length: 22, damage: 10, color: [1, 0.65, 0.55] };
export const CANNON: WeaponStats = { speed: 900, length: 13, damage: 30, color: [1, 0.86, 0.38] };

export function weaponStats(kind: 0 | 1): WeaponStats { return kind === 1 ? CANNON : BLASTER; }

/** Where a bolt fired now will meet a target that is moving: the point to aim at, or null if it cannot catch it. */
export function interceptPoint(
  shooter: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }, targetVel: { x: number; y: number; z: number },
  boltSpeed: number, out: { x: number; y: number; z: number; t: number },
): boolean {
  const dx = target.x - shooter.x, dy = target.y - shooter.y, dz = target.z - shooter.z;
  const a = targetVel.x * targetVel.x + targetVel.y * targetVel.y + targetVel.z * targetVel.z - boltSpeed * boltSpeed;
  const b = 2 * (dx * targetVel.x + dy * targetVel.y + dz * targetVel.z);
  const c = dx * dx + dy * dy + dz * dz;
  let t: number;
  if (Math.abs(a) < 1e-6) { if (Math.abs(b) < 1e-9) return false; t = -c / b; }
  else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return false;
    const sq = Math.sqrt(disc), t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
    t = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity);
  }
  if (!Number.isFinite(t) || t <= 0 || t > 3) return false; // nothing can be caught that is more than three seconds away
  out.x = target.x + targetVel.x * t; out.y = target.y + targetVel.y * t; out.z = target.z + targetVel.z * t; out.t = t;
  return true;
}

/** How far any bolt travels before it fades. */
export const BOLT_REACH = 900;
/** Each gun has a best range: inside it a hit does a quarter more damage; past it the damage fades to about half at the limit. */
export const SWEET_SPOT: Record<0 | 1, [number, number]> = { 0: [70, 420], 1: [160, 650] };

export function inSweetSpot(kind: 0 | 1, dist: number): boolean { const [lo, hi] = SWEET_SPOT[kind]; return dist >= lo && dist <= hi; }

/** Damage of a hit that travelled `dist` units: bonus in the sweet spot, full when closer, fading beyond it. */
export function damageAt(kind: 0 | 1, dist: number): number {
  const w = weaponStats(kind), [lo, hi] = SWEET_SPOT[kind];
  if (dist >= lo && dist <= hi) return w.damage * 1.25;
  if (dist < lo) return w.damage;
  return w.damage * (1 - 0.55 * Math.min(1, (dist - hi) / Math.max(1, BOLT_REACH - hi)));
}

/**
 * How close a bolt must pass to a ship to hit it. The ship you aim at is drawn larger the further away it is, and news of it
 * (and of your shot) is a moment old, so the target grows with the distance the bolt has flown and with the ship's own speed.
 */
export function hitRadius(travelled: number, victimSpeed: number): number {
  return 2.2 + Math.min(9, travelled * 0.012) + Math.min(5, victimSpeed * 0.03);
}

/**
 * Damage model: a ship has a shield and a hull. Hits take the shield first; the shield comes back on its own after a few
 * seconds without being hit, the hull does not (only a kill heals it, or a new life). So a fight is won by landing a burst,
 * not by trading single shots, and a pilot who breaks off for a moment is back at full shield.
 */
export const SHIELD_MAX = 40;
export const SHIELD_DELAY = 3.5;  // seconds without a hit before the shield starts to come back
export const SHIELD_REGEN = 14;   // shield points per second once it does
export const HULL_MAX = 100;

/** Rates of fire and the blaster's heat, shared by the ship and by the balance report (dev/balance-report.mjs). */
export const FIRE_GAP = 0.16;      // blaster: seconds between shots
export const HEAT_PER_SHOT = 0.1;  // blaster: how much each shot heats it (it overheats at 1)
export const HEAT_COOL = 0.26;     // blaster: how fast it cools, per second
export const HEAT_RESET = 0.4;     // after overheating, it works again once it is this cool
export const CANNON_GAP = 0.5;     // cannon: seconds between rounds
export const AMMO_MAX = 36;        // cannon: rounds per life
