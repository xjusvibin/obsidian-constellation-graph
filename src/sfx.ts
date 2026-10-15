/**
 * Pilot mode's sound, synthesised with the Web Audio API so there are no audio files to ship.
 * Everything runs through a compressor (so layered sounds do not clip) and a short reverb (so the sounds have a space to
 * live in). Sound starts only after the reader has entered Pilot mode (a user gesture, which browsers require), is muted
 * whenever the window loses focus, and the engine cuts itself if the flight loop stops updating it.
 */

interface ToneOpts { t?: number; attack?: number; lp?: [number, number]; q?: number; drive?: number; wet?: number; pan?: number; type?: OscillatorType }
interface NoiseOpts { t?: number; attack?: number; q?: number; wet?: number; pan?: number }

interface Engine {
  saw: OscillatorNode; sub: OscillatorNode; trem: OscillatorNode; rumble: AudioBufferSourceNode; hiss: AudioBufferSourceNode; whine: OscillatorNode;
  lowpass: BiquadFilterNode; hissFilter: BiquadFilterNode; hissGain: GainNode; whineGain: GainNode; rumbleGain: GainNode; out: GainNode;
}

export class PilotAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private noise: AudioBuffer | null = null;
  private engine: Engine | null = null;
  private enabled = true;
  private volume = 0.5;
  private lastTick = 0;
  private lastUpdate = 0;
  private watchdog = 0;
  private muted = false;

  setOptions(enabled: boolean, volume: number): void {
    this.enabled = enabled; this.volume = volume;
    this.applyVolume();
    if (!enabled) this.stopEngine(); else if (this.ctx && !this.engine) this.startEngine();
  }

  private applyVolume(): void {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.enabled && !this.muted ? this.volume : 0, this.ctx.currentTime, 0.04);
  }

  /** Call from a user gesture (entering Pilot mode). */
  start(): void {
    if (!this.enabled) return;
    try {
      if (!this.ctx) this.build();
      void this.ctx?.resume();
      this.startEngine();
      this.enter();
    } catch { /* no audio available: Pilot mode works without it */ }
  }

  stop(): void {
    if (!this.ctx) return;
    this.exit();
    this.stopEngine();
  }

  destroy(): void {
    this.stopEngine();
    const c = this.ctx; this.ctx = null; this.master = null; this.reverb = null; this.noise = null;
    if (c) void c.close().catch(() => undefined);
  }

  /** The signal chain: everything goes to the master volume, then a compressor, then the speakers; a send goes through a reverb. */
  private build(): void {
    const Ctor: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("no Web Audio");
    const c = new Ctor();
    const master = c.createGain(); master.gain.value = this.enabled && !this.muted ? this.volume : 0;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.16;
    master.connect(comp); comp.connect(c.destination);
    const reverb = c.createConvolver(); reverb.buffer = this.impulse(c, 1.7, 2.6);
    const wet = c.createGain(); wet.gain.value = 0.5;
    reverb.connect(wet); wet.connect(master);
    const len = c.sampleRate, nb = c.createBuffer(1, len, c.sampleRate), d = nb.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.ctx = c; this.master = master; this.reverb = reverb; this.noise = nb;
  }

  private impulse(c: AudioContext, seconds: number, decay: number): AudioBuffer {
    const rate = c.sampleRate, len = Math.floor(rate * seconds), b = c.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return b;
  }

  /** Fade everything out at once, when the window is hidden or loses focus. */
  mute(on: boolean): void { this.muted = on; this.applyVolume(); }

  // ----------------------------------------------------------------- building blocks

  private ok(): boolean { return !!(this.ctx && this.master && this.reverb && this.noise && this.enabled); }

  private env(g: GainNode, t: number, peak: number, attack: number, dur: number): void {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  private send(node: AudioNode, wet = 0.2, pan = 0): void {
    const c = this.ctx!; let n = node;
    if (pan) { const p = c.createStereoPanner(); p.pan.value = pan; n.connect(p); n = p; }
    n.connect(this.master!);
    if (wet > 0) { const s = c.createGain(); s.gain.value = wet; n.connect(s); s.connect(this.reverb!); }
  }

  private shaper(k: number): WaveShaperNode {
    const s = this.ctx!.createWaveShaper(), curve = new Float32Array(512);
    for (let i = 0; i < 512; i++) { const x = (i * 2) / 511 - 1; curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x)); }
    s.curve = curve; s.oversample = "2x"; return s;
  }

  /** A sweeping oscillator, optionally through a closing low-pass filter and a distortion stage. */
  private tone(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, o: ToneOpts = {}): void {
    if (!this.ok()) return;
    const c = this.ctx!, t = o.t ?? c.currentTime, osc = c.createOscillator(), g = c.createGain();
    osc.type = type; osc.frequency.setValueAtTime(f0, t); osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    this.env(g, t, peak, o.attack ?? 0.004, dur);
    let n: AudioNode = osc;
    if (o.lp) { const f = c.createBiquadFilter(); f.type = "lowpass"; f.Q.value = o.q ?? 1; f.frequency.setValueAtTime(o.lp[0], t); f.frequency.exponentialRampToValueAtTime(Math.max(40, o.lp[1]), t + dur); n.connect(f); n = f; }
    if (o.drive) { const s = this.shaper(o.drive); n.connect(s); n = s; }
    n.connect(g); this.send(g, o.wet ?? 0.15, o.pan ?? 0);
    osc.start(t); osc.stop(t + dur + 0.08);
  }

  /** Filtered noise: a crack, a whoosh, a crunch. */
  private hiss(kind: BiquadFilterType, f0: number, f1: number, dur: number, peak: number, o: NoiseOpts = {}): void {
    if (!this.ok()) return;
    const c = this.ctx!, t = o.t ?? c.currentTime, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; s.loop = true; f.type = kind; f.Q.value = o.q ?? 1;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    this.env(g, t, peak, o.attack ?? 0.003, dur);
    s.connect(f); f.connect(g); this.send(g, o.wet ?? 0.15, o.pan ?? 0);
    s.start(t); s.stop(t + dur + 0.08);
  }

  /** A frequency-modulated tone: the metallic edge of a laser. */
  private fm(f0: number, f1: number, ratio: number, depth: number, dur: number, peak: number, o: ToneOpts = {}): void {
    if (!this.ok()) return;
    const c = this.ctx!, t = o.t ?? c.currentTime, car = c.createOscillator(), mod = c.createOscillator(), md = c.createGain(), g = c.createGain();
    car.type = o.type ?? "sine"; mod.type = "sine";
    car.frequency.setValueAtTime(f0, t); car.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    mod.frequency.setValueAtTime(f0 * ratio, t); mod.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * ratio), t + dur);
    md.gain.setValueAtTime(depth, t); md.gain.exponentialRampToValueAtTime(1, t + dur * 0.8);
    mod.connect(md); md.connect(car.frequency);
    this.env(g, t, peak, o.attack ?? 0.003, dur);
    car.connect(g); this.send(g, o.wet ?? 0.15, o.pan ?? 0);
    car.start(t); mod.start(t); car.stop(t + dur + 0.08); mod.stop(t + dur + 0.08);
  }

  /** A short feedback echo bus; the nodes are released a couple of seconds later. */
  private echo(time: number, feedback: number, mix: number): GainNode {
    const c = this.ctx!, inp = c.createGain(), d = c.createDelay(1), f = c.createGain(), w = c.createGain();
    d.delayTime.value = time; f.gain.value = feedback; w.gain.value = mix;
    inp.connect(this.master!); inp.connect(d); d.connect(f); f.connect(d); d.connect(w); w.connect(this.master!);
    window.setTimeout(() => { try { inp.disconnect(); d.disconnect(); f.disconnect(); w.disconnect(); } catch { /* already gone */ } }, 2500);
    return inp;
  }

  // ----------------------------------------------------------------- engine

  private startEngine(): void {
    const c = this.ctx, m = this.master; if (!c || !m || this.engine || !this.enabled || !this.noise) return;
    const t = c.currentTime, out = c.createGain(); out.gain.value = 0; out.connect(m);
    const saw = c.createOscillator(); saw.type = "sawtooth";
    const sub = c.createOscillator(); sub.type = "square";
    const lowpass = c.createBiquadFilter(); lowpass.type = "lowpass"; lowpass.Q.value = 3;
    const body = c.createGain(); body.gain.value = 0.5;
    saw.connect(lowpass); sub.connect(lowpass); lowpass.connect(body); body.connect(out);
    const trem = c.createOscillator(), tremGain = c.createGain(); trem.frequency.value = 23; tremGain.gain.value = 0.16; trem.connect(tremGain); tremGain.connect(body.gain); // a rough flutter in the rumble
    const rumble = c.createBufferSource(), rlp = c.createBiquadFilter(), rumbleGain = c.createGain();
    rumble.buffer = this.noise; rumble.loop = true; rlp.type = "lowpass"; rlp.frequency.value = 160; rumbleGain.gain.value = 0.8;
    rumble.connect(rlp); rlp.connect(rumbleGain); rumbleGain.connect(out);
    const hiss = c.createBufferSource(), hissFilter = c.createBiquadFilter(), hissGain = c.createGain();
    hiss.buffer = this.noise; hiss.loop = true; hissFilter.type = "bandpass"; hissFilter.Q.value = 0.8; hissGain.gain.value = 0;
    hiss.connect(hissFilter); hissFilter.connect(hissGain); hissGain.connect(out);
    const whine = c.createOscillator(), whineGain = c.createGain(); whine.type = "sine"; whine.frequency.value = 900; whineGain.gain.value = 0;
    whine.connect(whineGain); whineGain.connect(out);
    for (const n of [saw, sub, trem, rumble, hiss, whine]) n.start(t);
    this.engine = { saw, sub, trem, rumble, hiss, whine, lowpass, hissFilter, hissGain, whineGain, rumbleGain, out };
    // If the flight loop stops feeding the engine (tab hidden, view closed, window in the background) it must go quiet, never hold its last note.
    this.lastUpdate = performance.now();
    window.clearInterval(this.watchdog);
    this.watchdog = window.setInterval(() => { if (performance.now() - this.lastUpdate > 300) this.silence(); }, 200);
  }

  private stopEngine(): void {
    window.clearInterval(this.watchdog);
    const e = this.engine, c = this.ctx; if (!e || !c) { this.engine = null; return; }
    this.engine = null;
    e.out.gain.setTargetAtTime(0, c.currentTime, 0.08);
    window.setTimeout(() => {
      for (const n of [e.saw, e.sub, e.trem, e.rumble, e.hiss, e.whine]) { try { n.stop(); n.disconnect(); } catch { /* already stopped */ } }
      try { e.out.disconnect(); } catch { /* already gone */ }
    }, 500);
  }

  /** `speed` 0..1 of cruise speed, `boost` while the afterburner burns, `thrust` while any movement key is held. */
  update(speed: number, boost: boolean, thrust: boolean): void {
    const e = this.engine, c = this.ctx; if (!e || !c) return;
    this.lastUpdate = performance.now();
    const t = c.currentTime, s = Math.min(1, Math.max(0, speed));
    e.saw.frequency.setTargetAtTime(46 + s * 80 + (boost ? 24 : 0), t, 0.08);
    e.sub.frequency.setTargetAtTime(23 + s * 40, t, 0.08);
    e.lowpass.frequency.setTargetAtTime(170 + s * 1100 + (boost ? 700 : 0), t, 0.1);
    e.hissFilter.frequency.setTargetAtTime(500 + s * 3000, t, 0.12);
    e.hissGain.gain.setTargetAtTime(s * 0.2 + (boost ? 0.22 : 0), t, 0.1);
    e.whine.frequency.setTargetAtTime(700 + s * 1000 + (boost ? 500 : 0), t, 0.12);
    e.whineGain.gain.setTargetAtTime(0.008 + s * 0.016, t, 0.12);
    e.rumbleGain.gain.setTargetAtTime(0.7 - s * 0.2, t, 0.15);
    e.out.gain.setTargetAtTime(0.11 + s * 0.19 + (boost ? 0.07 : 0) + (thrust ? 0.02 : 0), t, 0.12);
  }

  /** Fade the engine to nothing right now (it comes back the next time the flight loop updates it). */
  silence(): void {
    const e = this.engine, c = this.ctx; if (!e || !c) return;
    e.out.gain.setTargetAtTime(0, c.currentTime, 0.05);
  }

  // ----------------------------------------------------------------- one-shots

  /**
   * The blaster, "Pulse XL": a sharp transient, a fast downward saw sweep through a closing filter with grit, a sub thump and
   * a square sizzle (the pulse), with a frequency-modulated metallic top and a short echo over it. `gun` varies the pitch a
   * little and pans the shot to the side of the gun it came from.
   */
  laser(gun = 0): void {
    if (!this.ok()) return;
    const c = this.ctx!, t = c.currentTime, p = (0.94 + Math.random() * 0.12) * (1 + (gun % 4) * 0.025), pan = gun % 2 ? 0.35 : -0.35;
    this.hiss("highpass", 3500, 3500, 0.012, 0.5, { t, wet: 0.05, pan });
    this.tone("sawtooth", 3400 * p, 190 * p, 0.3, 0.34, { t, lp: [7000, 380], q: 5, drive: 18, wet: 0.2, pan });
    this.tone("sine", 160 * p, 42, 0.24, 0.55, { t, wet: 0.05, pan });
    this.tone("square", 1700 * p, 110 * p, 0.18, 0.08, { t, wet: 0.1, pan });
    this.fm(3000 * p, 340 * p, 1.5, 1200, 0.28, 0.2, { t, wet: 0.3, pan });
    const e = this.echo(0.12, 0.25, 0.25), o = c.createOscillator(), g = c.createGain();
    o.type = "sawtooth"; o.frequency.setValueAtTime(1500 * p, t); o.frequency.exponentialRampToValueAtTime(200, t + 0.22);
    this.env(g, t, 0.05, 0.003, 0.22); o.connect(g); g.connect(e); o.start(t); o.stop(t + 0.3);
  }

  /** The cannon: a deep boom that drops through the floor, a crunch, and a crack on top. */
  cannon(gun = 0): void {
    if (!this.ok()) return;
    const t = this.ctx!.currentTime, p = (0.95 + Math.random() * 0.1) * (1 + (gun % 4) * 0.02), pan = gun % 2 ? 0.3 : -0.3;
    this.tone("sine", 130 * p, 26, 0.55, 0.85, { t, wet: 0.35, pan });
    this.hiss("lowpass", 3200, 140, 0.4, 0.55, { t, wet: 0.5, pan });
    this.tone("square", 560 * p, 70, 0.32, 0.22, { t, drive: 40, lp: [3000, 200], wet: 0.4, pan });
    this.hiss("highpass", 4000, 4000, 0.015, 0.45, { t, wet: 0.1, pan });
  }

  /** The blaster has run too hot: a descending buzz and a hiss of steam. */
  overheat(): void {
    if (!this.ok()) return;
    const t = this.ctx!.currentTime;
    this.tone("square", 260, 90, 0.4, 0.16, { t, drive: 30, lp: [1800, 200], wet: 0.2 });
    this.hiss("bandpass", 3000, 700, 0.5, 0.22, { t, q: 1.2, wet: 0.3 });
  }

  /** No more rounds: a dry click. */
  empty(): void { if (this.ok()) this.tone("sine", 900, 600, 0.05, 0.1, { wet: 0.05 }); }

  /** A bolt landing on a note: a deep thump, a burst of low noise, and a bright ping. */
  hit(): void {
    if (!this.ok()) return;
    const t = this.ctx!.currentTime;
    this.tone("sine", 150, 38, 0.3, 0.6, { t, wet: 0.2 });
    this.hiss("lowpass", 2400, 160, 0.22, 0.3, { t, wet: 0.3 });
    this.tone("sine", 780, 1250, 0.12, 0.12, { t: t + 0.02, wet: 0.3 });
  }

  /** A pickup collected: a quick rising two-note chime. */
  pickup(): void {
    if (!this.ok()) return;
    const t = this.ctx!.currentTime;
    [880, 1320].forEach((fr, i) => this.tone("triangle", fr, fr * 1.02, 0.25, 0.16, { t: t + i * 0.07, wet: 0.4 }));
  }

  /** A missile leaving the rail: a rising whoosh. */
  missileLaunch(): void {
    if (!this.ok()) return;
    const t = this.ctx!.currentTime;
    this.hiss("bandpass", 300, 2600, 0.5, 0.3, { t, q: 0.9, wet: 0.3 });
    this.tone("sawtooth", 90, 240, 0.45, 0.2, { t, lp: [500, 2200], wet: 0.2, attack: 0.04 });
  }

  /** A missile or a broken group going off: a deep boom and a crackle. */
  boom(): void {
    if (!this.ok()) return;
    const t = this.ctx!.currentTime;
    this.tone("sine", 110, 30, 0.6, 0.8, { t, wet: 0.35 });
    this.hiss("lowpass", 2200, 150, 0.5, 0.5, { t, wet: 0.4 });
  }

  /** Your shield soaking a hit: a bright, glassy zap, lighter than a hull hit. */
  shieldHit(): void {
    if (!this.ok()) return;
    const t = this.ctx!.currentTime;
    this.tone("sine", 1500, 760, 0.12, 0.3, { t, wet: 0.35 });
    this.tone("triangle", 2300, 1500, 0.08, 0.14, { t, wet: 0.4 });
    this.hiss("highpass", 3200, 5200, 0.1, 0.1, { t, wet: 0.3 });
  }

  /** The shield giving out: a falling, shattering tone. */
  shieldDown(): void {
    if (!this.ok()) return;
    const t = this.ctx!.currentTime;
    this.tone("sawtooth", 900, 140, 0.4, 0.22, { t, lp: [3000, 300], wet: 0.3 });
    this.hiss("bandpass", 4200, 700, 0.35, 0.22, { t, q: 0.9, wet: 0.4 });
  }

  /** The ship hitting a note: always the full collision (a boom, a crunch and a metallic rattle), a little quieter for a lighter hit. `power` is 0..1. */
  bump(power: number): void {
    if (!this.ok()) return;
    const t = this.ctx!.currentTime, p = Math.min(1, Math.max(0, power)), k = 0.55 + 0.45 * p;
    this.tone("sine", 120, 28, 0.45, 0.9 * k, { t, wet: 0.3 });
    this.hiss("lowpass", 2600, 120, 0.35, 0.6 * k, { t, wet: 0.4 });
    this.tone("square", 340, 60, 0.2, 0.14 * k, { t, drive: 40, wet: 0.2 });
    [820, 1130, 1570].forEach((f, i) => this.tone("sine", f, f * 0.95, 0.25, 0.04 * k, { t: t + 0.02 + i * 0.01, wet: 0.5 }));
  }

  /** A second hit opens the note: a rising three-note chime. */
  open(): void {
    if (!this.ok()) return;
    const t = this.ctx!.currentTime;
    [660, 880, 1320].forEach((f, i) => this.tone("triangle", f, f * 1.01, 0.5, 0.13, { t: t + i * 0.075, wet: 0.45 }));
  }

  lock(on: boolean): void {
    if (!this.ok()) return;
    const t = this.ctx!.currentTime;
    if (on) { this.tone("sine", 700, 900, 0.07, 0.14, { t, wet: 0.2 }); this.tone("sine", 1050, 1300, 0.09, 0.14, { t: t + 0.07, wet: 0.25 }); }
    else this.tone("sine", 800, 420, 0.1, 0.14, { t, wet: 0.2 });
  }

  /** The afterburner lighting: a rising whoosh over a deep swell. */
  afterburner(): void {
    if (!this.ok()) return;
    const t = this.ctx!.currentTime;
    this.hiss("bandpass", 250, 3600, 0.7, 0.35, { t, q: 0.8, wet: 0.3 });
    this.tone("sawtooth", 80, 230, 0.6, 0.18, { t, lp: [400, 2400], wet: 0.2, attack: 0.08 });
    this.tone("sine", 60, 140, 0.5, 0.4, { t, attack: 0.1, wet: 0.1 });
  }

  /** A warp jump of `ms` milliseconds: a rising whine and rush, then a drop-out thump as the ship arrives. */
  warp(ms: number): void {
    if (!this.ok()) return;
    const d = Math.max(0.6, ms / 1000), t = this.ctx!.currentTime;
    this.hiss("bandpass", 200, 3400, d, 0.28, { t, q: 0.7, wet: 0.3, attack: d * 0.4 });
    this.tone("sine", 140, 55, d, 0.14, { t, wet: 0.2 });
    this.tone("triangle", 300, 2800, d * 0.88, 0.06, { t, wet: 0.3, attack: d * 0.3 });
    this.tone("sine", 110, 32, 0.45, 0.45, { t: t + d * 0.92, wet: 0.3 });
    this.hiss("lowpass", 1700, 110, 0.35, 0.22, { t: t + d * 0.92, wet: 0.35 });
  }

  /** A faint tick when the crosshair moves onto a note; limited so sweeping across a dense cluster stays calm. */
  tick(): void {
    const c = this.ctx; if (!c || !this.ok()) return;
    const now = c.currentTime; if (now - this.lastTick < 0.09) return;
    this.lastTick = now;
    this.tone("sine", 2100, 1900, 0.03, 0.05, { t: now, wet: 0.05 });
  }

  private enter(): void {
    if (!this.ok()) return;
    const t = this.ctx!.currentTime;
    this.tone("sine", 160, 900, 0.45, 0.2, { t, wet: 0.3 });
    this.tone("sawtooth", 70, 220, 0.5, 0.1, { t, lp: [300, 2600], wet: 0.2 });
    this.hiss("bandpass", 400, 4000, 0.4, 0.14, { t, wet: 0.3 });
  }

  private exit(): void {
    if (!this.ok()) return;
    const t = this.ctx!.currentTime;
    this.tone("sine", 900, 120, 0.5, 0.2, { t, wet: 0.3 });
    this.tone("sawtooth", 240, 60, 0.5, 0.1, { t, lp: [2600, 200], wet: 0.2 });
  }
}
