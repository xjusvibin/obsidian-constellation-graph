import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

globalThis.window = globalThis;
const built = await build({ stdin: { contents: 'export { sanitizeSettings, DEFAULT_SETTINGS } from "./src/settings";', resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", write: false });
const s = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

// what a data.json from the 0.1 releases looked like: only the first few settings
const OLD = { motion: "calm", glow: 0.9, palette: "vibrant", groupBy: "folder", pilotEnabled: true };

test("settings saved by an old version load, and every new setting gets its default", () => {
  const out = s.sanitizeSettings(OLD);
  assert.equal(out.motion, "calm");
  assert.equal(out.glow, 0.9);
  for (const key of Object.keys(s.DEFAULT_SETTINGS)) assert.ok(key in out, `missing ${key}`);
  assert.deepEqual(out.keyBindings, {});
  assert.deepEqual(out.highScores, []);
  assert.equal(out.pilotDrones, true);
  assert.equal(out.pilotTips, true);
});

test("nothing, junk and the wrong kinds of value fall back to the defaults", () => {
  for (const raw of [undefined, null, "text", 5, [], {}]) assert.deepEqual(s.sanitizeSettings(raw), s.sanitizeSettings({}));
  const bad = s.sanitizeSettings({ motion: "turbo", glow: "bright", pilotVolume: 9, padDeadzone: -1, aimAssist: "yes", pilotDrones: 1, arcadeName: 42 });
  assert.equal(bad.motion, s.DEFAULT_SETTINGS.motion);
  assert.equal(bad.glow, s.DEFAULT_SETTINGS.glow);
  assert.equal(bad.pilotVolume, 1);        // clamped, not dropped
  assert.equal(bad.padDeadzone, 0.05);     // clamped to the lowest allowed
  assert.equal(bad.aimAssist, s.DEFAULT_SETTINGS.aimAssist);
  assert.equal(bad.pilotDrones, s.DEFAULT_SETTINGS.pilotDrones);
  assert.equal(bad.arcadeName, "");
});

test("unknown settings are dropped, and saving then loading again changes nothing", () => {
  const once = s.sanitizeSettings({ ...OLD, shiny: true, __proto__: { polluted: 1 } });
  assert.equal("shiny" in once, false);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(s.sanitizeSettings(JSON.parse(JSON.stringify(once))), once);
});

test("stored key bindings and high scores are cleaned on the way in", () => {
  const out = s.sanitizeSettings({
    keyBindings: { forward: "ArrowUp", fire: "Escape", nope: "KeyZ" },
    highScores: [{ name: "ACE", score: 3900, waves: 3, kills: 9, at: 1 }, { name: "CHEAT", score: 99999, waves: 1, kills: 1, at: 2 }],
    arcadeName: "A very long arcade name indeed",
  });
  assert.deepEqual(out.keyBindings, { forward: "ArrowUp" });
  assert.deepEqual(out.highScores.map(e => e.name), ["ACE"]);
  assert.equal(out.arcadeName.length, 12);
});

test("a saved camera view is checked", () => {
  assert.equal(s.sanitizeSettings({ savedView: { d: [1, 2, "x"], z: 1 } }).savedView, null);
  assert.equal(s.sanitizeSettings({ savedView: { d: [0.1, 0.5, 0.8], z: 0.4 } }).savedView.z, 0.4);
});
