import { PROTOCOL } from "./room";

/** Everything the "Copy diagnostics" button puts on the clipboard. Only versions, counts and connection quality: never the room code, names, addresses or anything about notes. */
export interface Diag {
  plugin: string; obsidian: string; platform: string;
  relay: string; quality: string; motion: string;
  room: { pilots: number; host: boolean; status: string; error: boolean } | null;
  peers: { n: number; link: string; pingMs: number | null; lossPct: number | null; route: string }[];
}

export function routeLabel(type: string | undefined): string {
  switch (type) {
    case "host": return "direct (same network)";
    case "srflx": case "prflx": return "direct (through a router)";
    case "relay": return "relayed (TURN)";
    default: return "unknown";
  }
}

/** The relay is shown as a host name only (a custom relay is private, so even that is reduced to "custom"). */
export function relayLabel(url: string): string {
  try { const h = new URL(url).hostname; return h === "ntfy.sh" ? h : h === "localhost" || h === "127.0.0.1" ? "localhost" : "custom"; } catch { return "invalid"; }
}

export function formatDiagnostics(d: Diag): string {
  const lines = [
    "Starfield Graph diagnostics",
    `Plugin ${d.plugin}, protocol ${PROTOCOL}, Obsidian ${d.obsidian}, ${d.platform}`,
    `Relay: ${d.relay}. Quality: ${d.quality}. Motion: ${d.motion}`,
  ];
  if (!d.room) lines.push("Not in a room.");
  else {
    lines.push(`In a room with ${d.room.pilots} ${d.room.pilots === 1 ? "pilot" : "pilots"}${d.room.host ? " (you are the host)" : ""}. Status${d.room.error ? " (problem)" : ""}: ${d.room.status}`);
    for (const p of d.peers) lines.push(`Pilot ${p.n}: ${p.link}, ping ${p.pingMs === null ? "n/a" : p.pingMs + " ms"}, loss ${p.lossPct === null ? "n/a" : p.lossPct + "%"}, ${p.route}`);
  }
  return lines.join("\n");
}
