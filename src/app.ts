import { ConstellationRenderer, webglAvailable } from "./renderer";
import { FallbackRenderer } from "./fallback";
import type { GraphData, GraphRenderer, Host, RendererCallbacks } from "./types";
import { ConstellationSettings, effectiveHighContrast, effectiveMotion, prefersReducedMotion } from "./settings";

let instances = 0;

type Attrs = Record<string, string>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, attrs: Attrs = {}, text?: string): HTMLElementTagNameMap[K] {
  return createEl(tag, { cls: cls || undefined, attr: attrs, text });
}

const HELP = [
  "Arrow Left / Right: previous or next note",
  "Arrow Up / Down: step through the selected note's connections",
  "Enter: open the selected note (Shift+Enter: new tab)",
  "Space: pause or resume motion",
  "A: animate, watching notes appear in the order they were created",
  "N: supernova, collapse everything, explode it and let it re-settle",
  "R: reset the view · L: note list · /: search · Esc: clear",
  "Mouse: drag to orbit, scroll to zoom, click to select, double-click or Ctrl+click to open",
];

export class ConstellationApp {
  private root: HTMLElement;
  private stage: HTMLElement;
  private renderer: GraphRenderer;
  private flat = false; // true when WebGL is unavailable and only the list UI is shown
  private helpId: string;
  private helpBtn: HTMLButtonElement;
  private search: HTMLInputElement;
  private stats: HTMLElement;
  private legend: HTMLElement;
  private detail: HTMLElement;
  private list: HTMLElement;
  private listBody: HTMLElement;
  private live: HTMLElement;
  private help: HTMLElement;
  private tip: HTMLElement;
  private pauseBtn: HTMLButtonElement;
  private listBtn: HTMLButtonElement;
  private animBtn: HTMLButtonElement;
  private novaBtn: HTMLButtonElement;
  private statsText = "";
  private activityKind: "animate" | "supernova" | null = null;
  private motionNote: HTMLElement;
  private data: GraphData = { nodes: [], links: [], groups: [] };
  private order: number[] = [];
  private mqs: MediaQueryList[] = [];
  private onMq = () => this.applySettings(this.settings);
  private lastAnnounce = "";

