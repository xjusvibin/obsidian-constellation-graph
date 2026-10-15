import type { RoomMember } from "./room";
import type { LinkState } from "./multiplayer";
import { formatRoomCode, inviteLink, parseRoomCode } from "./netcrypto";
import type { Listing } from "./lobby";
import { SHIP_COLORS } from "./ship";
import { ROUND_PRESETS } from "./round";
import { SLOT_COLORS } from "./remote";

export interface PanelHost {
  name(): string;
  saveName(name: string): void;
  ship(): string;
  saveShip(kind: string): void;
  color(): string;
  saveColor(key: string): void;
  create(name: string): Promise<void>;
  join(code: string, name: string): Promise<void>;
  leave(): void;
  isHost(): boolean;
  startRound(key: string): void;
  isListed(): boolean;
  setListed(on: boolean): void;
  kick(id: string): void;
  /** Watch the public board of listed rooms; returns the function that stops watching. */
  browse(onRooms: (rooms: Listing[]) => void, onProblem: (text: string) => void): () => void;
}

export interface PanelState {
  code: string;
  selfId: string;
  members: RoomMember[];
  link: ReadonlyMap<string, LinkState>;
  health: ReadonlyMap<string, { hp: number; flying: boolean }>;
  score: ReadonlyMap<string, { kills: number; deaths: number }>;
  ping: ReadonlyMap<string, { ms: number; loss: number }>;
  status: string;
  error: boolean;
}

/**
 * The "Fly together" panel: say who you are, make a room (and share its code) or join one, see who is in it, and leave.
 * It says plainly, up front, what is shared and what is not.
 */
export class MultiplayerPanel {
  readonly el: HTMLDivElement;
  private nameInput: HTMLInputElement;
  private codeInput: HTMLInputElement;
  private startRow: HTMLDivElement;
  private roomRow: HTMLDivElement;
  private codeText: HTMLElement;
  private list: HTMLUListElement;
  private statusEl: HTMLDivElement;
  private helpEl: HTMLDetailsElement;
  private browseBtn: HTMLButtonElement;
  private browseEl: HTMLDivElement;
  private browseList: HTMLUListElement;
  private browseNote: HTMLDivElement;
  private stopBrowse: (() => void) | null = null;
  private roundRow: HTMLDivElement;
  private roundSelect: HTMLSelectElement;
  private listLabel: HTMLLabelElement;
  private listBox: HTMLInputElement;
  private makeBtn: HTMLButtonElement;
  private joinBtn: HTMLButtonElement;
  private busy = false;
  private code = "";
  private shipSelect: HTMLSelectElement;
  private colorSelect: HTMLSelectElement;

