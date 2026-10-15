// Synthetic network-only browser harness. No vault access and no WebGL required.
import { HOSTED_SIGNALING_URL, MultiplayerSession, type AnonymousPlayer, type Pose } from "../src/multiplayer";
import type { GraphData, SimNode } from "../src/types";

const name = document.getElementById("name") as HTMLInputElement;
const code = document.getElementById("code") as HTMLInputElement;
const flying = document.getElementById("flying") as HTMLInputElement;
const relay = document.getElementById("relay") as HTMLInputElement;
const status = document.getElementById("status")!;
const players = document.getElementById("players")!;
const transport = document.getElementById("transport")!;
const maps = document.getElementById("maps")!;
const connections = new Set<RTCPeerConnection>();
const NativeConnection = globalThis.RTCPeerConnection;
if (NativeConnection) {
  globalThis.RTCPeerConnection = class extends NativeConnection {
    constructor(configuration?: RTCConfiguration) {
      super({ ...configuration, iceTransportPolicy: relay.checked ? "relay" : "all" });
      connections.add(this);
    }
  };
}

const data: GraphData = {
  groups: [{ key: "synthetic", label: "Synthetic", color: "#5b9bff", count: 2 }],
  nodes: [{ id: "Alpha.md", name: "Alpha", group: "synthetic", deg: 1 }, { id: "Beta.md", name: "Beta", group: "synthetic", deg: 1 }],
  links: [{ source: "Alpha.md", target: "Beta.md" }],
};
const nodes: SimNode[] = data.nodes.map((node, index) => ({ ...node, index, gi: 0, x: index * 40, y: 0, z: 0, vx: 0, vy: 0, vz: 0, phase: 0, speed: 0 }));
let members: AnonymousPlayer[] = [], self = "", topologyCount = 0, positionCount = 0;
const poses = new Map<string, Pose>();
const rows = new Map<string, HTMLLIElement>();
function renderPlayers(): void {
  for (const [id, row] of rows) if (!members.some(member => member.id === id)) { row.remove(); rows.delete(id); }
  for (const member of members) {
    let row = rows.get(member.id);
    if (!row) { row = document.createElement("li"); rows.set(member.id, row); players.append(row); }
    const pose = poses.get(member.id);
    const text = `${member.name}${member.id === self ? " (you)" : ""}: ${pose ? `${pose.health} HP, ${pose.active ? "flying" : "spectator"}` : "waiting for flight state"}`;
    if (row.textContent !== text) row.textContent = text;
  }
}
function renderMaps(): void { maps.textContent = `${topologyCount} map revisions; ${positionCount} position frames`; }
const network = new MultiplayerSession({
  status(text, error) { status.textContent = text; status.className = error ? "error" : ""; },
  members(value, selfId) {
    members = value; self = selfId; relay.disabled = !!self;
    for (const id of poses.keys()) if (!members.some(member => member.id === id)) poses.delete(id);
    renderPlayers();
  },
  playerState(id, pose) { poses.set(id, pose); renderPlayers(); },
  topology() { topologyCount++; renderMaps(); }, positions() { positionCount++; renderMaps(); },
  message() {}, removed() {}, authority() {}, shotState() {},
}, () => ({ data, nodes }), () => HOSTED_SIGNALING_URL);

async function start(action: "create" | "join"): Promise<void> {
  try {
    if (action === "create") await network.create(name.value); else await network.join(code.value, name.value);
    code.value = network.room;
  } catch (error) { status.textContent = error instanceof Error ? error.message : "Connection failed"; status.className = "error"; }
}
document.getElementById("create")!.addEventListener("click", () => void start("create"));
document.getElementById("join")!.addEventListener("click", () => void start("join"));
document.getElementById("leave")!.addEventListener("click", () => network.leave());
const inputs = window.setInterval(() => network.sendInput({ thrust: 0, strafe: 0, lift: 0, roll: 0, pitch: 0, yaw: 0, boost: false, brake: false, fire: false, active: flying.checked }), 50);
const stats = window.setInterval(() => {
  void Promise.all([...connections].filter(pc => pc.connectionState !== "closed").map(async pc => {
    const report = await pc.getStats();
    const selected = [...report.values()].find(item => item.type === "transport" && item.selectedCandidatePairId)?.selectedCandidatePairId;
    const pair = selected ? report.get(selected) : [...report.values()].find(item => item.type === "candidate-pair" && item.nominated && item.state === "succeeded");
    const local = pair && report.get(pair.localCandidateId)?.candidateType;
    const remote = pair && report.get(pair.remoteCandidateId)?.candidateType;
    // Display only types and counters, never candidate addresses or credentials.
    return `${pc.connectionState}${pair ? `: ${local} -> ${remote}; ${pair.bytesSent || 0} bytes sent` : ""}`;
  })).then(rows => { transport.textContent = rows.join("\n") || "No peer connection"; }).catch(() => { transport.textContent = "Connection statistics unavailable"; });
}, 1000);
window.addEventListener("beforeunload", () => { clearInterval(inputs); clearInterval(stats); network.leave(); });
renderMaps();
if (!NativeConnection) status.textContent = "This browser does not provide WebRTC.";
