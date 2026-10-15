/** Packet loss as the pilot would feel it: of the last few pings sent to a pilot, how many never came back. */
export class LossMeter {
  private sent: number[] = []; // sequence numbers, oldest first
  private answered = new Set<number>();
  constructor(private window = 20) {}

  /** A ping with this number went out. */
  ping(seq: number): void {
    this.sent.push(seq);
    while (this.sent.length > this.window) this.answered.delete(this.sent.shift()!);
  }

  /** The answer to that ping came back. */
  pong(seq: number): void { if (this.sent.includes(seq)) this.answered.add(seq); }

  /** The share (0 to 1) of recent pings that were not answered. The newest one is still on its way, so it is not counted yet. */
  get loss(): number {
    const settled = this.sent.slice(0, -1);
    if (settled.length < 5) return 0; // too little to say anything
    return settled.filter(s => !this.answered.has(s)).length / settled.length;
  }
}