  constructor(parent: HTMLElement, private host: PanelHost, private onClose: () => void) {
    this.el = parent.createDiv({ cls: "cg-multiplayer", attr: { role: "dialog", "aria-label": "Fly together" } });
    this.el.hidden = true;
    const head = this.el.createDiv({ cls: "cg-multiplayer-head" });
    head.createEl("h2", { text: "Fly together" });
    const close = createEl("button", { cls: "cg-btn", text: "×", attr: { type: "button", "aria-label": "Close", title: "Close" } });
    close.addEventListener("click", () => this.onClose());
    head.appendChild(close);
    this.el.createEl("p", {
      cls: "cg-multiplayer-privacy",
      text: "Up to four pilots share one sky, each with their own constellation. What is shared: the shape of your constellation (anonymous points, links and group colours) and where your ship is. Never note titles, paths, tags or contents. Connections are set up through a public relay, with every message sealed by the room code, then pilots talk to each other directly.",
    });
    const label = this.el.createEl("label", { cls: "cg-multiplayer-name", text: "Your name" });
    this.nameInput = createEl("input", { attr: { type: "text", maxlength: "24", autocomplete: "off", spellcheck: "false" } });
    label.appendChild(this.nameInput);
    this.nameInput.addEventListener("change", () => this.host.saveName(this.nameInput.value));
    const shipLabel = this.el.createEl("label", { cls: "cg-multiplayer-name", text: "Your ship" });
    this.shipSelect = createEl("select", { attr: { "aria-label": "Your ship" } });
    for (const [value, text] of [["striker", "Striker (four wings)"], ["dart", "Dart (delta wing)"], ["bulwark", "Bulwark (heavy gunship)"]]) this.shipSelect.appendChild(createEl("option", { text, attr: { value } }));
    shipLabel.appendChild(this.shipSelect);
    this.shipSelect.addEventListener("change", () => this.host.saveShip(this.shipSelect.value));
    this.shipSelect.addEventListener("keydown", e => e.stopPropagation());
    const colorLabel = this.el.createEl("label", { cls: "cg-multiplayer-name", text: "Ship colour" });
    this.colorSelect = createEl("select", { attr: { "aria-label": "Ship colour" } });
    for (const c of SHIP_COLORS) this.colorSelect.appendChild(createEl("option", { text: c.name, attr: { value: c.key } }));
    colorLabel.appendChild(this.colorSelect);
    this.colorSelect.addEventListener("change", () => this.host.saveColor(this.colorSelect.value));
    this.colorSelect.addEventListener("keydown", e => e.stopPropagation());

    this.startRow = this.el.createDiv({ cls: "cg-multiplayer-actions" });
    this.makeBtn = createEl("button", { cls: "cg-btn", text: "Make a room", attr: { type: "button" } });
    this.codeInput = createEl("input", { cls: "cg-multiplayer-code", attr: { type: "text", placeholder: "Room code", "aria-label": "Room code", maxlength: "14", autocomplete: "off", spellcheck: "false" } });
    this.joinBtn = createEl("button", { cls: "cg-btn", text: "Join", attr: { type: "button" } });
    this.browseBtn = createEl("button", { cls: "cg-btn", text: "Browse rooms", attr: { type: "button", title: "See rooms whose hosts have listed them publicly" } });
    this.startRow.append(this.makeBtn, this.codeInput, this.joinBtn, this.browseBtn);
    this.browseBtn.addEventListener("click", () => this.toggleBrowse());
    this.makeBtn.addEventListener("click", () => void this.run(() => this.host.create(this.name())));
    this.joinBtn.addEventListener("click", () => this.tryJoin());
    this.codeInput.addEventListener("keydown", e => { if (e.key === "Enter") this.tryJoin(); e.stopPropagation(); });
    this.nameInput.addEventListener("keydown", e => e.stopPropagation());

    this.roomRow = this.el.createDiv({ cls: "cg-multiplayer-actions" });
    this.codeText = this.roomRow.createEl("strong", { cls: "cg-multiplayer-codeshow" });
    const copy = createEl("button", { cls: "cg-btn", text: "Copy code", attr: { type: "button" } });
    const leave = createEl("button", { cls: "cg-btn", text: "Leave", attr: { type: "button" } });
    const invite = createEl("button", { cls: "cg-btn", text: "Copy invite link", attr: { type: "button", title: "A link that opens Obsidian with the room code filled in" } });
    this.roomRow.append(copy, invite, leave);
    copy.addEventListener("click", () => { void navigator.clipboard?.writeText(formatRoomCode(this.code)).then(() => this.say("Room code copied. Send it to your friends.", false), () => this.say("Could not copy; select the code and copy it by hand.", true)); });
    invite.addEventListener("click", () => { void navigator.clipboard?.writeText(inviteLink(this.code)).then(() => this.say("Invite link copied. Send it to your friends: it opens Obsidian with the code filled in.", false), () => this.say("Could not copy; use Copy code instead.", true)); });
    leave.addEventListener("click", () => this.host.leave());
    this.roomRow.hidden = true;

    // the public board: rooms looking for pilots (only shown while you ask for it)
    this.browseEl = this.el.createDiv({ cls: "cg-lobby" });
    this.browseEl.hidden = true;
    this.browseEl.createEl("strong", { text: "Rooms looking for pilots" });
    this.browseNote = this.browseEl.createDiv({ cls: "cg-lobby-note", text: "Listening for rooms…" });
    this.browseList = this.browseEl.createEl("ul", { cls: "cg-lobby-list" });
    this.browseEl.createDiv({ cls: "cg-lobby-note", text: "A listed room is public: anyone can join it, and sees the host's network address as in any room. Names and codes come from strangers, so treat them that way." });

    // the host can start a round: first to a number of kills, or the most kills before the time runs out
    this.roundRow = this.el.createDiv({ cls: "cg-multiplayer-actions" });
    this.roundRow.hidden = true;
    this.roundSelect = createEl("select", { attr: { "aria-label": "Round" } });
    for (const p of ROUND_PRESETS) if (p.round) this.roundSelect.appendChild(createEl("option", { text: p.label, attr: { value: p.key } }));
    const startRound = createEl("button", { cls: "cg-btn", text: "Start round", attr: { type: "button", title: "Everyone's scores start again from nothing" } });
    startRound.addEventListener("click", () => this.host.startRound(this.roundSelect.value));
    this.roundSelect.addEventListener("keydown", e => e.stopPropagation());
    this.roundRow.append(this.roundSelect, startRound);

    // the host can put the room on the board
    this.listLabel = this.el.createEl("label", { cls: "cg-lobby-list-opt" });
    this.listBox = createEl("input", { attr: { type: "checkbox" } });
    this.listLabel.append(this.listBox, createSpan({ text: " List this room publicly (anyone can find and join it)" }));
    this.listLabel.hidden = true;
    this.listBox.addEventListener("change", () => this.host.setListed(this.listBox.checked));

    this.list = this.el.createEl("ul", { cls: "cg-multiplayer-players" });
    this.statusEl = this.el.createDiv({ cls: "cg-multiplayer-status", attr: { role: "status", "aria-live": "polite" } });
    // shown only after something goes wrong: the usual reasons, in the order worth checking
    this.helpEl = this.el.createEl("details", { cls: "cg-multiplayer-help" });
    this.helpEl.hidden = true;
    this.helpEl.createEl("summary", { text: "Can't connect? Things to check" });
    const tips = this.helpEl.createEl("ul");
    for (const t of [
      "The code must be exactly ten letters and numbers, and the pilot who made the room must still have it open (a room closes when its last pilot leaves).",
      "Both of you need internet access. The relay (ntfy.sh unless you changed it) must be reachable: try opening https://ntfy.sh in a browser. Some work or school networks block it, and you can pick another relay in the plugin's settings under Multiplayer.",
      "If you joined but the link stays on \"connecting\", one of your networks is blocking direct connections (common with VPNs and strict routers). Turn the VPN off, or add a TURN server in the Multiplayer settings.",
      "The free relay has usage limits. If it says it is limiting requests, wait a minute and try again.",
    ]) tips.createEl("li", { text: t });
  }

