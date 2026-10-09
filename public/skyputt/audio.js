// Skyputt sound: a breezy, sunny loop (plucked arpeggios over soft chords, the odd bird) and crisp golf sounds —
// the putter's tock, rails, bumpers, the windmill, sand, and the cup's rattle. Web Audio only.

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const PROG = [[60, 64, 67, 71], [57, 60, 64, 67], [62, 65, 69, 72], [55, 59, 62, 65]];

export class Audio {
    constructor() {
        this.ctx = null;
        this.muted = false;
        try { this.muted = localStorage.getItem("skyputt.muted") === "1"; } catch { }
    }
    init() {
        if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = this.ctx = new AC();
        this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.6;
        const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16;
        this.master.connect(comp).connect(ctx.destination);
        const len = ctx.sampleRate * 2.2, ir = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
        this.verb = ctx.createConvolver(); this.verb.buffer = ir;
        const wet = ctx.createGain(); wet.gain.value = 0.35; this.verb.connect(wet).connect(this.master);
        this.music = ctx.createGain(); this.music.gain.value = 0.3; this.music.connect(this.master); this.music.connect(this.verb);
        this.sfx = ctx.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master); this.sfx.connect(this.verb);
        this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const nd = this.noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        this.wind();
        this.step = 0; this.next = ctx.currentTime + 0.2;
        this.timer = setInterval(() => this.schedule(), 150);
    }
    toggleMute() {
        this.muted = !this.muted;
        try { localStorage.setItem("skyputt.muted", this.muted ? "1" : "0"); } catch { }
        if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.6, this.ctx.currentTime, 0.1);
        return this.muted;
    }
    get ok() { return !!this.ctx && !this.muted; }
    wind() {
        const ctx = this.ctx, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), lfo = ctx.createOscillator(), lg = ctx.createGain();
        s.buffer = this.noise; s.loop = true; f.type = "bandpass"; f.frequency.value = 500; f.Q.value = 0.6; g.gain.value = 0.025;
        lfo.frequency.value = 0.09; lg.gain.value = 0.018; lfo.connect(lg).connect(g.gain);
        s.connect(f).connect(g).connect(this.master); s.start(); lfo.start();
    }
    schedule() {
        const ctx = this.ctx, beat = 60 / 92 / 2;
        while (this.next < ctx.currentTime + 0.3) {
            const t = this.next, s = this.step, ch = PROG[(s >> 4) % 4];
            if (s % 16 === 0) for (const n of ch) this.pad(midi(n - 12), t, beat * 15);
            const arp = [0, 1, 2, 3, 2, 1, 2, 3][s % 8];
            if (s % 2 === 0 || Math.random() < 0.3) this.pluck(midi(ch[arp] + (s % 16 > 11 ? 12 : 0)), t, 0.06, this.music);
            if (s % 4 === 0) this.pluck(midi(ch[0] - 24), t, 0.08, this.music, 0.6);
            if (Math.random() < 0.025) this.bird(t);
            this.next += beat; this.step++;
        }
    }
    pad(freq, t, d) {
        const ctx = this.ctx;
        for (const det of [-7, 7]) {
            const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
            o.type = "sawtooth"; o.frequency.value = freq; o.detune.value = det; f.type = "lowpass"; f.frequency.value = 900;
            g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.025, t + 1.2); g.gain.linearRampToValueAtTime(0, t + d);
            o.connect(f).connect(g).connect(this.music); o.start(t); o.stop(t + d + 0.1);
        }
    }
    pluck(freq, t, v, dest, decay = 1) {
        const ctx = this.ctx;
        for (const [m, a] of [[1, 1], [2, 0.35], [3, 0.12]]) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = m === 1 ? "triangle" : "sine"; o.frequency.value = freq * m;
            g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v * a, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9 * decay / m);
            o.connect(g).connect(dest || this.sfx); o.start(t); o.stop(t + 1);
        }
    }
    bird(t) {
        const ctx = this.ctx;
        for (let k = 0; k < 3; k++) {
            const o = ctx.createOscillator(), g = ctx.createGain(), t0 = t + k * 0.12, f0 = 2600 + Math.random() * 1200;
            o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f0 * 1.4, t0 + 0.05); o.frequency.exponentialRampToValueAtTime(f0 * 0.9, t0 + 0.09);
            g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.02, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
            o.connect(g).connect(this.music); o.start(t0); o.stop(t0 + 0.11);
        }
    }
    click(freq, v, d) {
        const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(freq * 0.5, t + d);
        g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + d + 0.02);
    }
    putt(power) { if (this.ok) { this.click(1500, 0.25 + power * 0.2, 0.05); this.click(500, 0.2, 0.08); } }
    wall(v) { if (this.ok) this.click(900 + Math.random() * 300, Math.min(0.2, v * 0.03), 0.05); }
    bumper() { if (this.ok) { const t = this.ctx.currentTime; this.pluck(midi(84 + Math.floor(Math.random() * 3) * 4), t, 0.12); this.click(300, 0.15, 0.1); } }
    windmill() { if (this.ok) this.click(220, 0.25, 0.12); }
    sand() {
        if (!this.ok) return;
        const t = this.ctx.currentTime, s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
        s.buffer = this.noise; f.type = "highpass"; f.frequency.value = 3000;
        g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
        s.connect(f).connect(g).connect(this.sfx); s.start(t, Math.random() * 0.5); s.stop(t + 0.16);
    }
    boost() {
        if (!this.ok) return;
        const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = "sawtooth"; o.frequency.setValueAtTime(200, t); o.frequency.exponentialRampToValueAtTime(1200, t + 0.25);
        g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 0.31);
    }
    lip() { if (this.ok) { this.click(700, 0.15, 0.06); setTimeout(() => this.ok && this.click(650, 0.1, 0.05), 70); } }
    cup(kind) {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        [0, 0.06, 0.13, 0.2].forEach((d, i) => setTimeout(() => this.ok && this.click(420 - i * 40, 0.25 - i * 0.05, 0.06), d * 1000));
        const notes = kind >= 2 ? [72, 76, 79, 84, 88, 91] : kind === 1 ? [72, 76, 79, 84] : kind === 0 ? [72, 79] : [67, 64];
        notes.forEach((n, i) => this.pluck(midi(n), t + 0.3 + i * 0.09, 0.16));
        if (kind >= 1) this.cheer(t + 0.35, kind >= 2 ? 2.4 : 1.4);
    }
    cheer(t, d) {
        const ctx = this.ctx, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        s.buffer = this.noise; s.loop = true; f.type = "bandpass"; f.frequency.value = 1800; f.Q.value = 0.5;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09, t + 0.2); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        s.connect(f).connect(g).connect(this.sfx); s.start(t); s.stop(t + d + 0.1);
    }
}