  constructor(parent: HTMLElement, private host: Host, private settings: ConstellationSettings) {
    this.helpId = "cg-help-" + ++instances;
    this.root = el("div", "cg-root", { role: "region", "aria-label": "Constellation graph of your notes" });
    parent.appendChild(this.root);

    this.stage = el("div", "cg-stage", {
      tabindex: "0", role: "application", "aria-roledescription": "3D graph",
      "aria-label": "Notes graph. Press question mark for keyboard help.", "aria-describedby": this.helpId,
    });
    this.root.appendChild(this.stage);
    this.root.appendChild(el("div", "cg-vignette", { "aria-hidden": "true" }));

    const callbacks: RendererCallbacks = {
      onHover: i => this.onHover(i),
      onSelect: i => this.onSelect(i),
      onOpen: (i, t) => this.openIndex(i, t),
      onActivity: (k, text) => this.onActivity(k, text),
    };
    let made: GraphRenderer | null = null;
    if (webglAvailable()) {
      try { made = new ConstellationRenderer(this.stage, callbacks, settings); }
      catch (e) { console.warn("Constellation Graph: the 3D view could not start", e); }
    }
    this.flat = !made;
    this.renderer = made ?? new FallbackRenderer(callbacks);

    // toolbar
    const top = el("div", "cg-top", { role: "toolbar", "aria-label": "Graph controls" });
    this.search = el("input", "cg-search", { type: "search", placeholder: "Search notes…", "aria-label": "Search notes", autocomplete: "off", spellcheck: "false" });
    this.pauseBtn = this.button("cg-btn", "Pause motion", "⏸");
    const resetBtn = this.button("cg-btn", "Reset view", "⌖");
    this.animBtn = this.button("cg-btn", "Animate: watch the notes appear in the order they were created", "\u23F1");
    this.animBtn.setAttribute("aria-pressed", "false");
    this.novaBtn = this.button("cg-btn", "Supernova: collapse the graph, explode it and let it re-settle", "\u273A");
    this.novaBtn.setAttribute("aria-pressed", "false");
    this.listBtn = this.button("cg-btn", "Show note list", "\u2630");
    this.listBtn.setAttribute("aria-expanded", "false");
    this.helpBtn = this.button("cg-btn", "Keyboard help", "?");
    this.helpBtn.setAttribute("aria-expanded", "false");
    this.helpBtn.setAttribute("aria-controls", this.helpId);
    top.append(this.search, this.pauseBtn, resetBtn, this.animBtn, this.novaBtn, this.listBtn, this.helpBtn);
    if (this.flat) { this.pauseBtn.hidden = true; resetBtn.hidden = true; this.animBtn.hidden = true; this.novaBtn.hidden = true; }
    this.root.appendChild(top);
    this.stats = el("div", "cg-stats");
    this.motionNote = el("div", "cg-motion-note");
    this.root.append(this.stats, this.motionNote);

    this.legend = el("ul", "cg-legend", { "aria-label": "Groups. Toggle to show or hide." });
    this.root.appendChild(this.legend);

    this.detail = el("aside", "cg-detail", { "aria-label": "Selected note" });
    this.detail.hidden = true;
    this.root.appendChild(this.detail);

    this.list = el("aside", "cg-list", { "aria-label": "Notes list" });
    this.list.hidden = true;
    this.listBody = el("ul", "cg-list-body");
    this.list.appendChild(this.listBody);
    this.root.appendChild(this.list);

    this.help = el("div", "cg-help", { id: this.helpId, role: "note" });
    this.help.hidden = true;
    HELP.forEach(t => this.help.appendChild(el("p", "", {}, t)));
    this.root.appendChild(this.help);

    if (this.flat) {
      this.root.appendChild(el("div", "cg-notice", { role: "status" },
        "The 3D view needs WebGL, which is not available here. Search, the note list and the details panel still work."));
    }

    this.live = el("div", "cg-sr", { "aria-live": "polite", "aria-atomic": "true", role: "status" });
    this.root.appendChild(this.live);
    this.tip = el("div", "cg-tip", { "aria-hidden": "true" });
    this.tip.hidden = true;
    this.root.appendChild(this.tip);

    this.pauseBtn.addEventListener("click", () => this.togglePause());
    resetBtn.addEventListener("click", () => this.renderer.resetView());
    this.listBtn.addEventListener("click", () => this.toggleList());
    this.animBtn.addEventListener("click", () => this.renderer.animate());
    this.novaBtn.addEventListener("click", () => this.renderer.supernova());
    this.helpBtn.addEventListener("click", () => this.setHelp(this.help.hidden));
    this.search.addEventListener("input", () => this.runSearch());
    this.search.addEventListener("keydown", e => {
      if (e.key === "Enter") { const first = this.firstMatch(); if (first >= 0) this.selectIndex(first, true); }
      if (e.key === "Escape") { this.search.value = ""; this.runSearch(); this.stage.focus(); }
      // plain typing stays in the box; Ctrl/Cmd shortcuts (command palette etc.) still reach Obsidian
      if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
    });
    this.stage.addEventListener("keydown", this.onKey);
    this.root.addEventListener("keydown", this.onRootKey);
    this.stage.addEventListener("pointermove", this.onTipMove);
    this.stage.addEventListener("pointerleave", () => { this.tip.hidden = true; });

    if (typeof matchMedia === "function") {
      this.mqs = [matchMedia("(prefers-reduced-motion: reduce)"), matchMedia("(prefers-contrast: more)")];
      this.mqs.forEach(m => m.addEventListener("change", this.onMq));
    }
    this.applySettings(settings);
    if (this.flat) this.toggleList(true);
  }

  // ----------------------------------------------------------------- public

  setData(data: GraphData): void {
    const r = this.renderer;
    // a live refresh must not undo what the reader is doing
    const selId = r.selectedIndex >= 0 ? r.nodes[r.selectedIndex]?.id ?? null : null;
    const hiddenKeys = new Set(this.data.groups.filter((_, i) => r.isHidden(i)).map(g => g.key));
    this.data = data;
    this.lastNeighbor = -1;
    r.setData(data);
    data.groups.forEach((g, i) => { if (hiddenKeys.has(g.key)) r.setHidden(i, true); });
    this.order = r.nodes.map((_, i) => i).sort((a, b) => {
      const A = r.nodes[a], B = r.nodes[b];
      return A.gi - B.gi || A.name.localeCompare(B.name);
    });
    this.statsText = `${data.nodes.length} notes \u00b7 ${data.links.length} links`;
    if (!this.activityKind) this.stats.textContent = this.statsText;
    this.buildLegend();
    const idx = selId ? r.indexOf(selId) : -1;
    r.setSelected(idx, false);
    if (idx >= 0) this.showDetail(idx); else this.detail.hidden = true;
    this.runSearch();
  }

