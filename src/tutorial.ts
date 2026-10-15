/** The first-flight tips: a short checklist shown the first time you fly alone. Each step finishes when you do the thing it asks. */
export type TipEvent = "thrust" | "steer" | "fire" | "boost" | "kill";

export const TIP_STEPS: { event: TipEvent; text: string }[] = [
  { event: "thrust", text: "Hold W (or push the left stick) to fly forward" },
  { event: "steer", text: "Move the mouse (or the right stick) to steer" },
  { event: "fire", text: "Click, or press F, to fire" },
  { event: "boost", text: "Hold Shift for the afterburner" },
  { event: "kill", text: "Shoot down a red drone" },
];

export const TIP_DONE = "That is the basics. Press K any time to see every control.";

export class Tutorial {
  private at = 0;
  constructor(private onChange: (text: string, done: boolean) => void) {}

  get done(): boolean { return this.at >= TIP_STEPS.length; }
  get text(): string { return this.done ? TIP_DONE : `${this.at + 1} of ${TIP_STEPS.length}: ${TIP_STEPS[this.at].text}`; }

  start(): void { this.at = 0; this.onChange(this.text, false); }

  /** Something happened in flight. Only the step being asked for counts; doing things out of order is fine and not remembered. */
  note(event: TipEvent): void {
    if (this.done || TIP_STEPS[this.at].event !== event) return;
    this.at++;
    this.onChange(this.text, this.done);
  }
}
