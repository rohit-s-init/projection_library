// Quiet, reflective soundtrack + sound effects for Umbra (Web Audio, nothing to download).
// Music: soft felt-piano notes over slow chords in a big room. Turning the sculpture ticks gently;
// the closer the shadow gets to the shape, the brighter the ticks; solving blooms into a chord.

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const CHORDS = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 65]];   // Am7 Fmaj7 Cmaj7 G7

export class Audio {
    constructor() {
        this.ctx = null;
        this.muted = false;
        try { this.muted = localStorage.getItem("umbra.muted") === "1"; } catch { }
    }
    init() {
        if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = this.ctx = new AC();
        this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.65;
        const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18;
        this.master.connect(comp).connect(ctx.destination);
        const len = ctx.sampleRate * 3.5, ir = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
        this.verb = ctx.createConvolver(); this.verb.buffer = ir;
        const wet = ctx.createGain(); wet.gain.value = 0.55; this.verb.connect(wet).connect(this.master);
        this.music = ctx.createGain(); this.music.gain.value = 0.5; this.music.connect(this.master); this.music.connect(this.verb);
        this.sfx = ctx.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master); this.sfx.connect(this.verb);
        this.bar = 0; this.next = ctx.currentTime + 0.2;
        this.timer = setInterval(() => this.schedule(), 150);
    }
    toggleMute() {
        this.muted = !this.muted;
        try { localStorage.setItem("umbra.muted", this.muted ? "1" : "0"); } catch { }
        if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.65, this.ctx.currentTime, 0.1);
        return this.muted;
    }
    get ok() { return !!this.ctx && !this.muted; }

    schedule() {
        const BAR = 5.2;
        while (this.next < this.ctx.currentTime + 0.6) {
            const ch = CHORDS[this.bar % 4];
            this.piano(midi(ch[0] - 12), this.next, 0.07, 4.5);
            for (let k = 0; k < 6; k++) if (Math.random() < 0.5) this.piano(midi(ch[k % 4] + 12 * (1 + (k > 3 ? 1 : 0))), this.next + k * BAR / 6 + Math.random() * 0.15, 0.035, 2.5);
            this.next += BAR; this.bar++;
        }
    }
    piano(freq, t, vol, dur, dest) {
        const ctx = this.ctx;
        for (const [m, v] of [[1, 1], [2, 0.35], [3, 0.12], [4.02, 0.05]]) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.frequency.value = freq * m;
            g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol * v, t + 0.008);
            g.gain.exponentialRampToValueAtTime(0.0001, t + dur / m);
            o.connect(g).connect(dest || this.music); o.start(t); o.stop(t + dur + 0.05);
        }
    }
    tick(closeness) {                               // 0..1 how close the shadow is to the shape
        if (!this.ok) return;
        const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.frequency.value = 900 + closeness * 1400;
        g.gain.setValueAtTime(0.015 + closeness * 0.03, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 0.06);
    }
    snap() {
        if (!this.ok) return;
        const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(110, t + 0.1);
        g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 0.2);
    }
    solve() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        [48, 55, 60, 64, 67, 71, 76, 79, 84].forEach((n, i) => this.piano(midi(n), t + i * 0.09, 0.09, 4, this.sfx));
    }
    hint() { if (this.ok) this.piano(midi(76), this.ctx.currentTime, 0.06, 1.5, this.sfx); }
}