  setActive(id: string | null): void { this.renderer.setActive(id ? this.renderer.indexOf(id) : -1); }

  applySettings(s: ConstellationSettings): void {
    this.settings = s;
    this.renderer.applySettings(s);
    this.root.classList.toggle("cg-contrast", effectiveHighContrast(s));
    const off = effectiveMotion(s) === "off";
    const sys = s.respectReducedMotion && prefersReducedMotion();
    this.motionNote.textContent = sys ? "Motion reduced (system setting)" : off ? "Motion off" : "";
    this.motionNote.hidden = !this.motionNote.textContent;
  }

  destroy(): void {
    this.mqs.forEach(m => m.removeEventListener("change", this.onMq));
    this.renderer.destroy();
    this.root.remove();
  }

  focus(): void { this.stage.focus(); }

  // ----------------------------------------------------------------- UI pieces

  private button(cls: string, label: string, glyph: string): HTMLButtonElement {
    const b = el("button", cls, { type: "button", "aria-label": label, title: label }, glyph);
    return b;
  }

  private buildLegend(): void {
    // a live refresh rebuilds this list; keep keyboard focus on the same row instead of dropping it
    const focused = this.legend.contains(document.activeElement) ? [...this.legend.querySelectorAll("button")].indexOf(document.activeElement as HTMLButtonElement) : -1;
    this.legend.replaceChildren();
    this.data.groups.forEach((g, i) => {
      const li = el("li", "cg-legend-item");
      const off = this.renderer.isHidden(i);
      const b = el("button", "cg-legend-btn" + (off ? " cg-off" : ""), { type: "button", "aria-pressed": String(!off), title: `Show or hide ${g.label}` });
      const dot = el("span", "cg-dot"); dot.style.color = g.color; dot.style.background = g.color;
      b.append(dot, el("span", "cg-legend-label", {}, g.label), el("span", "cg-legend-count", {}, String(g.count)));
      b.addEventListener("click", () => {
        const hide = !this.renderer.isHidden(i);
        this.renderer.setHidden(i, hide);
        b.setAttribute("aria-pressed", String(!hide));
        b.classList.toggle("cg-off", hide);
        this.announce(`${g.label} ${hide ? "hidden" : "shown"}`);
      });
      li.appendChild(b); this.legend.appendChild(li);
    });
    if (focused >= 0) (this.legend.querySelectorAll("button")[focused] as HTMLButtonElement | undefined)?.focus({ preventScroll: true });
  }

  private setHelp(show: boolean): void {
    this.help.hidden = !show;
    this.helpBtn.setAttribute("aria-expanded", String(show));
  }

  /** A timed show started, moved on, or ended: reflect it on the buttons and the counter, and tell screen readers. */
  private onActivity(kind: "animate" | "supernova" | null, text: string): void {
    const progress = kind === "animate" && this.activityKind === "animate"; // the counter ticks; do not read every step aloud
    this.activityKind = kind;
    this.animBtn.setAttribute("aria-pressed", String(kind === "animate"));
    this.novaBtn.setAttribute("aria-pressed", String(kind === "supernova"));
    this.animBtn.classList.toggle("cg-on", kind === "animate");
    this.novaBtn.classList.toggle("cg-on", kind === "supernova");
    this.stats.textContent = kind ? text : this.statsText;
    if (text && !progress) this.announce(text);
  }

  private togglePause(): void {
    const p = !this.renderer.isPaused;
    this.renderer.setPaused(p);
    this.pauseBtn.textContent = p ? "▶" : "⏸";
    this.pauseBtn.setAttribute("aria-label", p ? "Resume motion" : "Pause motion");
    this.pauseBtn.title = p ? "Resume motion" : "Pause motion";
    this.announce(p ? "Motion paused" : "Motion resumed");
  }