  private toggleBrowse(): void {
    if (this.stopBrowse) { this.endBrowse(); return; }
    this.browseEl.hidden = false; this.browseBtn.textContent = "Hide rooms";
    this.browseNote.textContent = "Listening for rooms…"; this.browseList.replaceChildren();
    this.stopBrowse = this.host.browse(rooms => this.showRooms(rooms), text => { this.browseNote.textContent = text; });
  }

  private endBrowse(): void {
    this.stopBrowse?.(); this.stopBrowse = null;
    this.browseEl.hidden = true; this.browseBtn.textContent = "Browse rooms";
  }

  private showRooms(rooms: Listing[]): void {
    this.browseNote.textContent = rooms.length ? "" : "No rooms are listed right now. Make one and list it, or share a code with friends.";
    this.browseList.replaceChildren();
    for (const r of rooms) {
      const li = this.browseList.createEl("li");
      li.createSpan({ cls: "cg-lobby-name", text: r.name });
      li.createSpan({ cls: "cg-lobby-count", text: `${r.pilots}/4` });
      const join = createEl("button", { cls: "cg-btn", text: "Join", attr: { type: "button", "aria-label": `Join ${r.name}` } });
      join.addEventListener("click", () => this.prefillJoin(r.code));
      li.appendChild(join);
    }
  }

  private name(): string { return this.nameInput.value.trim() || "Pilot"; }

  private tryJoin(): void {
    if (!parseRoomCode(this.codeInput.value)) { this.say("That is not a room code. It is ten letters and numbers, like ABCDE-FGHJK.", true); return; }
    void this.run(() => this.host.join(this.codeInput.value, this.name()));
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.setBusy(true); this.say("Connecting…", false);
    this.host.saveName(this.name());
    try { await action(); }
    catch (e) { this.say(e instanceof Error ? e.message : "Could not connect.", true); }
    finally { this.setBusy(false); }
  }

