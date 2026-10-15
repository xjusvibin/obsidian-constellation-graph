import { App, Modal, Setting } from "obsidian";
import { KEY_ACTIONS, bindKey, codeFor, keyLabel, type Bindings } from "./keymap";

/** "Edit pilot keys": every flight action with the key it uses. Press Change, then the key you want. Esc cancels. */
export class KeysModal extends Modal {
  private bindings: Bindings;
  private waiting: string | null = null;
  private note!: HTMLElement;

  constructor(app: App, start: Bindings, private save: (bindings: Bindings) => void) {
    super(app);
    this.bindings = { ...start };
  }

  onOpen(): void {
    this.titleEl.setText("Pilot keys");
    this.contentEl.addClass("cg-keys-modal");
    this.contentEl.createEl("p", { text: "Select a key, then press the new one. Press escape to cancel. A few keys are kept for leaving flight." });
    this.note = this.contentEl.createDiv({ cls: "cg-keys-note", attr: { role: "status" } });
    this.draw();
    this.scope.register([], "Escape", () => { if (this.waiting) { this.waiting = null; this.say(""); this.draw(); return false; } return true; });
    this.contentEl.addEventListener("keydown", this.onKey, true);
  }

  onClose(): void {
    this.contentEl.removeEventListener("keydown", this.onKey, true);
    this.contentEl.empty();
  }

  private say(text: string): void { this.note.setText(text); }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.waiting || e.code === "Escape") return;
    e.preventDefault(); e.stopPropagation();
    const r = bindKey(this.bindings, this.waiting, e.code);
    if ("error" in r) { this.say(r.error); return; }
    this.bindings = r.bindings; this.waiting = null; this.say("");
    this.save(this.bindings);
    this.draw();
  };

  private draw(): void {
    this.contentEl.findAll(".cg-keys-list").forEach(el => el.remove());
    const list = this.contentEl.createDiv({ cls: "cg-keys-list" });
    for (const a of KEY_ACTIONS) {
      const row = new Setting(list).setName(a.label);
      const bound = a.id in this.bindings;
      row.addButton(b => b.setButtonText(this.waiting === a.id ? "Press a key…" : keyLabel(codeFor(this.bindings, a.id)))
        .setTooltip(`Change the key for ${a.label}`)
        .onClick(() => { this.waiting = this.waiting === a.id ? null : a.id; this.say(this.waiting ? `Press the key for "${a.label}"` : ""); this.draw(); }));
      if (bound) row.addExtraButton(b => b.setIcon("reset").setTooltip("Back to the usual key").onClick(() => {
        const next = { ...this.bindings }; delete next[a.id]; this.bindings = next; this.save(next); this.draw();
      }));
    }
    new Setting(list).addButton(b => b.setButtonText("Reset all keys").onClick(() => { this.bindings = {}; this.waiting = null; this.save({}); this.say("All keys are back to the usual ones."); this.draw(); }));
  }
}
