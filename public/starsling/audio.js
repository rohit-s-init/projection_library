// Space ambience + sound effects for Starsling (Web Audio, nothing to download).
// Music: a slow evolving drone (detuned saws through a moving filter) with twinkling bell notes.
// The slingshot hums higher the further you pull; each star chimes one step higher than the last.

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const SCALE = [0, 2, 3, 7, 9];                    // a dreamy minor-pentatonic flavour
const ROOTS = [45, 41, 43, 40];

export class Audio {
    constructor() {
        this.ctx = null;
        this.muted = false;
        try { this.muted = localStorage.getItem("starsling.muted") === "1"; } catch { }
    }
    init() {
        if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = this.ctx = new AC();
        this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.6;
        const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16;
        this.master.connect(comp).connect(ctx.destination);
        const len = ctx.sampleRate * 3, ir = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5); }
        this.verb = ctx.createConvolver(); this.verb.buffer = ir;
        const wet = ctx.createGain(); wet.gain.value = 0.5; this.verb.connect(wet).connect(this.master);
        this.music = ctx.createGain(); this.music.gain.value = 0.45; this.music.connect(this.master); this.music.connect(this.verb);
        this.sfx = ctx.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master); this.sfx.connect(this.verb);
        this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const nd = this.noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        this.bar = 0; this.next = ctx.currentTime + 0.1;
        this.timer = setInterval(() => this.schedule(), 150);
        // slingshot hum (silent until you pull)
        this.hum = ctx.createOscillator(); this.humGain = ctx.createGain();
        this.hum.type = "triangle"; this.hum.frequency.value = 110; this.humGain.gain.value = 0;
        this.hum.connect(this.humGain).connect(this.sfx); this.hum.start();
    }
    toggleMute() {
        this.muted = !this.muted;
        try { localStorage.setItem("starsling.muted", this.muted ? "1" : "0"); } catch { }
        if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.6, this.ctx.currentTime, 0.1);
        return this.muted;
    }
    get ok() { return !!this.ctx && !this.muted; }

    schedule() {
        const ctx = this.ctx, BAR = 6;
        while (this.next < ctx.currentTime + 0.6) {
            const root = ROOTS[this.bar % 4];
            for (const [n, det] of [[root, -7], [root + 7, 5], [root + 12, 0]]) this.drone(midi(n), this.next, BAR * 1.2, det);
            for (let k = 0; k < 5; k++) if (Math.random() < 0.55)
                this.bell(midi(root + 24 + SCALE[Math.floor(Math.random() * 5)] + (Math.random() < 0.3 ? 12 : 0)), this.next + Math.random() * BAR, 0.035, this.music);
            this.next += BAR; this.bar++;
        }
    }
    drone(freq, t, dur, det) {
        const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
        o.type = "sawtooth"; o.frequency.value = freq; o.detune.value = det;
        f.type = "lowpass"; f.frequency.setValueAtTime(250, t); f.frequency.linearRampToValueAtTime(900, t + dur / 2); f.frequency.linearRampToValueAtTime(250, t + dur);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.03, t + 2); g.gain.linearRampToValueAtTime(0, t + dur);
        o.connect(f).connect(g).connect(this.music); o.start(t); o.stop(t + dur + 0.1);
    }
    bell(freq, t, vol, dest) {
        const ctx = this.ctx;
        for (const [m, v] of [[1, 1], [2.4, 0.35], [4.1, 0.15]]) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.frequency.value = freq * m;
            g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol * v, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 2 / m);
            o.connect(g).connect(dest || this.sfx); o.start(t); o.stop(t + 2.1);
        }
    }
    noiseSweep(t, dur, vol, f0, f1) {
        const ctx = this.ctx, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        s.buffer = this.noise; s.loop = true; f.type = "bandpass"; f.Q.value = 2;
        f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
        g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        s.connect(f).connect(g).connect(this.sfx); s.start(t); s.stop(t + dur + 0.05);
    }

    pull(power) {                                  // 0..1 while aiming, -1 to stop
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        this.humGain.gain.setTargetAtTime(power < 0 || this.muted ? 0 : 0.03 + power * 0.05, t, 0.05);
        if (power >= 0) this.hum.frequency.setTargetAtTime(110 + power * 330, t, 0.05);
    }
    launch(power) { if (this.ok) this.noiseSweep(this.ctx.currentTime, 0.6, 0.3 + power * 0.2, 300, 3000); }
    star(n) { if (this.ok) { const t = this.ctx.currentTime; this.bell(midi(76 + SCALE[n % 5] + 12 * Math.floor(n / 5)), t, 0.12); this.bell(midi(88 + SCALE[n % 5]), t + 0.08, 0.05); } }
    crash() {
        if (!this.ok) return;
        const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.8);
        g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 0.95);
        this.noiseSweep(t, 0.7, 0.35, 1500, 200);
    }
    lost() { if (this.ok) this.noiseSweep(this.ctx.currentTime, 0.9, 0.15, 2000, 200); }
    warp() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        this.noiseSweep(t, 1.0, 0.25, 200, 5000);
        [0, 3, 7, 12, 15, 19, 24].forEach((n, i) => this.bell(midi(69 + n), t + 0.1 + i * 0.07, 0.07));
    }
}
