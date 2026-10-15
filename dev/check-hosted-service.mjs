// Synthetic signaling check only: no vault data and no WebRTC/TURN media traffic.
// Match the Origin header sent by desktop Obsidian. Never print service payloads,
// because successful replies contain temporary TURN credentials.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WebSocket } = require("../server/node_modules/ws");
const url = process.argv[2] || "wss://constellation-rooms.mrassetto.workers.dev";
const clients = [];

function client() {
  const ws = new WebSocket(url, { origin: "app://obsidian.md", handshakeTimeout: 15_000 });
  const messages = [], waiters = [];
  const opened = new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.on("error", () => {});
  ws.on("message", raw => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].predicate(message)) {
      const [waiter] = waiters.splice(i, 1); clearTimeout(waiter.timer); waiter.resolve(message);
    }
  });
  const wait = predicate => {
    const existing = messages.find(predicate); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1); reject(new Error("Room reply timed out."));
      }, 15_000) };
      waiters.push(waiter);
    });
  };
  const result = { ws, opened, wait }; clients.push(result); return result;
}

try {
  const host = client(); await host.opened;
  host.ws.send(JSON.stringify({ type: "create", protocol: 2, name: "Synthetic check A" }));
  const created = await host.wait(message => message.type === "created" || message.type === "error");
  assert.equal(created.type, "created", `Create failed: ${created.code || "unknown error"}`);
  const peer = client(); await peer.opened;
  peer.ws.send(JSON.stringify({ type: "join", protocol: 2, code: created.code, name: "Synthetic check B" }));
  const joined = await peer.wait(message => message.type === "joined" || message.type === "error");
  assert.equal(joined.type, "joined", `Join failed: ${joined.code || "unknown error"}`);
  assert.equal(joined.members.length, 2);
  assert.equal(joined.hostId, created.hostId);
  console.log(`Hosted WebSocket check passed: Obsidian Origin accepted, create/join succeeded, two members, relay ${joined.relayStatus} (${joined.iceServers?.length || 0} servers).`);
} finally {
  await Promise.all(clients.map(({ ws }) => new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(() => { ws.terminate(); resolve(); }, 2000);
    ws.once("close", () => { clearTimeout(timer); resolve(); }); ws.close();
  })));
}
