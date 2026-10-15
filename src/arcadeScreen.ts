import { NAME_MAX, cleanScoreName, insertScore, qualifies, runScore, type ScoreEntry } from "./arcade";

/** What the arcade screen needs from the plugin: the saved table, a place to save it, and (optionally) the public board. */
export interface ArcadeBackend {
  table(): ScoreEntry[];
  lastName(): string;
  save(table: ScoreEntry[], name: string): void;
  /** Whether the public board can be used at all (needs network access). */
  online(): boolean;
  submit(entry: ScoreEntry): Promise<void>;
  watch(onRows: (rows: ScoreEntry[]) => void, onProblem: (text: string) => void): () => void;
}

export interface RunResult { waves: number; kills: number }

/**
 * The screen at the end of an arcade run, in the manner of an old cabinet: GAME OVER, a name entry when the score makes the table,
 * the high-score table with the new score flashing, and buttons to play again, share the score, or close.
 */
export class ArcadeScreen {
  private el: HTMLDivElement;
  private body: HTMLDivElement;
  private stopWatch: (() => void) | null = null;
  private result: RunResult = { waves: 0, kills: 0 };
  private entry: ScoreEntry | null = null;
  private shown = false;

  constructor(parent: HTMLElement, private backend: ArcadeBackend | undefined, private hooks: { again(): void; close(): void }) {
    this.el = parent.createDiv({ cls: "cg-arcade cg-hidden", attr: { role: "dialog", "aria-label": "Arcade high scores" } });
    this.body = this.el.createDiv({ cls: "cg-arcade-body" });
  }

  get visible(): boolean { return this.shown; }

  show(result: RunResult): void {
    this.result = result; this.entry = null; this.shown = true;
    this.el.classList.remove("cg-hidden");
    const score = runScore(result.waves, result.kills), table = this.backend?.table() ?? [];
    if (this.backend && qualifies(table, score)) this.askName(score);
    else this.showTable(null, false);
  }

  hide(): void {
    this.shown = false; this.stopWatch?.(); this.stopWatch = null;
    this.el.classList.add("cg-hidden"); this.body.empty();
  }

  private line(text: string, cls = ""): HTMLDivElement { return this.body.createDiv({ cls: "cg-arcade-line " + cls, text }); }

  private head(): void {
    this.body.empty();
    this.line("GAME OVER", "cg-arcade-title");
    this.line(`WAVES CLEARED  ${this.result.waves}`);
    this.line(`DRONES SHOT    ${this.result.kills}`);
    this.line(`SCORE          ${runScore(this.result.waves, this.result.kills)}`, "cg-arcade-score");
  }

  private askName(score: number): void {
    this.head();
    this.line("NEW HIGH SCORE!  ENTER YOUR NAME", "cg-arcade-blink");
    const input = createEl("input", { cls: "cg-arcade-input", attr: { type: "text", maxlength: String(NAME_MAX), "aria-label": "Your name for the high score table", spellcheck: "false", autocomplete: "off" } });
    input.value = cleanScoreName(this.backend?.lastName() ?? "");
    this.body.appendChild(input);
    const row = this.body.createDiv({ cls: "cg-arcade-buttons" });
    const save = createEl("button", { cls: "cg-arcade-btn", text: "SAVE", attr: { type: "button" } });
    row.appendChild(save);
    const done = () => {
      const name = cleanScoreName(input.value);
      const entry: ScoreEntry = { name, score, waves: this.result.waves, kills: this.result.kills, at: Date.now() };
      const r = insertScore(this.backend?.table() ?? [], entry);
      this.backend?.save(r.table, name);
      this.entry = entry;
      this.showTable(entry, true);
    };
    save.addEventListener("click", done);
    input.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") done(); });
    window.setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  private showTable(mine: ScoreEntry | null, saved: boolean): void {
    this.head();
    const table = this.backend?.table() ?? [];
    this.line("HIGH SCORES  (THIS COMPUTER)", "cg-arcade-sub");
    this.drawRows(this.body.createDiv({ cls: "cg-arcade-rows" }), table, mine);
    if (!table.length) this.line("NO SCORES YET", "cg-arcade-dim");
    this.buttons(saved);
  }

  private drawRows(host: HTMLElement, rows: readonly ScoreEntry[], mine: ScoreEntry | null): void {
    host.empty();
    rows.forEach((r, i) => {
      const row = host.createDiv({ cls: "cg-arcade-row" + (mine && r.at === mine.at && r.name === mine.name && r.score === mine.score ? " cg-arcade-mine" : "") });
      row.createSpan({ cls: "cg-arcade-rank", text: String(i + 1).padStart(2, "0") });
      row.createSpan({ cls: "cg-arcade-name", text: r.name });
      row.createSpan({ cls: "cg-arcade-waves", text: `W${r.waves}` });
      row.createSpan({ cls: "cg-arcade-pts", text: String(r.score) });
    });
  }

  private buttons(saved: boolean): void {
    const row = this.body.createDiv({ cls: "cg-arcade-buttons" });
    const mk = (text: string, on: () => void, title = "") => { const b = createEl("button", { cls: "cg-arcade-btn", text, attr: { type: "button", title } }); b.addEventListener("click", on); row.appendChild(b); return b; };
    mk("PLAY AGAIN", () => { this.hide(); this.hooks.again(); });
    if (this.backend?.online()) {
      if (saved && this.entry) {
        const send = mk("Submit score", () => {
          const e = this.entry; if (!e) return;
          send.disabled = true; send.textContent = "Sending...";
          this.backend?.submit(e).then(() => { send.textContent = "SUBMITTED"; }, (err: unknown) => { send.disabled = false; send.textContent = "Submit score"; this.note(err instanceof Error ? err.message : "Could not send the score."); });
        }, `Sends only your name (${this.entry.name}) and your score to the public board. Anyone can read it; scores there are not verified.`);
      }
      mk("PUBLIC BOARD", () => this.showPublic(), "The recent scores other pilots have shared (kept about twelve hours; not verified)");
    }
    mk("CLOSE", () => { this.hide(); this.hooks.close(); });
    this.noteEl = this.body.createDiv({ cls: "cg-arcade-note", attr: { role: "status" } });
    if (saved && this.backend?.online()) this.note("Submitting is optional: it sends only your name and score.");
  }

  private noteEl: HTMLDivElement | null = null;
  private note(text: string): void { this.noteEl?.setText(text); }

  private showPublic(): void {
    this.stopWatch?.();
    this.head();
    this.line("PUBLIC BOARD  (RECENT, UNVERIFIED)", "cg-arcade-sub");
    const rows = this.body.createDiv({ cls: "cg-arcade-rows" });
    const wait = this.line("LISTENING...", "cg-arcade-dim");
    let got = false;
    this.stopWatch = this.backend?.watch(list => { got = true; wait.remove(); this.drawRows(rows, list, null); }, text => this.note(text)) ?? null;
    window.setTimeout(() => { if (!got && this.shown) wait.setText("No scores heard yet"); }, 6000);
    const row = this.body.createDiv({ cls: "cg-arcade-buttons" });
    const back = createEl("button", { cls: "cg-arcade-btn", text: "BACK", attr: { type: "button" } });
    back.addEventListener("click", () => { this.stopWatch?.(); this.stopWatch = null; this.showTable(this.entry, !!this.entry); });
    row.appendChild(back);
    this.noteEl = this.body.createDiv({ cls: "cg-arcade-note", attr: { role: "status" } });
  }
}
