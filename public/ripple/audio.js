// Night-garden ambience + sound effects for Ripple (Web Audio, nothing to download).
// Crickets and soft water, koto-like plucks in a Japanese "in" scale; pebble plops, lotus bells.

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const IN_SCALE = [0, 1, 5, 7, 8];

export class Audio {
    constructor() {
        this.ctx = null;
        this.muted = false;
        try { this.muted = localStorage.getItem("ripple.muted") === "1"; } catch { }
    }
    init() {
        if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = this.ctx = new AC();
        this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.65;
        const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18;
        this.master.connect(comp).connect(ctx.destination);
        const len = ctx.sampleRate * 2.8, ir = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.8); }
        this.verb = ctx.createConvolver(); this.verb.buffer = ir;
        const wet = ctx.createGain(); wet.gain.value = 0.45; this.verb.connect(wet).connect(this.master);
        this.music = ctx.createGain(); this.music.gain.value = 0.5; this.music.connect(this.master); this.music.connect(this.verb);
        this.sfx = ctx.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master); this.sfx.connect(this.verb);
        this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const nd = this.noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        this.water();
        this.next = ctx.currentTime + 0.3;
        this.timer = setInterval(() => this.schedule(), 200);
    }
    toggleMute() {
        this.muted = !this.muted;
        try { localStorage.setItem("ripple.muted", this.muted ? "1" : "0"); } catch { }
        if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.65, this.ctx.currentTime, 0.1);
        return this.muted;
    }
    get ok() { return !!this.ctx && !this.muted; }

    water() {                                      // a constant soft lapping
        const ctx = this.ctx, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        s.buffer = this.noise; s.loop = true; f.type = "lowpass"; f.frequency.value = 380; g.gain.value = 0.03;
        const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.2; lg.gain.value = 0.02;
        lfo.connect(lg).connect(g.gain);
        s.connect(f).connect(g).connect(this.master); s.start(); lfo.start();
    }
    schedule() {
        const ctx = this.ctx;
        while (this.next < ctx.currentTime + 0.5) {
            const t = this.next;
            if (Math.random() < 0.45) {                // koto
                const n = 62 + IN_SCALE[Math.floor(Math.random() * 5)] + (Math.random() < 0.35 ? 12 : 0);
                this.koto(midi(n), t, 0.06, this.music);
                if (Math.random() < 0.3) this.koto(midi(n - 12), t + 0.02, 0.04, this.music);
            }
            if (Math.random() < 0.5) this.cricket(t + Math.random() * 0.5);
            this.next += 0.6;
        }
    }
    koto(freq, t, vol, dest) {
        const ctx = this.ctx;
        for (const [m, v] of [[1, 1], [2, 0.45], [3, 0.2], [4.1, 0.08]]) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = m === 1 ? "triangle" : "sine"; o.frequency.value = freq * m;
            g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol * v, t + 0.004);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2 / m);
            o.connect(g).connect(dest || this.sfx); o.start(t); o.stop(t + 2.3);
        }
    }
    cricket(t) {
        const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), am = ctx.createOscillator(), ag = ctx.createGain();
        o.frequency.value = 4200 + Math.random() * 600;
        am.frequency.value = 38; ag.gain.value = 0.004;
        am.connect(ag).connect(g.gain);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.004, t + 0.02); g.gain.linearRampToValueAtTime(0, t + 0.25);
        o.connect(g).connect(this.master); o.start(t); am.start(t); o.stop(t + 0.3); am.stop(t + 0.3);
    }
    plop(size = 1) {
        if (!this.ok) return;
        const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.frequency.setValueAtTime(700 / size, t); o.frequency.exponentialRampToValueAtTime(180 / size, t + 0.12);
        g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 0.22);
        const s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g2 = this.ctx.createGain();
        s.buffer = this.noise; f.type = "bandpass"; f.frequency.value = 1800; f.Q.value = 1.5;
        g2.gain.setValueAtTime(0.12, t); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        s.connect(f).connect(g2).connect(this.sfx); s.start(t, Math.random()); s.stop(t + 0.32);
    }
    bump() { if (this.ok) this.koto(midi(45), this.ctx.currentTime, 0.05); }
    lotus(n) {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        [0, 1, 2].slice(0, n).forEach((k) => this.koto(midi(74 + IN_SCALE[(k * 2) % 5] + 12 * (k > 1 ? 1 : 0)), t + k * 0.12, 0.1));
        this.koto(midi(86), t + 0.05, 0.05);
    }
    win() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        [62, 63, 67, 69, 70, 74, 75, 79].forEach((n, i) => this.koto(midi(n), t + i * 0.13, 0.09));
    }
    fail() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        [69, 67, 63, 62].forEach((n, i) => this.koto(midi(n), t + i * 0.2, 0.06));
    }
}