  private toggleList(force?: boolean): void {
    const show = force ?? this.list.hidden;
    this.list.hidden = !show;
    this.listBtn.setAttribute("aria-expanded", String(show));
    this.listBtn.setAttribute("aria-label", show ? "Hide note list" : "Show note list");
    if (show) this.renderList();
  }

  private matches(): number[] {
    const q = this.search.value.trim().toLowerCase();
    const nodes = this.renderer.nodes;
    const idx = nodes.map((_, i) => i).filter(i => !q || nodes[i].name.toLowerCase().includes(q));
    return idx.sort((a, b) => nodes[b].deg - nodes[a].deg || nodes[a].name.localeCompare(nodes[b].name));
  }

  private firstMatch(): number { return this.matches()[0] ?? -1; }

  private runSearch(): void {
    const q = this.search.value.trim();
    this.renderer.setSearch(q ? new Set(this.matches()) : null);
    if (!this.list.hidden) this.renderList();
    if (q) this.announce(`${this.matches().length} matching notes`);
  }

  private renderList(): void {
    this.listBody.replaceChildren();
    const nodes = this.renderer.nodes, all = this.matches(), LIMIT = 150;
    for (const i of all.slice(0, LIMIT)) {
      const n = nodes[i], g = this.data.groups[n.gi];
      const li = el("li", "cg-list-item");
      const b = el("button", "cg-list-btn", { type: "button" });
      const dot = el("span", "cg-dot"); dot.style.color = g?.color ?? "#8b93a7"; dot.style.background = g?.color ?? "#8b93a7";
      b.append(dot, el("span", "cg-list-name", {}, n.name), el("span", "cg-list-deg", {}, `${n.deg}`));
      b.addEventListener("click", () => this.selectIndex(i, true));
      b.addEventListener("mouseenter", () => this.renderer.setHover(i));
      b.addEventListener("mouseleave", () => this.renderer.setHover(-1));
      b.addEventListener("focus", () => this.renderer.setHover(i));
      b.addEventListener("blur", () => this.renderer.setHover(-1));
      li.appendChild(b); this.listBody.appendChild(li);
    }
    if (!all.length) this.listBody.appendChild(el("li", "cg-list-empty", {}, nodes.length ? "No matching notes" : "No notes to show yet"));
    else if (all.length > LIMIT) this.listBody.appendChild(el("li", "cg-list-empty", {}, `Showing the ${LIMIT} most-linked of ${all.length} notes. Type to narrow the list.`));
  }

  private links(n: { deg: number }): string { return `${n.deg} ${n.deg === 1 ? "link" : "links"}`; }

  private showDetail(i: number): void {
    const n = this.renderer.nodes[i]; if (!n) { this.detail.hidden = true; return; }
    const g = this.data.groups[n.gi];
    const hadFocus = this.detail.contains(document.activeElement); // the buttons below are about to be replaced
    this.detail.replaceChildren();
    const head = el("div", "cg-detail-head");
    const close = this.button("cg-btn cg-close", "Close details", "×");
    close.addEventListener("click", () => { this.selectIndex(-1, false); this.stage.focus(); });
    const title = el("h2", "cg-detail-title", { tabindex: "-1" }, n.name);
    head.append(title, close);
    const meta = el("div", "cg-detail-meta");
    const dot = el("span", "cg-dot"); dot.style.color = g?.color ?? "#8b93a7"; dot.style.background = g?.color ?? "#8b93a7";
    meta.append(dot, el("span", "", {}, `${g?.label ?? ""} · ${this.links(n)}`));
    const actions = el("div", "cg-detail-actions");
    const open = el("button", "cg-primary", { type: "button" }, "Open note");
    const tab = el("button", "cg-secondary", { type: "button" }, "Open in new tab");
    open.addEventListener("click", () => this.openIndex(i, false));
    tab.addEventListener("click", () => this.openIndex(i, true));
    actions.append(open, tab);
    this.detail.append(head, meta, actions);
    const nb = [...this.renderer.neighbors(i)].sort((a, b) => this.renderer.nodes[b].deg - this.renderer.nodes[a].deg);
    if (nb.length) {
      this.detail.appendChild(el("h3", "cg-detail-sub", {}, "Connected notes"));
      const ul = el("ul", "cg-chips");
      nb.slice(0, 14).forEach(j => {
        const li = el("li", ""), b = el("button", "cg-chip", { type: "button" }, this.renderer.nodes[j].name);
        b.addEventListener("click", () => this.selectIndex(j, true));
        li.appendChild(b); ul.appendChild(li);
      });
      this.detail.appendChild(ul);
      if (nb.length > 14) this.detail.appendChild(el("p", "cg-more", {}, `and ${nb.length - 14} more`));
    }
    this.detail.hidden = false;
    if (hadFocus) title.focus({ preventScroll: true }); // keep keyboard users in the panel after choosing a connection
  }

