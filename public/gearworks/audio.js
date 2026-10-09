// Gearworks sound: a clockwork groove (ticking hats, a plucked bass, a music-box melody in D minor) and the
// machine's voice — bells for bumpers, clanks for flippers, steam hisses, a spring for the plunger. Web Audio only.

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const MELODY = [74, 77, 76, 74, 72, 74, 69, null, 70, 72, 74, 77, 76, 72, 74, null];
const BASS = [50, 50, 45, 45, 46, 46, 48, 45];

export class Audio {
    constructor() {
        this.ctx = null;
        this.muted = false;
        this.intensity = 0;          // 0 normal, 1 multiball / steam blast
        try { this.muted = localStorage.getItem("gearworks.muted") === "1"; } catch { }
    }
    init() {
        if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = this.ctx = new AC();
        this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.6;
        const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16;
        this.master.connect(comp).connect(ctx.destination);
        const len = ctx.sampleRate * 1.6, ir = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
        this.verb = ctx.createConvolver(); this.verb.buffer = ir;
        const wet = ctx.createGain(); wet.gain.value = 0.25; this.verb.connect(wet).connect(this.master);
        this.music = ctx.createGain(); this.music.gain.value = 0.32; this.music.connect(this.master); this.music.connect(this.verb);
        this.sfx = ctx.createGain(); this.sfx.gain.value = 0.85; this.sfx.connect(this.master); this.sfx.connect(this.verb);
        this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const nd = this.noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        this.step = 0;
        this.next = ctx.currentTime + 0.2;
        this.timer = setInterval(() => this.schedule(), 100);
    }
    toggleMute() {
        this.muted = !this.muted;
        try { localStorage.setItem("gearworks.muted", this.muted ? "1" : "0"); } catch { }
        if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.6, this.ctx.currentTime, 0.1);
        return this.muted;
    }
    get ok() { return !!this.ctx && !this.muted; }

    schedule() {
        const ctx = this.ctx, beat = 60 / (this.intensity ? 132 : 112) / 2;     // eighth notes
        while (this.next < ctx.currentTime + 0.25) {
            const t = this.next, s = this.step;
            this.tick(t, s % 2 === 0 ? 0.05 : 0.025);
            if (s % 2 === 0) this.bass(midi(BASS[(s >> 2) % 8]), t, beat * 1.8);
            if (s % 8 === 4) this.clank(t, 0.06);
            const m = MELODY[s % 16];
            if (m && (s >> 4) % 2 === 1) this.box(midi(m), t, 0.05);
            if (this.intensity && m && s % 2 === 0) this.box(midi(m + 12), t + 0.01, 0.03);
            this.next += beat; this.step++;
        }
    }
    tick(t, v) {
        const ctx = this.ctx, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        s.buffer = this.noise; f.type = "highpass"; f.frequency.value = 7000;
        g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
        s.connect(f).connect(g).connect(this.music); s.start(t, Math.random() * 0.5); s.stop(t + 0.05);
    }
    bass(freq, t, d) {
        const ctx = this.ctx, o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        o.type = "sawtooth"; o.frequency.value = freq / 2;
        f.type = "lowpass"; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(160, t + d);
        g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(f).connect(g).connect(this.music); o.start(t); o.stop(t + d + 0.02);
    }
    box(freq, t, v, dest) {                         // music box tine
        const ctx = this.ctx;
        for (const [m, a] of [[1, 1], [3.01, 0.25], [5.4, 0.08]]) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = "sine"; o.frequency.value = freq * m;
            g.gain.setValueAtTime(v * a, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1 / m);
            o.connect(g).connect(dest || this.music); o.start(t); o.stop(t + 1.2);
        }
    }
    clank(t, v, dest) {
        const ctx = this.ctx;
        for (const fr of [310, 467, 789]) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = "square"; o.frequency.value = fr;
            g.gain.setValueAtTime(v * 0.3, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
            o.connect(g).connect(dest || this.music); o.start(t); o.stop(t + 0.08);
        }
    }
    hiss(t, dur, v) {
        const ctx = this.ctx, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        s.buffer = this.noise; s.loop = true; f.type = "highpass"; f.frequency.value = 2500;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        s.connect(f).connect(g).connect(this.sfx); s.start(t); s.stop(t + dur + 0.05);
    }

    // ---- effects
    flipper() {
        if (!this.ok) return;
        const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(50, t + 0.06);
        g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 0.09);
        this.clank(t, 0.12, this.sfx);
    }
    bumper(i = 0) {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        this.box(midi([81, 84, 88][i % 3]), t, 0.18, this.sfx);
        this.clank(t, 0.2, this.sfx);
        this.hiss(t, 0.25, 0.05);
    }
    sling() { if (this.ok) { const t = this.ctx.currentTime; this.clank(t, 0.25, this.sfx); this.box(midi(69), t, 0.08, this.sfx); } }
    rail(v) {
        if (!this.ok || v < 3) return;
        const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = "triangle"; o.frequency.value = 900 + Math.random() * 400;
        g.gain.setValueAtTime(Math.min(0.12, v * 0.006), t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 0.07);
    }
    target() { if (this.ok) { const t = this.ctx.currentTime; this.clank(t, 0.3, this.sfx); this.box(midi(62), t, 0.12, this.sfx); } }
    lane(n) { if (this.ok) this.box(midi(86 + [0, 3, 7][n % 3]), this.ctx.currentTime, 0.12, this.sfx); }
    plunge(power) {
        if (!this.ok) return;
        const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = "sawtooth"; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(380, t + 0.18);
        g.gain.setValueAtTime(0.12 * power + 0.04, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 0.24);
        this.hiss(t, 0.5, 0.08 * power);
    }
    saucer() { if (this.ok) { const t = this.ctx.currentTime; this.hiss(t, 1.0, 0.12); [50, 57, 62].forEach((n, i) => this.box(midi(n + 12), t + i * 0.08, 0.12, this.sfx)); } }
    fanfare(big) {
        if (!this.ok) return;
        const t = this.ctx.currentTime, notes = big ? [62, 65, 69, 74, 77, 81, 86] : [74, 77, 81, 86];
        notes.forEach((n, i) => { this.box(midi(n), t + i * 0.09, 0.15, this.sfx); this.clank(t + i * 0.09, 0.1, this.sfx); });
        this.hiss(t, 1.2, 0.1);
    }
    drain() { if (this.ok) { const t = this.ctx.currentTime; [62, 58, 55, 50].forEach((n, i) => this.box(midi(n), t + i * 0.16, 0.12, this.sfx)); } }
}
