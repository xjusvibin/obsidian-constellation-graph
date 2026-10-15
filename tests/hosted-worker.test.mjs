import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const serverDir = join(testDir, "..", "server");
const wrangler = join(serverDir, "node_modules", "wrangler", "bin", "wrangler.js");
const require = createRequire(import.meta.url);
const { WebSocket } = require("../server/node_modules/ws");

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function client(url) {
  const ws = new WebSocket(url), messages = [], waiters = [];
  ws.on("message", raw => {
    let message; try { message = JSON.parse(raw.toString()); } catch { return; }
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index--) if (waiters[index].predicate(message)) {
      const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message);
    }
  });
  const opened = new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const wait = predicate => {
    const existing = messages.find(predicate); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error("Timed out waiting for hosted Worker response.")); }, 5000) };
      waiters.push(waiter);
    });
  };
  return { ws, opened, wait };
}

test("hosted Worker serves four-player rooms and elects a replacement host", { timeout: 60_000 }, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--config", "wrangler.jsonc"], {
    cwd: serverDir,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", data => { logs += data.toString(); });
  child.stderr.on("data", data => { logs += data.toString(); });
  const clients = [];
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) break;
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch { /* Worker is starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, `hosted Worker did not start: ${logs.slice(-1500)}`);
    const url = `ws://127.0.0.1:${port}/`;
    const connect = async () => { const item = client(url); clients.push(item); await item.opened; return item; };
    const host = await connect(); host.ws.send(JSON.stringify({ type: "create", protocol: 2, name: "Synthetic Host" }));
    const created = await host.wait(message => message.type === "created");
    assert.match(created.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(created.members.length, 1);
    const oldClient = await connect(); oldClient.ws.send(JSON.stringify({ type: "join", protocol: 1, code: created.code, name: "Old Client" }));
    assert.equal((await oldClient.wait(message => message.type === "error")).code, "update-required");
    oldClient.ws.close();

    const members = [created];
    for (const name of ["Synthetic Two", "Synthetic Three", "Late Joiner"]) {
      const pilot = await connect(); pilot.ws.send(JSON.stringify({ type: "join", protocol: 2, code: created.code, name }));
      const joined = await pilot.wait(message => message.type === "joined");
      members.push(joined);
      assert.equal(joined.members.length, members.length);
    }
    assert.deepEqual(members[3].members.map(member => member.slot), [0, 1, 2, 3]);

    const privateFixturePath = "Distinctive-Vault-Path-79Q4.md";
    host.ws.send(JSON.stringify({ type: "signal", to: members[1].selfId, data: { description: { type: "offer", sdp: "v=0\r\n" }, filePath: privateFixturePath } }));
    const relayedSignal = await clients[2].wait(message => message.type === "signal");
    assert.deepEqual(relayedSignal.data, { description: { type: "offer", sdp: "v=0\r\n" } }, "the signaling service forwards only WebRTC fields");

    host.ws.send(JSON.stringify({ type: "ice-refresh" }));
    const refreshed = await host.wait(message => message.type === "ice-servers");
    assert.ok(["pending", "unavailable"].includes(refreshed.relayStatus));
    assert.ok(refreshed.iceServers.every(server => String(server.urls).startsWith("stun:")), "test requests do not call a paid or metered relay");

    const fifth = await connect(); fifth.ws.send(JSON.stringify({ type: "join", protocol: 2, code: created.code, name: "Fifth Pilot" }));
    const capacity = await fifth.wait(message => message.type === "error");
    assert.equal(capacity.code, "full");
    fifth.ws.close();

    host.ws.terminate();
    const authority = await clients[2].wait(message => message.type === "authority");
    assert.equal(authority.hostId, members[1].selfId);
    assert.equal(authority.epoch, 2);
    for (const pilot of clients.slice(2, 5)) pilot.ws.close();

    let empty = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { if ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).rooms === 0) { empty = true; break; } } catch { /* retry */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(empty, true, "room membership is removed after the last player leaves");
    assert.equal(logs.includes("Synthetic Host"), false, "Worker does not log room payloads");
    assert.equal(logs.includes(privateFixturePath), false, "Worker does not log private fixture data");
  } finally {
    for (const pilot of clients) if (pilot.ws.readyState === WebSocket.OPEN) pilot.ws.close();
    child.kill("SIGTERM");
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
});
