import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({ stdin: { contents: 'export * from "./src/drones";', resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", write: false });
globalThis.window = globalThis;
const d = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

test("waves get bigger, tougher and faster, with limits", () => {
  const a = d.waveSpec(1), b = d.waveSpec(4), z = d.waveSpec(99);
  assert.ok(b.count > a.count && b.hp > a.hp && b.speed > a.speed);
  assert.ok(z.count <= 8 && z.hp <= 120 && z.speed <= 1.8);
  assert.equal(d.waveSpec(0).count, d.waveSpec(1).count);
});

test("a ray finds a sphere in front of it, and not one behind or off to the side", () => {
  assert.ok(Math.abs(d.rayHit([0, 0, 0], [0, 0, -1], [0, 0, -100], 5) - 95) < 1e-9);
  assert.equal(d.rayHit([0, 0, 0], [0, 0, -1], [0, 0, 100], 5), -1);
  assert.equal(d.rayHit([0, 0, 0], [0, 0, -1], [20, 0, -100], 5), -1);
  assert.equal(d.rayHit([0, 0, 0], [0, 0, -1], [0, 0, -1], 5), 0); // already inside
});

test("an orbit stays near its radius and is the same every time", () => {
  const o1 = d.makeOrbit(7, [10, 20, 30], 200, 0.1), o2 = d.makeOrbit(7, [10, 20, 30], 200, 0.1);
  assert.deepEqual(d.orbitAt(o1, 3.3), d.orbitAt(o2, 3.3));
  for (let t = 0; t < 60; t += 3) {
    const p = d.orbitAt(o1, t), r = Math.hypot(p[0] - 10, p[1] - 20, p[2] - 30);
    assert.ok(r > 200 * 0.8 * 0.85 && r < 200 * 1.3 * 1.25, `radius ${r}`);
  }
});
