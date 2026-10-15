// Prints how long a fight takes, from the real constants: node dev/balance-report.mjs
// For each gun and range: damage per hit, and the time to destroy a full ship (shield and hull) at perfect aim and at a realistic hit rate.
import { build } from "esbuild";
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const out = await build({ stdin: { contents: 'export * from "./src/weapons";', resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", write: false });
const w = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const total = w.SHIELD_MAX + w.HULL_MAX;
/** Seconds until `total` damage has landed, firing as fast as the gun allows and hitting with probability `acc` (deterministic expected value). */
function timeToKill(kind, dist, acc) {
  const dmg = w.damageAt(kind, dist) * acc;
  let t = 0, done = 0, heat = 0, over = false, ammo = w.AMMO_MAX, next = 0;
  const dt = 0.005;
  while (done < total && t < 120) {
    heat = Math.max(0, heat - w.HEAT_COOL * dt);
    if (over && heat <= w.HEAT_RESET) over = false;
    if (t >= next) {
      if (kind === 0 && !over) { done += dmg; heat += w.HEAT_PER_SHOT; next = t + w.FIRE_GAP; if (heat >= 1) { heat = 1; over = true; } }
      else if (kind === 1 && ammo > 0) { done += dmg; ammo--; next = t + w.CANNON_GAP; }
      else if (kind === 1) return Infinity; // out of rounds
    }
    t += dt;
  }
  return done >= total ? t : Infinity;
}
const fmt = x => (x === Infinity ? "never" : x.toFixed(1) + " s");
console.log(`Ship: ${w.SHIELD_MAX} shield + ${w.HULL_MAX} hull = ${total}. Shield returns after ${w.SHIELD_DELAY} s without a hit.\n`);
console.log("gun      range  dmg/hit  kill @100% aim  kill @40% aim  kill @20% aim   best range");
for (const kind of [0, 1]) {
  for (const d of [40, 150, 300, 500, 700, 900]) {
    console.log(`${(kind ? "cannon " : "blaster")}  ${String(d).padStart(5)}  ${w.damageAt(kind, d).toFixed(1).padStart(7)}  ${fmt(timeToKill(kind, d, 1)).padStart(14)}  ${fmt(timeToKill(kind, d, 0.4)).padStart(13)}  ${fmt(timeToKill(kind, d, 0.2)).padStart(13)}   ${w.inSweetSpot(kind, d) ? "yes" : ""}`);
  }
}
console.log(`\nBlaster: ${(1 / w.FIRE_GAP).toFixed(1)} shots/s, overheats after ${Math.ceil(1 / w.HEAT_PER_SHOT)} shots, lockout until ${w.HEAT_RESET} heat (${((1 - w.HEAT_RESET) / w.HEAT_COOL).toFixed(1)} s). Cannon: ${(1 / w.CANNON_GAP).toFixed(1)} shots/s, ${w.AMMO_MAX} rounds a life.`);
