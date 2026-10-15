import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({ entryPoints: ["src/gamepad.ts"], bundle: true, format: "esm", write: false, platform: "node" });
const m = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
const pad = (axes = [0, 0, 0, 0], on = []) => ({ axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: on.includes(i), value: on.includes(i) ? 1 : 0 })) });

test("a centred stick asks for nothing, drift is ignored", () => {
  assert.equal(m.readPad(pad([0.1, -0.12, 0.05, 0.15])).active, false);
  assert.equal(m.readPad(null).active, false);
});
test("the stick is rescaled so full tilt is 1", () => {
  assert.equal(m.deadzone(1), 1);
  assert.ok(m.deadzone(0.58) > 0.4 && m.deadzone(0.58) < 0.6);
  assert.equal(m.deadzone(-1), -1);
});
test("left stick up is thrust, right is strafe", () => {
  const r = m.readPad(pad([1, -1, 0, 0]));
  assert.equal(r.thrust, 1); assert.equal(r.strafe, 1);
});
test("buttons map to fire, boost, brake, missile, lift and roll", () => {
  const r = m.readPad(pad([0, 0, 0, 0], [7, 5, 6, 4, 0, 14, 2, 3]));
  assert.ok(r.fire && r.boost && r.brake && r.missile && r.weapon && r.lock);
  assert.equal(r.lift, 1); assert.equal(r.roll, 1); // button 14 is d-pad left: roll left, like Q
  assert.equal(m.readPad(pad([0, 0, 0, 0], [15])).roll, -1);
});
test("pickPad prefers a controller that is being used", () => {
  const idle = pad(), used = pad([0, 0, 0, 0], [7]);
  assert.equal(m.pickPad([idle, used]), used);
  assert.equal(m.pickPad([null, idle]), idle);
  assert.equal(m.pickPad([]), null);
});
test("the readout name drops the driver notes", () => {
  assert.equal(m.padName({ id: "Xbox 360 Controller for Windows (STANDARD GAMEPAD)", axes: [], buttons: [] }), "Xbox 360 Controller for Windows");
  assert.equal(m.padName({ id: "Wireless Controller (Vendor: 054c Product: 09cc)", axes: [], buttons: [] }), "Wireless Controller");
  assert.equal(m.padName(null), "Controller");
});