  private setBusy(b: boolean): void { this.busy = b; this.makeBtn.disabled = this.joinBtn.disabled = b; }

  say(text: string, error: boolean): void { this.statusEl.textContent = text; this.statusEl.classList.toggle("cg-error", error); this.helpEl.hidden = !error; if (!error) this.helpEl.open = false; }

  /** Fill in a room code (from an invite link) and put the cursor on Join. Nothing is joined until the reader presses it. */
  prefillJoin(code: string): void {
    this.setOpen(true);
    this.codeInput.value = formatRoomCode(code);
    this.joinBtn.focus({ preventScroll: true });
    this.say("Room code filled in. Press Join to enter the room.", false);
  }

  setOpen(open: boolean): void {
    this.el.hidden = !open;
    if (!open) this.endBrowse();
    if (open) { this.nameInput.value = this.host.name(); this.shipSelect.value = this.host.ship(); this.colorSelect.value = this.host.color(); (this.code ? this.el : this.nameInput).focus?.({ preventScroll: true }); }
  }
  get open(): boolean { return !this.el.hidden; }

  setState(s: PanelState): void {
    this.code = s.code;
    const inRoom = !!s.code && s.members.some(m => m.id === s.selfId);
    this.startRow.hidden = inRoom; this.roomRow.hidden = !inRoom;
    if (inRoom) this.endBrowse();
    const host = inRoom && this.host.isHost();
    this.listLabel.hidden = !host; this.roundRow.hidden = !host; this.listBox.checked = host && this.host.isListed();
    this.codeText.textContent = inRoom ? formatRoomCode(s.code) : "";
    this.list.replaceChildren();
    for (const m of s.members) {
      const li = this.list.createEl("li");
      const dot = li.createSpan({ cls: "cg-dot" }); const color = m.id === s.selfId ? "#7fe8ff" : SLOT_COLORS[Math.max(0, Math.min(3, m.slot))];
      dot.style.color = color; dot.style.background = color;
      li.createSpan({ cls: "cg-player-name", text: m.id === s.selfId ? `${m.name} (you)` : m.name });
      const h = s.health.get(m.id);
      const bar = li.createEl("progress", { cls: "cg-player-health", attr: { max: "100", value: String(h?.hp ?? 100), "aria-label": `${m.name} health` } });
      void bar;
      const sc = s.score.get(m.id), pg = s.ping.get(m.id), rtt = pg?.ms, lossPct = Math.round((pg?.loss ?? 0) * 100);
      li.createSpan({ cls: "cg-player-score", text: `${sc?.kills ?? 0} / ${sc?.deaths ?? 0}`, attr: { title: "Kills / deaths", "aria-label": `${sc?.kills ?? 0} kills, ${sc?.deaths ?? 0} deaths` } });
      const loss = pg?.loss ?? 0, quality = rtt === undefined ? "" : rtt >= 160 || loss >= 0.15 ? "poor" : rtt >= 80 || loss >= 0.05 ? "fair" : "good";
      li.createSpan({ cls: `cg-player-ping cg-ping-${quality}`, text: m.id === s.selfId || rtt === undefined ? "" : `${rtt} ms${lossPct >= 10 ? ` · ${lossPct}% lost` : ""}`, attr: { title: "Round-trip time to this pilot, and how many recent pings never came back. Under 80 ms feels instant; over 160 ms, or lost pings, make shots feel late." } });
      const link = m.id === s.selfId ? "here" : s.link.get(m.id) ?? "connecting";
      li.createSpan({ cls: "cg-player-state", text: link === "connected" ? (h && !h.flying ? "docked" : "flying") : link === "here" ? (h?.flying === false ? "docked" : "here") : link === "lost" ? "lost" : "connecting…" });
      if (host && m.id !== s.selfId) {
        const kick = createEl("button", { cls: "cg-btn cg-kick", text: "Remove", attr: { type: "button", "aria-label": `Remove ${m.name} from the room` } });
        kick.addEventListener("click", () => this.host.kick(m.id));
        li.appendChild(kick);
      }
    }
    if (s.status) this.say(s.status, s.error);
  }
}
