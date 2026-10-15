import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({ stdin: { contents: 'export * from "./src/diagnostics";', resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", write: false });
const d = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

test("route and relay labels say how pilots are reached without exposing addresses", () => {
  assert.match(d.routeLabel("relay"), /TURN/);
  assert.match(d.routeLabel("srflx"), /router/);
  assert.equal(d.routeLabel(undefined), "unknown");
  assert.equal(d.relayLabel("https://ntfy.sh"), "ntfy.sh");
  assert.equal(d.relayLabel("https://my.private.example.org/x"), "custom");
  assert.equal(d.relayLabel("http://localhost:8788"), "localhost");
  assert.equal(d.relayLabel("nonsense"), "invalid");
});

test("the diagnostics text has versions and quality but no names, codes or addresses", () => {
  const text = d.formatDiagnostics({
    plugin: "0.8.0", obsidian: "1.7.2", platform: "Win32", relay: "ntfy.sh", quality: "auto", motion: "calm",
    room: { pilots: 3, host: true, status: "Connected to 2 pilots.", error: false },
    peers: [{ n: 1, link: "connected", pingMs: 42, lossPct: 0, route: "direct (through a router)" }, { n: 2, link: "connecting", pingMs: null, lossPct: null, route: "unknown" }],
  });
  assert.match(text, /Plugin 0\.8\.0, protocol \d+/);
  assert.match(text, /Pilot 1: connected, ping 42 ms, loss 0%/);
  assert.match(text, /Pilot 2: connecting, ping n\/a/);
  assert.doesNotMatch(text, /\d+\.\d+\.\d+\.\d+/); // no IP addresses
  assert.equal(d.formatDiagnostics({ plugin: "x", obsidian: "y", platform: "z", relay: "r", quality: "q", motion: "m", room: null, peers: [] }).includes("Not in a room."), true);
});