  // ----------------------------------------------------------------- behaviour

  private selectIndex(i: number, fly: boolean): void {
    this.renderer.setSelected(i, fly);
    this.onSelect(i);
  }

  private onSelect(i: number): void {
    if (i < 0) { this.detail.hidden = true; this.announce("Selection cleared"); return; }
    this.showDetail(i);
    const n = this.renderer.nodes[i], g = this.data.groups[n.gi];
    this.announce(`${n.name}. ${g?.label ?? ""}. ${this.links(n)}. Press Enter to open.`);
  }

  private onHover(i: number): void {
    if (i < 0) { this.tip.hidden = true; return; }
    const n = this.renderer.nodes[i], g = this.data.groups[n.gi];
    this.tip.replaceChildren(el("strong", "", {}, n.name), el("span", "", {}, `${g?.label ?? ""} · ${this.links(n)}`));
    this.tip.hidden = false;
  }

  private onTipMove = (e: PointerEvent) => {
    const r = this.root.getBoundingClientRect();
    this.tip.style.left = Math.min(r.width - 200, e.clientX - r.left + 16) + "px";
    this.tip.style.top = Math.min(r.height - 50, e.clientY - r.top + 16) + "px";
  };

  private openIndex(i: number, newTab: boolean): void {
    const n = this.renderer.nodes[i]; if (n) this.host.openNote(n.id, newTab);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const sel = this.renderer.selectedIndex;
    const stepOrder = (d: number) => {
      if (!this.order.length) return;
      const pos = sel >= 0 ? this.order.indexOf(sel) : -1;
      const next = this.order[(pos + d + this.order.length) % this.order.length];
      this.selectIndex(next, true);
    };
    const stepNeighbor = (d: number) => {
      if (sel < 0) { stepOrder(d); return; }
      const nb = [...this.renderer.neighbors(sel)].sort((a, b) => this.renderer.nodes[b].deg - this.renderer.nodes[a].deg);
      if (!nb.length) { this.announce("This note has no connections"); return; }
      const cur = nb.indexOf(this.lastNeighbor);
      const next = nb[((cur < 0 ? (d > 0 ? -1 : 0) : cur) + d + nb.length) % nb.length];
      const from = sel;
      this.selectIndex(next, true);
      this.lastNeighbor = from;
    };
    switch (e.key) {
      case "ArrowRight": stepOrder(1); break;
      case "ArrowLeft": stepOrder(-1); break;
      case "ArrowDown": stepNeighbor(1); break;
      case "ArrowUp": stepNeighbor(-1); break;
      case "Enter": if (sel >= 0) this.openIndex(sel, e.shiftKey); else return; break;
      case " ": this.togglePause(); break;
      case "a": case "A": this.renderer.animate(); break;
      case "n": case "N": this.renderer.supernova(); break;
      case "Escape": if (!this.help.hidden) this.setHelp(false); else this.selectIndex(-1, false); break;
      case "r": case "R": this.renderer.resetView(); break;
      case "l": case "L": this.toggleList(); break;
      case "/": this.search.focus(); break;
      case "?": this.setHelp(this.help.hidden); break;
      default: return;
    }
    e.preventDefault();
  };

  /** Escape from inside any panel closes it and returns focus to the graph. */
  private onRootKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const t = e.target as Node;
    if (this.stage.contains(t) || t === this.search) return; // the graph and the search box handle their own Escape
    if (this.list.contains(t)) this.toggleList(false);
    else if (this.detail.contains(t)) this.selectIndex(-1, false);
    else if (this.help.contains(t)) this.setHelp(false);
    this.stage.focus();
    e.preventDefault();
  };

  private lastNeighbor = -1;

  private announce(text: string): void {
    if (text === this.lastAnnounce) text += "​"; // let screen readers re-read an identical message
    this.lastAnnounce = text;
    this.live.textContent = text;
  }
}
