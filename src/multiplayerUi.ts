import type { RoomMember } from "./room";
import type { LinkState } from "./multiplayer";
import { formatRoomCode, parseRoomCode } from "./netcrypto";
import { SLOT_COLORS } from "./remote";

export interface PanelHost {
  name(): string;
  saveName(name: string): void;
  ship(): string;
  saveShip(kind: string): void;
  create(name: string): Promise<void>;
  join(code: string, name: string): Promise<void>;
  leave(): void;
}

export interface PanelState {
  code: string;
  selfId: string;
  members: RoomMember[];
  link: ReadonlyMap<string, LinkState>;
  health: ReadonlyMap<string, { hp: number; flying: boolean }>;
  score: ReadonlyMap<string, { kills: number; deaths: number }>;
  ping: ReadonlyMap<string, number>;
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
  private makeBtn: HTMLButtonElement;
  private joinBtn: HTMLButtonElement;
  private busy = false;
  private code = "";
  private shipSelect: HTMLSelectElement;

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

    this.startRow = this.el.createDiv({ cls: "cg-multiplayer-actions" });
    this.makeBtn = createEl("button", { cls: "cg-btn", text: "Make a room", attr: { type: "button" } });
    this.codeInput = createEl("input", { cls: "cg-multiplayer-code", attr: { type: "text", placeholder: "Room code", "aria-label": "Room code", maxlength: "14", autocomplete: "off", spellcheck: "false" } });
    this.joinBtn = createEl("button", { cls: "cg-btn", text: "Join", attr: { type: "button" } });
    this.startRow.append(this.makeBtn, this.codeInput, this.joinBtn);
    this.makeBtn.addEventListener("click", () => void this.run(() => this.host.create(this.name())));
    this.joinBtn.addEventListener("click", () => this.tryJoin());
    this.codeInput.addEventListener("keydown", e => { if (e.key === "Enter") this.tryJoin(); e.stopPropagation(); });
    this.nameInput.addEventListener("keydown", e => e.stopPropagation());

    this.roomRow = this.el.createDiv({ cls: "cg-multiplayer-actions" });
    this.codeText = this.roomRow.createEl("strong", { cls: "cg-multiplayer-codeshow" });
    const copy = createEl("button", { cls: "cg-btn", text: "Copy code", attr: { type: "button" } });
    const leave = createEl("button", { cls: "cg-btn", text: "Leave", attr: { type: "button" } });
    this.roomRow.append(copy, leave);
    copy.addEventListener("click", () => { void navigator.clipboard?.writeText(formatRoomCode(this.code)).then(() => this.say("Room code copied. Send it to your friends.", false), () => this.say("Could not copy; select the code and copy it by hand.", true)); });
    leave.addEventListener("click", () => this.host.leave());
    this.roomRow.hidden = true;

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

  setOpen(open: boolean): void {
    this.el.hidden = !open;
    if (open) { this.nameInput.value = this.host.name(); this.shipSelect.value = this.host.ship(); (this.code ? this.el : this.nameInput).focus?.({ preventScroll: true }); }
  }
  get open(): boolean { return !this.el.hidden; }

  setState(s: PanelState): void {
    this.code = s.code;
    const inRoom = !!s.code && s.members.some(m => m.id === s.selfId);
    this.startRow.hidden = inRoom; this.roomRow.hidden = !inRoom;
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
      const sc = s.score.get(m.id), rtt = s.ping.get(m.id);
      li.createSpan({ cls: "cg-player-score", text: `${sc?.kills ?? 0} / ${sc?.deaths ?? 0}`, attr: { title: "Kills / deaths", "aria-label": `${sc?.kills ?? 0} kills, ${sc?.deaths ?? 0} deaths` } });
      const quality = rtt === undefined ? "" : rtt < 80 ? "good" : rtt < 160 ? "fair" : "poor";
      li.createSpan({ cls: `cg-player-ping cg-ping-${quality}`, text: m.id === s.selfId || rtt === undefined ? "" : `${rtt} ms`, attr: { title: "Round-trip time to this pilot. Under 80 ms feels instant; over 160 ms makes shots feel late." } });
      const link = m.id === s.selfId ? "here" : s.link.get(m.id) ?? "connecting";
      li.createSpan({ cls: "cg-player-state", text: link === "connected" ? (h && !h.flying ? "docked" : "flying") : link === "here" ? (h?.flying === false ? "docked" : "here") : link === "lost" ? "lost" : "connecting…" });
    }
    if (s.status) this.say(s.status, s.error);
  }
}
