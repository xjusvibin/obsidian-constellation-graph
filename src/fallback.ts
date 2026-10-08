import type { ConstellationSettings } from "./settings";
import type { GraphData, GraphRenderer, RendererCallbacks, SimNode } from "./types";

/**
 * Stands in for the 3D renderer when WebGL is unavailable (blocked GPU, remote desktop, context limit).
 * It keeps the same surface, so search, the note list, keyboard navigation and the details panel all still work.
 */
export class FallbackRenderer implements GraphRenderer {
  nodes: SimNode[] = [];
  private adj: number[][] = [];
  private ids = new Map<string, number>();
  private hidden = new Set<number>();
  private selected = -1;

  constructor(private cb: RendererCallbacks) {}

  get selectedIndex(): number { return this.selected; }
  get isPaused(): boolean { return true; }
  indexOf(id: string): number { return this.ids.get(id) ?? -1; }
  neighbors(i: number): number[] { return this.adj[i] ?? []; }

  setData(data: GraphData): void {
    const gi = new Map(data.groups.map((g, i) => [g.key, i]));
    this.nodes = data.nodes.map((n, index) => ({ ...n, index, gi: gi.get(n.group) ?? 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, phase: 0, speed: 1 }));
    this.ids = new Map(this.nodes.map((n, i) => [n.id, i]));
    this.adj = this.nodes.map(() => []);
    for (const l of data.links) {
      const a = this.ids.get(l.source), b = this.ids.get(l.target);
      if (a !== undefined && b !== undefined) { this.adj[a].push(b); this.adj[b].push(a); }
    }
    this.selected = -1; this.hidden.clear();
  }

  applySettings(_s: ConstellationSettings): void { /* nothing is drawn */ }
  setPaused(_p: boolean): void { /* nothing moves */ }
  setHover(_i: number): void { /* no canvas to highlight */ }
  setSelected(i: number, _fly = true): void { this.selected = i; }
  setActive(_i: number): void { /* no canvas to mark */ }
  setSearch(_m: Set<number> | null): void { /* the list does the filtering */ }
  setHidden(g: number, hide: boolean): void { hide ? this.hidden.add(g) : this.hidden.delete(g); }
  isHidden(g: number): boolean { return this.hidden.has(g); }
  flyTo(_i: number): void { /* no camera */ }
  resetView(): void { /* no camera */ }
  animate(): void { /* nothing to draw */ }
  supernova(): void { /* nothing to draw */ }
  get activity(): null { return null; }
  get canShow(): boolean { return false; }
  destroy(): void { this.cb.onHover(-1); }
}
