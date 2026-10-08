// Procedural sound effects with WebAudio (no audio files needed).

class Audio {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  noise: AudioBuffer | null = null;
  volume = 0.8;
  private engine: { osc: OscillatorNode; osc2: OscillatorNode; gain: GainNode; filt: BiquadFilterNode } | null = null;
  private last: Record<string, number> = {};

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 6;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  pause() {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  private throttle(key: string, ms: number): boolean {
    const now = performance.now();
    if ((this.last[key] ?? 0) + ms > now) return false;
    this.last[key] = now;
    return true;
  }

  private noiseSrc(): AudioBufferSourceNode | null {
    if (!this.ctx || !this.noise) return null;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    return s;
  }

  /** gain from distance (m) */
  private att(dist: number): number {
    return Math.max(0, 1 / (1 + dist / 60)) ;
  }

  cannon(caliber: number, dist: number) {
    if (!this.ctx || !this.master) return;
    const g0 = this.att(dist);
    if (g0 < 0.03) return;
    const t = this.ctx.currentTime;
    // low thump
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    const f0 = 95 - caliber * 0.35;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.5);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.9 * g0, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.75);
    // blast noise
    const n = this.noiseSrc()!;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(2400 - dist * 8, t);
    f.frequency.exponentialRampToValueAtTime(180, t + 0.9);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.75 * g0, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 1.1 + caliber / 200);
    n.connect(f).connect(ng).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + 1.4);
  }

  explosion(size: number, dist: number) {
    if (!this.ctx || !this.master) return;
    const g0 = this.att(dist) * Math.min(1.2, 0.5 + size * 0.4);
    if (g0 < 0.03) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSrc()!;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1200, t);
    f.frequency.exponentialRampToValueAtTime(90, t + 1.6);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(g0, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
    n.connect(f).connect(ng).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + 2.3);
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(60, t);
    o.frequency.exponentialRampToValueAtTime(22, t + 0.8);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(g0 * 0.9, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 1);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 1.05);
  }

  ricochet(dist: number) {
    if (!this.ctx || !this.master || !this.throttle('ric', 60)) return;
    const g0 = this.att(dist) * 0.5;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    const f0 = 1800 + Math.random() * 1200;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.45, t + 0.35);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(g0, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.42);
  }

  /** metallic clang for penetrations / non-penetrations */
  clang(pen: boolean, dist: number) {
    if (!this.ctx || !this.master || !this.throttle('clang', 50)) return;
    const g0 = this.att(dist) * (pen ? 0.75 : 0.5);
    const t = this.ctx.currentTime;
    for (const fr of pen ? [180, 410, 905] : [320, 760, 1430]) {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = fr * (0.95 + Math.random() * 0.1);
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(g0 * 0.18, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + (pen ? 0.5 : 0.3));
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = fr;
      f.Q.value = 6;
      o.connect(f).connect(og).connect(this.master);
      o.start(t);
      o.stop(t + 0.55);
    }
    const n = this.noiseSrc()!;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(g0 * 0.6, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    n.connect(hp).connect(ng).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + 0.2);
  }

  thud(dist: number) {
    if (!this.ctx || !this.master || !this.throttle('thud', 40)) return;
    const g0 = this.att(dist) * 0.5;
    const t = this.ctx.currentTime;
    const n = this.noiseSrc()!;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 500;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(g0, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    n.connect(f).connect(ng).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + 0.4);
  }

  /** Incoming artillery shell: a falling whistle. */
  whistle(dist: number, dur = 1.1) {
    if (!this.ctx || !this.master || !this.throttle('whistle', 180)) return;
    const g0 = this.att(dist) * 0.35;
    if (g0 < 0.02) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(1500 + Math.random() * 300, t);
    o.frequency.exponentialRampToValueAtTime(420, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(g0, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Propeller drone of a passing aircraft (fades in and out over `dur` seconds). */
  plane(dur: number, loud = 0.12) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(92, t);
    o.frequency.linearRampToValueAtTime(78, t + dur);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 17;
    const lfoG = this.ctx.createGain();
    lfoG.gain.value = 0.35;
    const trem = this.ctx.createGain();
    trem.gain.value = 0.65;
    lfo.connect(lfoG).connect(trem.gain);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 520;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(loud, t + dur * 0.45);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(trem).connect(g).connect(this.master);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.1);
    lfo.stop(t + dur + 0.1);
  }

  /** Radio squelch before a callout. */
  radio() {
    if (!this.ctx || !this.master || !this.throttle('radio', 250)) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSrc()!;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800;
    f.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    n.connect(f).connect(g).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + 0.18);
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(880, t + 0.02);
    o.frequency.setValueAtTime(1180, t + 0.08);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.05, t + 0.03);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.16);
  }

  click() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 1400;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.08, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.06);
  }

  reloadDone() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    for (const [dt, fr] of [
      [0, 520],
      [0.07, 340],
    ]) {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = fr;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.linearRampToValueAtTime(0.09, t + dt + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.06);
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = fr * 2;
      o.connect(f).connect(g).connect(this.master);
      o.start(t + dt);
      o.stop(t + dt + 0.08);
    }
  }

  engineStart() {
    if (!this.ctx || !this.master || this.engine) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 38;
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = 19;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 220;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.0;
    osc.connect(filt);
    osc2.connect(filt);
    filt.connect(gain).connect(this.master);
    osc.start();
    osc2.start();
    this.engine = { osc, osc2, gain, filt };
  }

  engineSet(load: number, alive: boolean) {
    if (!this.engine || !this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 34 + load * 30;
    this.engine.osc.frequency.setTargetAtTime(f, t, 0.15);
    this.engine.osc2.frequency.setTargetAtTime(f / 2, t, 0.15);
    this.engine.filt.frequency.setTargetAtTime(180 + load * 260, t, 0.2);
    this.engine.gain.gain.setTargetAtTime(alive ? 0.05 + load * 0.06 : 0, t, 0.2);
  }

  engineStop() {
    if (!this.engine) return;
    try {
      this.engine.osc.stop();
      this.engine.osc2.stop();
    } catch {
      /* already stopped */
    }
    this.engine = null;
  }
}

export const audio = new Audio();
