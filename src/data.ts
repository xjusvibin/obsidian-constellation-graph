import { App, TFile, getAllTags } from "obsidian";
import type { ConstellationSettings } from "./settings";
import { accentFallback, groupColor } from "./palette";
import type { GraphData, GroupInfo, RawLink, RawNode } from "./types";

const MAX_GROUPS = 16;
const OTHER = "__other";

function groupKey(app: App, f: TFile, s: ConstellationSettings): string {
  if (s.groupBy === "none") return "all";
  if (s.groupBy === "tag") {
    const cache = app.metadataCache.getFileCache(f);
    const tags = cache ? getAllTags(cache) : null;
    return tags && tags.length ? tags[0] : "(untagged)";
  }
  const parts = f.path.split("/").slice(0, -1).slice(0, Math.max(1, s.folderDepth));
  return parts.length ? parts.join("/") : "(vault root)";
}

/** Notes become nodes, resolved [[links]] become edges, and notes are grouped by folder, tag or not at all. */
export function buildGraphData(app: App, s: ConstellationSettings, colorSlots: Map<string, number> = new Map()): GraphData {
  const excluded = s.excludeFolders.split(",").map(x => x.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
  const files = app.vault.getMarkdownFiles().filter(f => !excluded.some(x => f.path === x || f.path.startsWith(x + "/")));
  const known = new Set(files.map(f => f.path));

  const seen = new Set<string>();
  const links: RawLink[] = [];
  const deg = new Map<string, number>();
  const resolved = app.metadataCache.resolvedLinks;
  for (const src of Object.keys(resolved)) {
    if (!known.has(src)) continue;
    for (const dst of Object.keys(resolved[src])) {
      if (dst === src || !known.has(dst)) continue;
      const key = src < dst ? src + "\u0000" + dst : dst + "\u0000" + src;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: src, target: dst });
      deg.set(src, (deg.get(src) ?? 0) + 1); deg.set(dst, (deg.get(dst) ?? 0) + 1);
    }
  }

  const kept = files.filter(f => s.showOrphans || (deg.get(f.path) ?? 0) > 0);
  const keyOf = new Map(kept.map(f => [f.path, groupKey(app, f, s)]));
  const counts = new Map<string, number>();
  keyOf.forEach(k => counts.set(k, (counts.get(k) ?? 0) + 1));
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const named = new Set(ranked.slice(0, ranked.length > MAX_GROUPS ? MAX_GROUPS - 1 : MAX_GROUPS).map(e => e[0]));

  // A group keeps its colour for as long as the view lives: a new note must not recolour the groups you already know.
  const accent = accentFallback();
  const taken = new Set<number>();
  named.forEach(k => { const slot = colorSlots.get(k); if (slot !== undefined) taken.add(slot); });
  const groups: GroupInfo[] = [];
  ranked.forEach(([key, count]) => {
    if (!named.has(key)) return;
    let slot = colorSlots.get(key);
    if (slot === undefined) {
      slot = 0; while (taken.has(slot)) slot++;
      colorSlots.set(key, slot); taken.add(slot);
    }
    groups.push({ key, label: key === "all" ? "All notes" : key, color: groupColor(slot, s.palette, accent), count });
  });
  const otherCount = ranked.filter(e => !named.has(e[0])).reduce((n, e) => n + e[1], 0);
  if (otherCount) groups.push({ key: OTHER, label: "Other", color: "#8b93a7", count: otherCount });

  const nodes: RawNode[] = kept.map(f => {
    const k = keyOf.get(f.path)!;
    return { id: f.path, name: f.basename, group: named.has(k) ? k : OTHER, deg: deg.get(f.path) ?? 0, ctime: f.stat.ctime };
  });
  const ids = new Set(nodes.map(n => n.id));
  return { nodes, links: links.filter(l => ids.has(l.source) && ids.has(l.target)), groups };
}

/** A short fingerprint of everything that changes how the graph looks: notes, their groups and link counts, every link, group colours. */
export function signature(d: GraphData): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  };
  d.nodes.forEach(n => feed(n.id + "|" + n.group + "|" + n.deg));
  d.links.map(l => (l.source < l.target ? l.source + ">" + l.target : l.target + ">" + l.source)).sort().forEach(feed);
  d.groups.forEach(g => feed(g.key + g.color));
  return `${d.nodes.length}:${d.links.length}:${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}`;
}
