import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({
  stdin: { contents: 'export * from "./src/update"; export { sanitizeSettings } from "./src/settings";', resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), loader: "ts" },
  bundle: true, platform: "node", format: "esm", target: "node22", write: false,
});
globalThis.window = globalThis;
const u = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

test("versions compare by number, not by text", () => {
  assert.ok(u.compareVersions("0.4.10", "0.4.9") > 0);
  assert.ok(u.compareVersions("0.4.1", "0.4.1") === 0);
  assert.ok(u.compareVersions("0.3.9", "0.4.0") < 0);
  assert.ok(u.compareVersions("1.0.0", "0.99.99") > 0);
});

test("only a plain version tag from GitHub is accepted, and the link must point at the repository", () => {
  assert.deepEqual(u.parseLatest({ tag_name: "0.5.0", html_url: "https://github.com/xjusvibin/obsidian-constellation-graph/releases/tag/0.5.0" }), { version: "0.5.0", url: "https://github.com/xjusvibin/obsidian-constellation-graph/releases/tag/0.5.0" });
  assert.equal(u.parseLatest({ tag_name: "v1" }), null);
  assert.equal(u.parseLatest({ tag_name: "0.5.0; rm -rf" }), null);
  assert.equal(u.parseLatest(null), null);
  assert.equal(u.parseLatest({ tag_name: "0.5.0", html_url: "https://evil.example/x" }).url, "https://github.com/xjusvibin/obsidian-constellation-graph/releases");
});

test("the update check is off by default, and bad saved values fall back", () => {
  const d = u.sanitizeSettings({});
  assert.equal(d.checkForUpdates, false);
  const s = u.sanitizeSettings({ checkForUpdates: "yes", updateCheckedAt: "now", updateNotified: "<script>" });
  assert.equal(s.checkForUpdates, false);
  assert.equal(s.updateCheckedAt, 0);
  assert.equal(s.updateNotified, "");
});

test("a remembered camera is kept only when it is sane", () => {
  const good = u.sanitizeSettings({ savedView: { d: [0.3, 0.4, 0.9], z: 1.2 } }).savedView;
  assert.ok(Math.abs(Math.hypot(...good.d) - 1) < 1e-9 && good.z === 1.2, "the direction is normalised");
  assert.equal(u.sanitizeSettings({ savedView: { d: [0, 0, 2], z: 1 } }).savedView, null, "not a direction");
  assert.equal(u.sanitizeSettings({ savedView: { d: [0, 0, 0], z: 1 } }).savedView, null);
  assert.equal(u.sanitizeSettings({ savedView: { d: [1, "x", 0], z: 1 } }).savedView, null);
  assert.equal(u.sanitizeSettings({ savedView: { d: [0, 0, 1], z: 99 } }).savedView.z, 2, "the distance is limited");
  assert.equal(u.sanitizeSettings({}).savedView, null);
  assert.equal(u.sanitizeSettings({}).rememberView, true);
});
