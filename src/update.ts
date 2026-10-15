/** The optional update check: is there a newer release on GitHub than the one that is running? It never downloads or installs anything. */
export interface LatestRelease { version: string; url: string }

export const RELEASES_API = "https://api.github.com/repos/xjusvibin/obsidian-constellation-graph/releases/latest";

/** Compare two dotted version numbers (0.4.10 is newer than 0.4.9). Negative if a is older, positive if newer, 0 if the same. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(n => parseInt(n, 10) || 0), pb = b.split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Read GitHub's "latest release" reply. Anything unexpected (or a link that does not point at GitHub) is ignored. */
export function parseLatest(json: unknown): LatestRelease | null {
  if (!json || typeof json !== "object") return null;
  const r = json as { tag_name?: unknown; html_url?: unknown };
  if (typeof r.tag_name !== "string" || !/^\d+\.\d+\.\d+$/.test(r.tag_name)) return null;
  const url = typeof r.html_url === "string" && r.html_url.startsWith("https://github.com/xjusvibin/obsidian-constellation-graph/") ? r.html_url : "https://github.com/xjusvibin/obsidian-constellation-graph/releases";
  return { version: r.tag_name, url };
}
