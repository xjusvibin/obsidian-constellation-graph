import { ConstellationRenderer, webglAvailable } from "./renderer";
import { FallbackRenderer } from "./fallback";
import type { GraphData, GraphRenderer, Host, RendererCallbacks } from "./types";
import { ConstellationSettings, effectiveHighContrast, effectiveMotion, prefersReducedMotion } from "./settings";
import { HOSTED_SIGNALING_URL, MultiplayerSession, type AnonymousPlayer, type GameMessage, type Pose } from "./multiplayer";
import { version as CLIENT_VERSION } from "../manifest.json";

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
  "P: Pilot mode. W A S D fly, mouse looks, Shift boosts, X brakes, click or F fires. T locks a note target, G warps to it and H returns to the hub. In a room, T marks an anonymous star and G travels there; firing and flight remain host-authoritative.",
  "R: reset the view · L: note list · /: search · Esc: clear. During multiplayer, click a star to set a travel target; notes cannot be selected or opened.",
  "Mouse: drag to orbit, scroll to zoom, click to select outside a room or set a travel target inside one, double-click or Ctrl+click to open outside a room, right-click to clear",
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
  private pilotBtn: HTMLButtonElement;
  private multiplayerBtn: HTMLButtonElement;
  private multiplayerPanel: HTMLElement;
  private multiplayerName: HTMLInputElement;
  private multiplayerConsent: HTMLInputElement;
  private multiplayerCode: HTMLInputElement;
  private multiplayerStatus: HTMLElement;
  private multiplayerService: HTMLElement;
  private multiplayerPlayers: HTMLUListElement;
  private network!: MultiplayerSession;
  private remoteIds = new Set<string>();
  private playerRows = new Map<string, { row: HTMLLIElement; health: HTMLProgressElement; state: HTMLElement }>();
  private playerStates = new Map<string, Pose>();
  private statsText = "";
  private activityKind: "animate" | "supernova" | null = null;
  private motionNote: HTMLElement;
  private data: GraphData = { nodes: [], links: [], groups: [] };
  private order: number[] = [];
  private mqs: MediaQueryList[] = [];
  private onMq = () => this.applySettings(this.settings);
  private lastAnnounce = "";

  get inRoom(): boolean { return !!this.network?.active; }

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
      onPilot: (a, text) => this.onPilot(a, text),
      onAudioMute: (which, muted) => this.host.updateSettings?.(which === "engine" ? { pilotMuteEngine: muted } : { pilotMuteAfterburner: muted }),
      onNetworkFrame: input => this.network?.sendInput(input),
      onNavigationTarget: target => { if (this.inRoom) this.multiplayerStatus.textContent = target ? `Star marked. ${this.renderer.pilotActive ? "Press G to travel there." : "Enter Pilot mode (P), then press G to travel."}` : "Navigation target cleared."; },
      onFastTravel: target => this.network?.requestFastTravel(target),
      onFire: (sequence, gun, aimPoint) => this.network?.fire(sequence, gun, aimPoint),
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
    this.pilotBtn = this.button("cg-btn", "Pilot mode: fly through your notes (P)", "\u2708\uFE0E");
    this.pilotBtn.setAttribute("aria-pressed", "false");
    this.listBtn = this.button("cg-btn", "Show note list", "\u2630");
    this.listBtn.setAttribute("aria-expanded", "false");
    this.helpBtn = this.button("cg-btn", "Keyboard help", "?");
    this.helpBtn.setAttribute("aria-expanded", "false");
    this.helpBtn.setAttribute("aria-controls", this.helpId);
    this.multiplayerBtn = this.button("cg-btn", "Multiplayer rooms", "\u2726");
    this.multiplayerBtn.setAttribute("aria-expanded", "false");
    top.append(this.search, this.pauseBtn, resetBtn, this.animBtn, this.novaBtn, this.pilotBtn, this.multiplayerBtn, this.listBtn, this.helpBtn);
    if (this.flat) { this.pauseBtn.hidden = true; resetBtn.hidden = true; this.animBtn.hidden = true; this.novaBtn.hidden = true; this.pilotBtn.hidden = true; }
    this.root.appendChild(top);
    this.multiplayerPanel = el("aside", "cg-multiplayer", { "aria-label": "Multiplayer room" });
    this.multiplayerPanel.hidden = true;
    this.multiplayerPanel.appendChild(el("h2", "", {}, "Fly together"));
    this.multiplayerService = el("p", "cg-multiplayer-service");
    this.updateRoomServiceInfo();
    this.multiplayerPanel.appendChild(this.multiplayerService);
    this.multiplayerPanel.appendChild(el("p", "cg-multiplayer-privacy", {}, "Joining shares anonymous star positions, connections and group colours. Note names, paths, tags and file contents stay on your computer. Notes cannot be selected or opened in a room; click a star to mark it, then press G to travel."));
    const nameLabel = el("label", "cg-multiplayer-name", {}, "Display name");
    this.multiplayerName = el("input", "", { type: "text", maxlength: "24", autocomplete: "nickname", "aria-label": "Display name", placeholder: "Pilot" });
    this.multiplayerName.value = settings.multiplayerName;
    nameLabel.appendChild(this.multiplayerName);
    this.multiplayerPanel.appendChild(nameLabel);
    const consentLabel = el("label", "cg-multiplayer-consent");
    this.multiplayerConsent = el("input", "", { type: "checkbox" });
    consentLabel.append(this.multiplayerConsent, document.createTextNode("I understand the shared constellation data."));
    this.multiplayerPanel.appendChild(consentLabel);
    const roomActions = el("div", "cg-multiplayer-actions");
    const createRoom = this.button("cg-btn", "Create a room", "Create room");
    this.multiplayerCode = el("input", "cg-multiplayer-code", { type: "text", placeholder: "8-character code", maxlength: "8", "aria-label": "Room code", autocomplete: "off", spellcheck: "false" });
    const joinRoom = this.button("cg-btn", "Join a room", "Join");
    const copyRoom = this.button("cg-btn", "Copy room code", "Copy code");
    const leaveRoom = this.button("cg-btn", "Leave room", "Leave");
    roomActions.append(createRoom, this.multiplayerCode, joinRoom, copyRoom, leaveRoom);
    this.multiplayerStatus = el("p", "cg-multiplayer-status", { role: "status", "aria-live": "polite" }, "Ready to connect to hosted rooms.");
    this.multiplayerPlayers = el("ul", "cg-multiplayer-players", { "aria-label": "Players in this room" });
    this.multiplayerPanel.append(roomActions, this.multiplayerStatus, this.multiplayerPlayers);
    this.root.appendChild(this.multiplayerPanel);
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
    this.pilotBtn.addEventListener("click", () => this.togglePilot());
    this.multiplayerBtn.addEventListener("click", () => {
      this.multiplayerPanel.hidden = !this.multiplayerPanel.hidden;
      this.multiplayerBtn.setAttribute("aria-expanded", String(!this.multiplayerPanel.hidden));
      if (!this.multiplayerPanel.hidden) this.multiplayerConsent.focus();
    });
    createRoom.addEventListener("click", () => void this.startRoom("create"));
    joinRoom.addEventListener("click", () => void this.startRoom("join"));
    copyRoom.addEventListener("click", () => void this.copyRoomCode());
    leaveRoom.addEventListener("click", () => this.network.leave());
    this.multiplayerName.addEventListener("change", () => {
      this.multiplayerName.value = this.multiplayerName.value.trim().slice(0, 24);
      this.host.updateSettings?.({ multiplayerName: this.multiplayerName.value });
    });
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
    this.network = new MultiplayerSession({
      status: (text, error) => { this.multiplayerStatus.textContent = text; this.multiplayerStatus.classList.toggle("cg-error", !!error); },
      members: (members, selfId) => this.onMembers(members, selfId),
      topology: (id, topology) => { this.renderer.setRemoteTopology(id, topology); this.remoteIds.add(id); },
      positions: (id, positions) => this.renderer.setRemotePositions(id, positions),
      message: (from, message) => this.onNetworkMessage(from, message),
      playerState: (id, pose) => {
        if (id === this.network?.localPlayerId) this.renderer.setAuthoritativePose(pose); else this.renderer.setRemoteShip(id, pose, this.network?.members.find(member => member.id === id)?.name ?? "Pilot");
        this.playerStates.set(id, pose);
        this.updatePlayerRow(id, pose);
      },
      shotState: (shots, impacts) => this.renderer.setRemoteShots(shots, impacts, this.network?.localPlayerId),
      removed: id => { if (id) { this.renderer.removeRemote(id); this.remoteIds.delete(id); } },
      authority: (_hostId, _epoch, _checkpoint) => { this.multiplayerStatus.textContent = "Room authority transferred. Reconnecting the shared session…"; },
    }, () => ({ data: this.data, nodes: this.renderer.nodes }), () => this.roomServiceUrl());
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
    this.network?.setLocalGraph(data);
    if (this.network?.active) this.renderer.setLocalTopology(this.network.localPlayerId, this.network.localTopology);
  }

  setActive(id: string | null): void { this.renderer.setActive(id ? this.renderer.indexOf(id) : -1); }

  applySettings(s: ConstellationSettings): void {
    this.settings = s;
    this.updateRoomServiceInfo();
    if (document.activeElement !== this.multiplayerName) this.multiplayerName.value = s.multiplayerName;
    this.renderer.applySettings(s);
    this.root.classList.toggle("cg-contrast", effectiveHighContrast(s));
    const off = effectiveMotion(s) === "off";
    const sys = s.respectReducedMotion && prefersReducedMotion();
    this.motionNote.textContent = sys ? "Motion reduced (system setting)" : off ? "Motion off" : "";
    this.motionNote.hidden = !this.motionNote.textContent;
  }

  destroy(): void {
    this.network?.leave("Graph closed; you left the room.");
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

  private async startRoom(action: "create" | "join"): Promise<void> {
    this.updateRoomServiceInfo();
    if (this.flat) { this.multiplayerStatus.textContent = "Multiplayer needs the 3D WebGL view."; this.multiplayerStatus.classList.add("cg-error"); return; }
    if (!this.multiplayerConsent.checked) { this.multiplayerStatus.textContent = "Read and check the shared data notice before joining."; this.multiplayerStatus.classList.add("cg-error"); return; }
    try {
      this.multiplayerStatus.textContent = "Connecting to the room service…"; this.multiplayerStatus.classList.remove("cg-error");
      const name = this.multiplayerName.value.trim().slice(0, 24);
      if (!name) throw new Error("Enter a display name before joining.");
      this.multiplayerName.value = name;
      this.host.updateSettings?.({ multiplayerName: name });
      if (action === "create") await this.network.create(name);
      else await this.network.join(this.multiplayerCode.value, name);
      this.multiplayerCode.value = this.network.room;
      this.network.setLocalGraph(this.data);
    } catch (e) {
      this.multiplayerStatus.textContent = e instanceof Error ? e.message : "Could not connect to the room.";
      this.multiplayerStatus.classList.add("cg-error");
    }
  }

  private roomServiceUrl(): string {
    return this.settings.multiplayerConnectionMode === "hosted" ? HOSTED_SIGNALING_URL : this.settings.multiplayerCustomServerUrl;
  }

  private updateRoomServiceInfo(): void {
    let server = "not configured";
    try { server = new URL(this.roomServiceUrl()).host; } catch { /* settings explain invalid custom URLs */ }
    const mode = this.settings.multiplayerConnectionMode === "hosted" ? "Hosted rooms" : "Custom server";
    // The version is bundled into main.js, so this identifies the code actually
    // loaded by Obsidian even if a different manifest was copied beside it.
    // Show only the host: custom URL credentials and query tokens stay private.
    this.multiplayerService.textContent = `Version ${CLIENT_VERSION} · ${mode}\nServer: ${server}`;
  }

  private async copyRoomCode(): Promise<void> {
    if (!this.network?.room) { this.multiplayerStatus.textContent = "Create or join a room first."; return; }
    try { await navigator.clipboard.writeText(this.network.room); this.multiplayerStatus.textContent = "Room code copied."; }
    catch { this.multiplayerCode.value = this.network.room; this.multiplayerCode.select(); this.multiplayerStatus.textContent = "Select and copy the room code."; }
  }

  private onMembers(members: AnonymousPlayer[], selfId: string): void {
    this.multiplayerPlayers.replaceChildren();
    this.playerRows.clear();
    for (const id of this.playerStates.keys()) if (!members.some(member => member.id === id)) this.playerStates.delete(id);
    for (const member of members) {
      const label = member.id === selfId ? `${member.name} (you)` : member.name;
      const row = el("li", "cg-player-row"); row.dataset.name = label.slice(0, 32);
      const name = el("span", "cg-player-name", {}, label.slice(0, 32));
      const health = el("progress", "cg-player-health", { max: "100", "aria-label": `${label}: waiting for health` });
      const state = el("span", "cg-player-state", {}, "Waiting for flight state");
      row.append(name, health, state);
      this.playerRows.set(member.id, { row, health, state }); this.multiplayerPlayers.appendChild(row);
      const pose = this.playerStates.get(member.id);
      if (pose) this.updatePlayerRow(member.id, pose);
    }
    const joined = !!selfId;
    this.renderer.setPlayerNames(new Map(members.filter(member => member.id !== selfId).map(member => [member.id, member.name])));
    this.renderer.setLocalTopology(joined ? selfId : "", joined ? this.network.localTopology : null);
    this.multiplayerCode.disabled = joined; this.multiplayerConsent.disabled = joined;
    this.search.disabled = joined; this.listBtn.disabled = joined;
    this.search.hidden = joined; this.listBtn.hidden = joined; this.legend.hidden = joined;
    if (joined) {
      this.renderer.clearSelection(); this.renderer.setSearch(null);
      this.search.value = ""; this.list.hidden = true; this.detail.hidden = true; this.tip.hidden = true;
      this.listBtn.setAttribute("aria-expanded", "false");
    }
    if (!joined) {
      this.renderer.setMultiplayer(false); this.renderer.setWorldOrigin(0);
      this.renderer.setLocalTopology("", null);
      for (const id of this.remoteIds) this.renderer.removeRemote(id);
      this.remoteIds.clear(); this.multiplayerConsent.checked = false;
    } else {
      const self = members.find(p => p.id === selfId);
      this.renderer.setMultiplayer(true); this.renderer.setWorldOrigin(self?.slot ?? 0);
    }
  }

  private updatePlayerRow(id: string, pose: Pose): void {
    const player = this.playerRows.get(id); if (!player) return;
    const name = player.row.dataset.name ?? "Pilot";
    player.health.value = Math.max(0, Math.min(100, pose.health));
    player.health.setAttribute("aria-label", `${name}: ${Math.round(pose.health)} of 100 health`);
    player.state.textContent = pose.health <= 0 ? `${Math.round(pose.health)} HP · respawn ${Math.ceil(pose.respawnAt / 1000)}s`
      : `${Math.round(pose.health)} HP · ${pose.active ? "flying" : "spectator"}`;
  }

  private onNetworkMessage(_from: string, message: GameMessage): void {
    if (message.type === "input") return; // The room host validates flight input before applying combat rules.
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

  private togglePilot(): void { this.renderer.setPilot(!this.renderer.pilotActive); }

  /** Pilot mode started or stopped (or could not start): mirror it on the button and tell screen readers. */
  private onPilot(active: boolean, text: string): void {
    this.pilotBtn.setAttribute("aria-pressed", String(active));
    this.pilotBtn.classList.toggle("cg-on", active);
    if (text) this.announce(text);
    if (!active) this.stage.focus({ preventScroll: true });
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
    if (this.inRoom) return;
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
    if (this.inRoom) { this.search.value = ""; this.renderer.setSearch(null); return; }
    const q = this.search.value.trim();
    this.renderer.setSearch(q ? new Set(this.matches()) : null);
    if (!this.list.hidden) this.renderList();
    if (q) this.announce(`${this.matches().length} matching notes`);
  }

  private renderList(): void {
    this.listBody.replaceChildren();
    if (this.inRoom) return;
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
    if (this.inRoom) { this.detail.hidden = true; return; }
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
    if (this.inRoom) return;
    this.renderer.setSelected(i, fly);
    this.onSelect(i);
  }

  private onSelect(i: number): void {
    if (this.inRoom) { this.detail.hidden = true; return; }
    if (i < 0) { this.detail.hidden = true; this.announce("Selection cleared"); return; }
    this.showDetail(i);
    const n = this.renderer.nodes[i], g = this.data.groups[n.gi];
    this.announce(`${n.name}. ${g?.label ?? ""}. ${this.links(n)}. Press Enter to open.`);
  }

  private onHover(i: number): void {
    if (this.inRoom) { this.tip.hidden = true; return; }
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
    if (this.inRoom) return;
    const n = this.renderer.nodes[i]; if (n) this.host.openNote(n.id, newTab);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.inRoom) {
      if (e.key === "p" || e.key === "P") this.togglePilot();
      else if (e.key === "Escape") this.renderer.clearSelection();
      else if (e.key === "?") this.setHelp(this.help.hidden);
      else return;
      e.preventDefault(); return;
    }
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
      case "p": case "P": this.togglePilot(); break;
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
