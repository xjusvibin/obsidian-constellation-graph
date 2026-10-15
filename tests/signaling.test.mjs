import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";

const require = createRequire(import.meta.url);
const { WebSocket } = require("../server/node_modules/ws");

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function socketClient(url) {
  const ws = new WebSocket(url), messages = [], waiters = [];
  ws.on("message", raw => {
    let message; try { message = JSON.parse(raw.toString()); } catch { return; }
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].predicate(message)) {
      const [waiter] = waiters.splice(i, 1); clearTimeout(waiter.timer); waiter.resolve(message);
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.once("open", resolve); ws.once("error", reject);
  });
  const wait = (predicate, timeoutMs = 3000) => {
    const old = messages.find(predicate); if (old) return Promise.resolve(old);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error("Timed out waiting for signaling response.")); }, timeoutMs) };
      waiters.push(waiter);
    });
  };
  return { ws, opened, wait };
}

test("signaling supports four members, temporary TURN credentials, and deterministic host transfer", { timeout: 20_000 }, async () => {
  const port = await freePort(), secret = "test-only-turn-secret-not-for-production";
  const child = spawn(process.execPath, ["index.js"], {
    cwd: new URL("../server/", import.meta.url),
    env: { ...process.env, PORT: String(port), TURN_SECRET: secret, TURN_URLS: "turn:turn.example.test:3478?transport=udp", STUN_URLS: "stun:stun.example.test:3478", MAX_ROOMS: "8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = ""; child.stdout.on("data", d => { logs += d.toString(); }); child.stderr.on("data", d => { logs += d.toString(); });
  const clients = [];
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch { /* process is starting */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, "signaling service did not start");
    const url = `ws://127.0.0.1:${port}`;
    const connect = async () => { const client = socketClient(url); clients.push(client); await client.opened; return client; };
    const host = await connect(); host.ws.send(JSON.stringify({ type: "create", protocol: 2, name: "Host" }));
    const created = await host.wait(m => m.type === "created");
    const oldClient = await connect(); oldClient.ws.send(JSON.stringify({ type: "join", protocol: 1, code: created.code, name: "Old Client" }));
    assert.equal((await oldClient.wait(m => m.type === "error")).code, "update-required");
    oldClient.ws.close();
    const turn = created.iceServers.find(server => String(server.urls).startsWith("turn:"));
    assert.ok(turn);
    const expiry = Number(turn.username.split(":", 1)[0]);
    assert.ok(expiry > Date.now() / 1000 && expiry <= Date.now() / 1000 + 3601);
    assert.equal(turn.credential, createHmac("sha1", secret).update(turn.username).digest("base64"));
    assert.equal((await fetch(`http://127.0.0.1:${port}/ice`)).status, 404, "TURN credentials are only issued to a room participant");
    const members = [created];
    for (const name of ["Pilot 2", "Pilot 3", "Pilot 4"]) {
      const client = await connect(); client.ws.send(JSON.stringify({ type: "join", protocol: 2, code: created.code, name }));
      members.push(await client.wait(m => m.type === "joined"));
    }
    assert.equal(members[3].members.length, 4);
    assert.deepEqual(members[3].members.map(m => m.slot), [0, 1, 2, 3]);

    const tooMany = await connect(); tooMany.ws.send(JSON.stringify({ type: "join", protocol: 2, code: created.code, name: "Fifth" }));
    const capacity = await tooMany.wait(m => m.type === "error");
    assert.equal(capacity.code, "full");
    tooMany.ws.close();

    const checkpoint = { epoch: 1, players: [{ id: members[1].selfId, health: 70, energy: 0.4 }] };
    host.ws.send(JSON.stringify({ type: "checkpoint", epoch: 1, state: checkpoint }));
    host.ws.terminate();
    const authority = await clients[2].wait(m => m.type === "authority");
    assert.equal(authority.hostId, members[1].selfId, "oldest remaining participant should win election");
    assert.equal(authority.epoch, 2);
    assert.deepEqual(authority.checkpoint.state, checkpoint);

    for (const client of clients.slice(1)) client.ws.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.rooms, 0);
    assert.equal(logs.includes(secret), false, "service logged a TURN secret");
    assert.equal(logs.includes("test-only"), false, "service logged test room payloads");
  } finally {
    for (const client of clients) if (client.ws.readyState === WebSocket.OPEN) client.ws.close();
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
  }
});
