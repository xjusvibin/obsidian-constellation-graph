/** What a game controller asks for this frame, from the standard mapping. Pure, so it can be tested without a controller. */
export interface PadInput {
  thrust: number; strafe: number; lift: number; roll: number;  // -1..1
  lookX: number; lookY: number;                                 // -1..1, right stick
  fire: boolean; boost: boolean; brake: boolean;
  missile: boolean; lock: boolean; weapon: boolean; view: boolean; hub: boolean; // held; the caller turns these into single presses
  scores: boolean;                                              // held while the scoreboard is wanted
  active: boolean;                                              // anything at all is being asked for
}

export const PAD_DEADZONE = 0.16;

/** Ignore the small drift near the centre, and rescale so the stick still reaches full tilt. */
export function deadzone(v: number, dz = PAD_DEADZONE): number {
  const a = Math.abs(v); if (!(a > dz)) return 0;
  return Math.sign(v) * Math.min(1, (a - dz) / (1 - dz));
}

export interface PadLike { id?: string; axes: readonly number[]; buttons: readonly { pressed: boolean; value: number }[] }

const down = (p: PadLike, i: number): boolean => !!p.buttons[i]?.pressed;
const trig = (p: PadLike, i: number): boolean => (p.buttons[i]?.value ?? 0) > 0.4 || down(p, i);

export function readPad(p: PadLike | null | undefined): PadInput {
  const none: PadInput = { thrust: 0, strafe: 0, lift: 0, roll: 0, lookX: 0, lookY: 0, fire: false, boost: false, brake: false, missile: false, lock: false, weapon: false, view: false, hub: false, scores: false, active: false };
  if (!p) return none;
  const thrust = -deadzone(p.axes[1] ?? 0), strafe = deadzone(p.axes[0] ?? 0);
  const lookX = deadzone(p.axes[2] ?? 0), lookY = deadzone(p.axes[3] ?? 0);
  const lift = (down(p, 0) ? 1 : 0) - (down(p, 1) ? 1 : 0);
  const roll = (down(p, 14) ? 1 : 0) - (down(p, 15) ? 1 : 0); // d-pad left is roll left (the Q key), right is roll right (E)
  // the usual shooter layout: right trigger fires, left trigger is the secondary weapon (missile), bumpers and stick clicks are movement modifiers
  const fire = trig(p, 7), missile = trig(p, 6), boost = down(p, 5) || down(p, 10), brake = down(p, 4);
  const weapon = down(p, 2), lock = down(p, 3), view = down(p, 12), hub = down(p, 13), scores = down(p, 8);
  const active = !!(thrust || strafe || lookX || lookY || lift || roll || fire || missile || boost || brake || weapon || lock || view || hub || scores);
  return { thrust, strafe, lift, roll, lookX, lookY, fire, boost, brake, missile, lock, weapon, view, hub, scores, active };
}

/** A short, plain name for the readout: the part of the id before the vendor details, without the driver's mapping note. */
export function padName(p: PadLike | null | undefined): string {
  const id = (p?.id ?? "").replace(/\s*\((?:STANDARD GAMEPAD|Vendor:[^)]*)\)\s*/gi, " ").replace(/\s+/g, " ").trim();
  return id.slice(0, 40) || "Controller";
}

/** The first controller that is connected and being used, or any connected one. */
export function pickPad(pads: ArrayLike<PadLike | null> | null | undefined): PadLike | null {
  if (!pads) return null;
  let first: PadLike | null = null;
  for (let i = 0; i < pads.length; i++) { const p = pads[i]; if (!p) continue; first ??= p; if (readPad(p).active) return p; }
  return first;
}
