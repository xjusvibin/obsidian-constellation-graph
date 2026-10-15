/**
 * Pilot mode's sound, synthesised with the Web Audio API so there are no audio files to ship.
 * Everything is quiet by default, starts only after the reader has entered Pilot mode (a user gesture,
 * which browsers require), and stops when they leave.
 */

interface Engine {
  saw: OscillatorNode; sub: OscillatorNode; lowpass: BiquadFilterNode; gain: GainNode;
  hiss: AudioBufferSourceNode; hissFilter: BiquadFilterNode; hissGain: GainNode;
  whine: OscillatorNode; whineGain: GainNode; // the high ion-engine whine over the rumble
}

export class PilotAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineBus: GainNode | null = null;
  private afterburnerBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engine: Engine | null = null;
  private enabled = true;
  private volume = 0.5;
  private engineMuted = false;
  private afterburnerMuted = false;
  private lastTick = 0;
  private lastUpdate = 0;
  private watchdog = 0;

  setOptions(enabled: boolean, volume: number): void {
    this.enabled = enabled; this.volume = volume;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(enabled ? volume : 0, this.ctx.currentTime, 0.05);
    if (!enabled) this.stopEngine(); else if (this.ctx && !this.engine) this.startEngine();
  }

  setEngineMuted(muted: boolean): void {
    this.engineMuted = muted;
    if (this.engineBus && this.ctx) this.engineBus.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.04);
  }

  setAfterburnerMuted(muted: boolean): void {
    this.afterburnerMuted = muted;
    if (this.afterburnerBus && this.ctx) this.afterburnerBus.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.04);
  }

  /** Call from a user gesture (entering Pilot mode). */
  start(): void {
    if (!this.enabled) return;
    try {
      if (!this.ctx) {
        const Ctor: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.ctx.destination);
        this.engineBus = this.ctx.createGain(); this.engineBus.gain.value = this.engineMuted ? 0 : 1; this.engineBus.connect(this.master);
        this.afterburnerBus = this.ctx.createGain(); this.afterburnerBus.gain.value = this.afterburnerMuted ? 0 : 1; this.afterburnerBus.connect(this.master);
        const len = this.ctx.sampleRate, buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.noise = buf;
      }
      void this.ctx.resume();
      this.startEngine();
      this.sweep(220, 640, 0.32, "sine", 0.16);
    } catch { /* no audio available: Pilot mode works without it */ }
  }

  stop(): void {
    if (!this.ctx) return;
    this.sweep(640, 160, 0.3, "sine", 0.14);
    this.stopEngine();
  }

  destroy(): void {
    this.stopEngine();
    window.clearInterval(this.watchdog);
    const c = this.ctx; this.ctx = null; this.master = null; this.engineBus = null; this.afterburnerBus = null; this.noise = null;
    if (c) void c.close().catch(() => undefined);
  }

  // ----------------------------------------------------------------- engine

  private startEngine(): void {
    const c = this.ctx, m = this.master; if (!c || !m || this.engine || !this.enabled) return;
    const saw = c.createOscillator(); saw.type = "sawtooth"; saw.frequency.value = 52;
    const sub = c.createOscillator(); sub.type = "square"; sub.frequency.value = 26;
    const lowpass = c.createBiquadFilter(); lowpass.type = "lowpass"; lowpass.frequency.value = 220; lowpass.Q.value = 2;
    const gain = c.createGain(); gain.gain.value = 0;
    const bus = this.engineBus ?? m;
    saw.connect(lowpass); sub.connect(lowpass); lowpass.connect(gain); gain.connect(bus);
    const hiss = c.createBufferSource(); hiss.buffer = this.noise; hiss.loop = true;
    const hissFilter = c.createBiquadFilter(); hissFilter.type = "bandpass"; hissFilter.frequency.value = 600; hissFilter.Q.value = 0.8;
    const hissGain = c.createGain(); hissGain.gain.value = 0;
    hiss.connect(hissFilter); hissFilter.connect(hissGain); hissGain.connect(bus);
    const whine = c.createOscillator(); whine.type = "sine"; whine.frequency.value = 900;
    const whineGain = c.createGain(); whineGain.gain.value = 0;
    whine.connect(whineGain); whineGain.connect(bus);
    saw.start(); sub.start(); hiss.start(); whine.start();
    this.engine = { saw, sub, lowpass, gain, hiss, hissFilter, hissGain, whine, whineGain };
    // If the flight loop stops feeding the engine (tab hidden, view closed, window in the background) it must go quiet, never hold its last note.
    this.lastUpdate = performance.now();
    window.clearInterval(this.watchdog);
    this.watchdog = window.setInterval(() => { if (performance.now() - this.lastUpdate > 300) this.silence(); }, 200);
  }

  private stopEngine(): void {
    window.clearInterval(this.watchdog);
    const e = this.engine, c = this.ctx; if (!e || !c) { this.engine = null; return; }
    this.engine = null;
    const t = c.currentTime;
    e.gain.gain.setTargetAtTime(0, t, 0.08); e.hissGain.gain.setTargetAtTime(0, t, 0.08); e.whineGain.gain.setTargetAtTime(0, t, 0.08);
    window.setTimeout(() => {
      for (const n of [e.saw, e.sub, e.hiss, e.whine]) { try { n.stop(); n.disconnect(); } catch { /* already stopped */ } }
      e.gain.disconnect(); e.hissGain.disconnect(); e.whineGain.disconnect();
    }, 500);
  }

  /** `speed` 0..1 of top speed, `boost` while Shift is down, `thrust` while any movement key is held. */
  update(speed: number, boost: boolean, thrust: boolean): void {
    const e = this.engine, c = this.ctx; if (!e || !c) return;
    this.lastUpdate = performance.now();
    const t = c.currentTime;
    e.saw.frequency.setTargetAtTime(48 + speed * 70 + (boost ? 22 : 0), t, 0.1);
    e.sub.frequency.setTargetAtTime(24 + speed * 35, t, 0.1);
    e.lowpass.frequency.setTargetAtTime(180 + speed * 900 + (boost ? 500 : 0), t, 0.12);
    e.gain.gain.setTargetAtTime(0.025 + speed * 0.09 + (thrust ? 0.015 : 0), t, 0.12);
    e.hissFilter.frequency.setTargetAtTime(500 + speed * 2500, t, 0.15);
    e.hissGain.gain.setTargetAtTime(speed * 0.05 + (boost ? 0.06 : 0), t, 0.12);
    e.whine.frequency.setTargetAtTime(700 + speed * 900 + (boost ? 400 : 0), t, 0.15);
    e.whineGain.gain.setTargetAtTime(0.006 + speed * 0.012, t, 0.15);
  }

  /** Fade the engine to nothing right now (it comes back the next time the flight loop updates it). */
  silence(): void {
    const e = this.engine, c = this.ctx; if (!e || !c) return;
    const t = c.currentTime;
    e.gain.gain.setTargetAtTime(0, t, 0.05); e.hissGain.gain.setTargetAtTime(0, t, 0.05); e.whineGain.gain.setTargetAtTime(0, t, 0.05);
  }

  /** Called when the page is hidden or loses focus: stop all sound at once. */
  mute(on: boolean): void {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(on || !this.enabled ? 0 : this.volume, this.ctx.currentTime, 0.03);
  }

  // ----------------------------------------------------------------- one-shots

  private env(gain: GainNode, t: number, peak: number, dur: number): void {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  private sweep(from: number, to: number, dur: number, type: OscillatorType, peak: number, delay = 0, destination?: AudioNode | null): void {
    const c = this.ctx, m = this.master; if (!c || !m || !this.enabled) return;
    const t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(from, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    this.env(g, t, peak, dur);
    o.connect(g); g.connect(destination ?? m); o.start(t); o.stop(t + dur + 0.05);
  }

  private burst(dur: number, from: number, to: number, peak: number, delay = 0, destination?: AudioNode | null): void {
    const c = this.ctx, m = this.master; if (!c || !m || !this.noise || !this.enabled) return;
    const t = c.currentTime + delay, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; f.type = "bandpass"; f.Q.value = 1.2;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(Math.max(40, to), t + dur);
    this.env(g, t, peak, dur);
    s.connect(f); f.connect(g); g.connect(destination ?? m); s.start(t); s.stop(t + dur + 0.05);
  }

  /** A blaster bolt: a fast downward chirp with a crack of noise at the start. `i` varies the pitch a little from gun to gun. */
  /** The afterburner lighting: a rising whoosh. */
  afterburner(): void { this.burst(0.6, 250, 3000, 0.13, 0, this.afterburnerBus); this.sweep(90, 220, 0.5, "sawtooth", 0.07, 0, this.afterburnerBus); }

  laser(i = 0): void {
    const k = 1 + (i % 4) * 0.06;
    this.sweep(2600 * k, 260 * k, 0.2, "sawtooth", 0.1);
    this.sweep(1300 * k, 130 * k, 0.16, "square", 0.045);
    this.burst(0.05, 5000, 1500, 0.06);
  }
  /** The ship hitting a note: a heavy thud and a crunch, louder for a harder hit. */
  bump(power: number): void {
    const p = 0.35 + 0.65 * power;
    this.sweep(120, 32, 0.32, "sine", 0.32 * p);
    this.burst(0.2, 900, 90, 0.16 * p);
    this.sweep(300, 70, 0.12, "square", 0.06 * p);
  }

  /** A bolt landing on a note: a small thump and a bright ping. */
  hit(): void {
    this.sweep(140, 40, 0.28, "sine", 0.22);
    this.burst(0.22, 1800, 160, 0.12);
    this.sweep(760, 1180, 0.1, "sine", 0.09, 0.02);
  }
  open(): void { [660, 880, 1320].forEach((f, i) => this.sweep(f, f * 1.02, 0.16, "triangle", 0.14, i * 0.07)); }
  lock(on: boolean): void { this.sweep(on ? 700 : 520, on ? 1050 : 340, 0.09, "sine", 0.12); }
  warp(ms: number): void {
    const d = ms / 1000;
    this.burst(d, 200, 3200, 0.16);
    this.sweep(140, 55, d, "sine", 0.12);
    this.sweep(300, 2400, d * 0.85, "triangle", 0.05); // the whine climbs, then the ship drops out of the jump with a thump
    this.sweep(110, 35, 0.4, "sine", 0.24, d * 0.92);
    this.burst(0.3, 1500, 120, 0.1, d * 0.92);
  }
  /** A faint tick when the crosshair moves onto a note; limited so sweeping across a dense cluster stays calm. */
  tick(): void {
    const c = this.ctx; if (!c) return;
    const now = c.currentTime; if (now - this.lastTick < 0.09) return;
    this.lastTick = now;
    this.sweep(2100, 1900, 0.025, "sine", 0.035);
  }
}
