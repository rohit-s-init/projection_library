// Stratos sound: an airy pad that darkens as you climb, glassy plucks for every slab (the pitch climbs with a
// perfect streak), shimmering bells for perfects, a crunch for cuts. Web Audio only, nothing to download.

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33, 36];
const CHORDS = [[57, 64, 69, 72], [53, 60, 65, 69], [48, 55, 64, 67], [55, 62, 67, 71]];

export class Audio {
    constructor() {
        this.ctx = null;
        this.muted = false;
        try { this.muted = localStorage.getItem("stratos.muted") === "1"; } catch { }
    }
    init() {
        if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = this.ctx = new AC();
        this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.6;
        const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16;
        this.master.connect(comp).connect(ctx.destination);
        const len = ctx.sampleRate * 3.5, ir = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5); }
        this.verb = ctx.createConvolver(); this.verb.buffer = ir;
        const wet = ctx.createGain(); wet.gain.value = 0.55; this.verb.connect(wet).connect(this.master);
        this.music = ctx.createGain(); this.music.gain.value = 0.22;
        this.padFilter = ctx.createBiquadFilter(); this.padFilter.type = "lowpass"; this.padFilter.frequency.value = 1400;
        this.music.connect(this.padFilter).connect(this.master); this.padFilter.connect(this.verb);
        this.sfx = ctx.createGain(); this.sfx.gain.value = 0.8; this.sfx.connect(this.master); this.sfx.connect(this.verb);
        this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const nd = this.noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        this.chord = 0; this.next = ctx.currentTime + 0.1;
        this.timer = setInterval(() => this.schedule(), 300);
    }
    toggleMute() {
        this.muted = !this.muted;
        try { localStorage.setItem("stratos.muted", this.muted ? "1" : "0"); } catch { }
        if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.6, this.ctx.currentTime, 0.1);
        return this.muted;
    }
    get ok() { return !!this.ctx && !this.muted; }
    altitude(k) { if (this.ctx) this.padFilter.frequency.setTargetAtTime(1600 - k * 1000, this.ctx.currentTime, 2); }

    schedule() {
        const ctx = this.ctx;
        while (this.next < ctx.currentTime + 1) {
            const t = this.next, notes = CHORDS[this.chord % 4];
            for (const n of notes) {
                for (const det of [-6, 6]) {
                    const o = ctx.createOscillator(), g = ctx.createGain();
                    o.type = "sawtooth"; o.frequency.value = midi(n - 12); o.detune.value = det;
                    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.03, t + 2.5); g.gain.linearRampToValueAtTime(0, t + 8.5);
                    o.connect(g).connect(this.music); o.start(t); o.stop(t + 8.6);
                }
            }
            this.chord++; this.next += 7;
        }
    }
    pluck(freq, t, v) {
        const ctx = this.ctx;
        for (const [m, a, d] of [[1, 1, 1.4], [2, 0.4, 0.9], [3, 0.15, 0.5], [4.2, 0.07, 0.3]]) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = m === 1 ? "triangle" : "sine"; o.frequency.value = freq * m;
            g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v * a, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
            o.connect(g).connect(this.sfx); o.start(t); o.stop(t + d + 0.05);
        }
    }
    place(combo, floor) {
        if (!this.ok) return;
        const t = this.ctx.currentTime, i = Math.min(SCALE.length - 1, combo);
        this.pluck(midi(64 + SCALE[i]), t, 0.18);
        this.thud(t, 0.12);
    }
    perfect(combo) {
        if (!this.ok) return;
        const t = this.ctx.currentTime, i = Math.min(SCALE.length - 1, combo);
        this.pluck(midi(64 + SCALE[i]), t, 0.22);
        this.pluck(midi(76 + SCALE[i]), t + 0.06, 0.12);
        if (combo >= 3) this.pluck(midi(88 + SCALE[i % 5]), t + 0.12, 0.08);
    }
    cut() {
        if (!this.ok) return;
        const t = this.ctx.currentTime, s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
        s.buffer = this.noise; f.type = "bandpass"; f.frequency.value = 2400; f.Q.value = 0.8;
        g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        s.connect(f).connect(g).connect(this.sfx); s.start(t, Math.random() * 0.5); s.stop(t + 0.2);
    }
    thud(t, v) {
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.12);
        g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 0.16);
    }
    grow() { if (this.ok) { const t = this.ctx.currentTime; [76, 81, 88, 93].forEach((n, i) => this.pluck(midi(n), t + i * 0.05, 0.08)); } }
    milestone() { if (this.ok) { const t = this.ctx.currentTime; [64, 69, 71, 76, 81, 83, 88].forEach((n, i) => this.pluck(midi(n), t + i * 0.08, 0.12)); } }
    fall() {
        if (!this.ok) return;
        const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = "sine"; o.frequency.setValueAtTime(400, t); o.frequency.exponentialRampToValueAtTime(60, t + 1.2);
        g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 1.35);
        [64, 60, 57, 52].forEach((n, i) => this.pluck(midi(n), t + 0.3 + i * 0.18, 0.1));
    }
}
