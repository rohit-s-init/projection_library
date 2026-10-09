// Calm procedural soundtrack + sound effects (Web Audio, nothing to download).
// Music: slow major-seventh pad chords, a music box picking pentatonic notes, soft wind.
// Placing a tile plays a wooden knock plus one chime note per matching edge (so good fits sound fuller).

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const CHORDS = [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 67]];   // Cmaj7 Am7 Fmaj7 G
const PENTA = [0, 2, 4, 7, 9];

export class Audio {
    constructor() {
        this.ctx = null;
        this.muted = false;
        try { this.muted = localStorage.getItem("tessera.muted") === "1"; } catch { }
    }

    init() {
        if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = this.ctx = new AC();
        this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.6;
        const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 3;
        this.master.connect(comp).connect(ctx.destination);
        // a simple reverb (decaying noise impulse) shared by everything
        const len = ctx.sampleRate * 2.5, ir = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
        this.verb = ctx.createConvolver(); this.verb.buffer = ir;
        const wet = ctx.createGain(); wet.gain.value = 0.35;
        this.verb.connect(wet).connect(this.master);
        this.music = ctx.createGain(); this.music.gain.value = 0.5; this.music.connect(this.master); this.music.connect(this.verb);
        this.sfx = ctx.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master); this.sfx.connect(this.verb);
        this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const nd = this.noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        this.wind();
        this.bar = 0;
        this.next = ctx.currentTime + 0.1;
        this.timer = setInterval(() => this.schedule(), 100);
    }

    toggleMute() {
        this.muted = !this.muted;
        try { localStorage.setItem("tessera.muted", this.muted ? "1" : "0"); } catch { }
        if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.6, this.ctx.currentTime, 0.1);
        return this.muted;
    }

    // endless soft wind: filtered noise with a slowly wandering filter
    wind() {
        const ctx = this.ctx, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        src.buffer = this.noise; src.loop = true;
        f.type = "bandpass"; f.frequency.value = 500; f.Q.value = 0.6;
        g.gain.value = 0.035;
        const lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = 0.07; lg.gain.value = 300;
        lfo.connect(lg).connect(f.frequency);
        src.connect(f).connect(g).connect(this.master);
        src.start(); lfo.start();
    }

    schedule() {
        const ctx = this.ctx, BAR = 4.4;
        while (this.next < ctx.currentTime + 0.5) {
            const chord = CHORDS[this.bar % 4];
            chord.forEach((n) => this.pad(midi(n - 12), this.next, BAR * 1.1));
            // music box: a few random pentatonic notes per bar
            for (let k = 0; k < 4; k++) if (Math.random() < 0.6) {
                const n = chord[0] + 12 + PENTA[Math.floor(Math.random() * 5)] + (Math.random() < 0.3 ? 12 : 0);
                this.bell(midi(n), this.next + k * BAR / 4 + Math.random() * 0.2, 0.05, this.music);
            }
            this.next += BAR; this.bar++;
        }
    }

    pad(freq, t, dur) {
        const ctx = this.ctx;
        for (const det of [-6, 6]) {
            const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
            o.type = "sawtooth"; o.frequency.value = freq; o.detune.value = det;
            f.type = "lowpass"; f.frequency.value = 700;
            g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.018, t + 1.2); g.gain.linearRampToValueAtTime(0, t + dur);
            o.connect(f).connect(g).connect(this.music);
            o.start(t); o.stop(t + dur + 0.1);
        }
    }

    bell(freq, t, vol, dest) {
        const ctx = this.ctx;
        for (const [m, v] of [[1, 1], [2.76, 0.3], [5.4, 0.12]]) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = "sine"; o.frequency.value = freq * m;
            g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol * v, t + 0.005);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4 / m);
            o.connect(g).connect(dest || this.sfx);
            o.start(t); o.stop(t + 1.5);
        }
    }

    get ok() { return !!this.ctx && !this.muted; }

    knock() {
        const ctx = this.ctx, t = ctx.currentTime;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.12);
        g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 0.2);
        const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g2 = ctx.createGain();
        src.buffer = this.noise; f.type = "lowpass"; f.frequency.value = 1200;
        g2.gain.setValueAtTime(0.2, t); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
        src.connect(f).connect(g2).connect(this.sfx); src.start(t); src.stop(t + 0.12);
    }
    place(matches) {
        if (!this.ok) return;
        this.knock();
        const t = this.ctx.currentTime;
        for (let i = 0; i < matches; i++) this.bell(midi(72 + PENTA[i % 5] + 12 * Math.floor(i / 5)), t + 0.06 + i * 0.07, 0.07);
    }
    perfect() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        [0, 4, 7, 11, 14, 19].forEach((n, i) => this.bell(midi(76 + n), t + 0.5 + i * 0.06, 0.06));
    }
    quest() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        [[0, 4, 7], [5, 9, 12], [7, 11, 14, 19]].forEach((ch, k) => ch.forEach((n) => this.bell(midi(67 + n), t + k * 0.22, 0.06)));
    }
    rotate() { if (this.ok) this.bell(midi(88), this.ctx.currentTime, 0.02); }
    deny() {
        if (!this.ok) return;
        const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = "triangle"; o.frequency.value = 150;
        g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 0.16);
    }
    end() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        [79, 76, 72, 67, 64, 60].forEach((n, i) => this.bell(midi(n), t + i * 0.18, 0.06));
    }
}
