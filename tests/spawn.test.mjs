import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const built = await build({ stdin: { contents: 'export * from "./src/spawn";', resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", write: false });
const s = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const spots = [[0, 0, 100], [100, 0, 0], [0, 0, -100], [-100, 0, 0]];
test("with nobody around you come back at the usual place", () => assert.equal(s.chooseSpawn(spots, []), 0));
test("you come back farthest from the other pilots", () => {
  assert.equal(s.chooseSpawn(spots, [{ x: 0, y: 0, z: 90 }]), 2, "an enemy at the first place sends you to the opposite one");
  assert.equal(s.chooseSpawn(spots, [{ x: 0, y: 0, z: 90 }, { x: 0, y: 0, z: -90 }]) % 2, 1, "enemies at both ends: one of the sides");
});
