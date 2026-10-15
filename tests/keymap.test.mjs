import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({ stdin: { contents: 'export * from "./src/keymap";', resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", write: false });
const k = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

test("with no bindings every key means itself", () => {
  const t = k.buildTranslator({});
  assert.equal(k.translateCode(t, "KeyW"), "KeyW");
  assert.equal(k.translateCode(t, "ArrowUp"), "ArrowUp");
});

test("a rebound key becomes the action, and the old key stops doing it", () => {
  const r = k.bindKey({}, "forward", "ArrowUp");
  assert.ok(r.bindings);
  const t = k.buildTranslator(r.bindings);
  assert.equal(k.translateCode(t, "ArrowUp"), "KeyW");
  assert.equal(k.translateCode(t, "KeyW"), null);
  assert.equal(k.codeFor(r.bindings, "forward"), "ArrowUp");
});

test("a key already used, or a reserved key, is refused with a reason", () => {
  assert.match(k.bindKey({}, "fire", "KeyW").error, /already used/);
  assert.match(k.bindKey({}, "fire", "Escape").error, /cannot be used/);
  assert.match(k.bindKey({}, "fire", "KeyP").error, /cannot be used/);
  assert.match(k.bindKey({}, "nope", "KeyJ").error, /Unknown/);
});

test("two actions can swap keys step by step, and binding back to the default clears it", () => {
  let b = k.bindKey({}, "fire", "KeyJ").bindings;
  assert.deepEqual(b, { fire: "KeyJ" });
  b = k.bindKey(b, "fire", "KeyF").bindings;
  assert.deepEqual(b, {});
  assert.equal(k.bindKey({ fire: "KeyJ" }, "missile", "KeyJ").error !== undefined, true);
});

test("stored bindings are cleaned: unknown actions, odd codes, reserved keys and duplicates are dropped", () => {
  const out = k.sanitizeBindings({ forward: "ArrowUp", fire: "ArrowUp", nope: "KeyZ", back: "Esc ape", left: "Escape", right: 5, up: "KeyJ" });
  assert.deepEqual(out, { forward: "ArrowUp", up: "KeyJ" });
  assert.deepEqual(k.sanitizeBindings(null), {});
  assert.deepEqual(k.sanitizeBindings("x"), {});
});

test("key labels are short and readable", () => {
  assert.equal(k.keyLabel("KeyW"), "W");
  assert.equal(k.keyLabel("ShiftLeft"), "Shift");
  assert.equal(k.keyLabel("ArrowUp"), "↑");
  assert.equal(k.keyLabel("Digit4"), "4");
  assert.equal(k.keyLabel("Numpad7"), "Num 7");
});
