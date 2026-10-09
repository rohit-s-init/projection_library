// Procedural music + sound effects for Chroma Drop (Web Audio, nothing to download).
// Music: a bright plucked loop in C major with a soft kick. Falling through rings plays notes that climb a
// pentatonic scale with the combo, so long falls sound like a rising run.

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const PENTA = [0, 2, 4, 7, 9];
const BPM = 100, STEP = 60 / BPM / 2;
const PROG = [[60, 64, 67], [57, 60, 64], [65, 69, 72], [67, 71, 74]];

export class Audio {
    constructor() {
        this.ctx = null;
        this.muted = false;
        try { this.muted = localStorage.getItem("chroma.muted") === "1"; } catch { }
    }
    init() {
        if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = this.ctx = new AC();
        this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.6;
        const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
        this.master.connect(comp).connect(ctx.destination);
        this.delay = ctx.createDelay(1); this.delay.delayTime.value = STEP * 1.5;
        const fb = ctx.createGain(); fb.gain.value = 0.3;
        this.delay.connect(fb).connect(this.delay);
        const dw = ctx.createGain(); dw.gain.value = 0.25;
        this.delay.connect(dw).connect(this.master);
        this.music = ctx.createGain(); this.music.gain.value = 0.4; this.music.connect(this.master);
        this.sfx = ctx.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master); this.sfx.connect(this.delay);
        this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const d = this.noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        this.step = 0; this.next = ctx.currentTime + 0.1;
        this.timer = setInterval(() => this.schedule(), 50);
    }
    toggleMute() {
        this.muted = !this.muted;
        try { localStorage.setItem("chroma.muted", this.muted ? "1" : "0"); } catch { }
        if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.6, this.ctx.currentTime, 0.05);
        return this.muted;
    }
    get ok() { return !!this.ctx && !this.muted; }

    schedule() {
        while (this.next < this.ctx.currentTime + 0.2) {
            const s = this.step % 16, chord = PROG[Math.floor(this.step / 16) % 4];
            if (s % 2 === 0) this.pluck(midi(chord[(s / 2) % 3] + (s % 8 === 6 ? 12 : 0)), this.next, 0.05, this.music);
            if (s % 4 === 0) this.pluck(midi(chord[0] - 24), this.next, 0.09, this.music, 0.5, "triangle");
            if (s % 8 === 0) this.kick(this.next);
            this.next += STEP; this.step++;
        }
    }

    pluck(freq, t, vol, dest, dur = 0.35, type = "square") {
        const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
        o.type = type; o.frequency.value = freq;
        f.type = "lowpass"; f.frequency.setValueAtTime(3500, t); f.frequency.exponentialRampToValueAtTime(500, t + dur);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(f).connect(g).connect(dest || this.sfx);
        o.start(t); o.stop(t + dur + 0.05);
        return o;
    }
    kick(t) {
        const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
        g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
        o.connect(g).connect(this.music); o.start(t); o.stop(t + 0.26);
    }
    noiseHit(t, dur, vol, type, freq) {
        const ctx = this.ctx, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        s.buffer = this.noise; f.type = type; f.frequency.value = freq;
        g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        s.connect(f).connect(g).connect(this.sfx); s.start(t); s.stop(t + dur + 0.02);
        return f;
    }

    bounce() {
        if (!this.ok) return;
        const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.frequency.setValueAtTime(420, t); o.frequency.exponentialRampToValueAtTime(160, t + 0.12);
        g.gain.setValueAtTime(0.22, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 0.17);
    }
    pass(combo) {
        if (!this.ok) return;
        const k = Math.min(combo, 20), n = 72 + 12 * Math.floor(k / 5) + PENTA[k % 5];
        this.pluck(midi(n), this.ctx.currentTime, 0.1, this.sfx, 0.3, "triangle");
        this.noiseHit(this.ctx.currentTime, 0.12, 0.08, "highpass", 3000);
    }
    smash() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        this.noiseHit(t, 0.35, 0.4, "lowpass", 1800);
        this.pluck(midi(48), t, 0.2, this.sfx, 0.3, "sawtooth");
    }
    fire() {
        if (!this.ok) return;
        const t = this.ctx.currentTime, f = this.noiseHit(t, 0.6, 0.25, "bandpass", 400);
        f.frequency.exponentialRampToValueAtTime(2500, t + 0.5);
    }
    die() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        this.noiseHit(t, 0.4, 0.35, "lowpass", 700);
        [67, 63, 60, 55].forEach((n, i) => this.pluck(midi(n), t + 0.1 + i * 0.12, 0.08, this.sfx, 0.4, "triangle"));
    }
    level() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        [60, 64, 67, 72, 76, 79, 84].forEach((n, i) => this.pluck(midi(n), t + i * 0.07, 0.09, this.sfx, 0.5, "square"));
    }
}
