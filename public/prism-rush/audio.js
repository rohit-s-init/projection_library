// Procedural synthwave soundtrack and sound effects (Web Audio, nothing to download).
// Music: 112 BPM, A-minor progression — sawtooth bass, square arpeggio with echo, kick / snare / hi-hat.
// The orb pickup chime climbs a pentatonic scale as the combo grows.

const BPM = 112;
const STEP = 60 / BPM / 4;                          // a sixteenth note
// chord roots (A minor, F, C, G) as MIDI notes, 4 bars each 16 steps
const ROOTS = [45, 41, 48, 43];
const ARP = [0, 7, 12, 15, 12, 7, 3, 7];
const PENTA = [0, 3, 5, 7, 10];
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class Audio {
    constructor() {
        this.ctx = null;
        this.muted = false;
        try { this.muted = localStorage.getItem("prism.muted") === "1"; } catch { }
        this.intensity = 0;                         // 0 menu (bass + pad) … 1 running (everything)
        this.startTime = 0;
    }

    // must be called from a user gesture (browsers block audio before that)
    init() {
        if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = this.ctx = new AC();
        this.master = ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.55;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14; comp.ratio.value = 4;
        this.master.connect(comp).connect(ctx.destination);
        this.music = ctx.createGain(); this.music.gain.value = 0.55; this.music.connect(this.master);
        this.sfx = ctx.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master);
        // echo for the arpeggio
        this.delay = ctx.createDelay(1); this.delay.delayTime.value = STEP * 3;
        const fb = ctx.createGain(); fb.gain.value = 0.35;
        this.delay.connect(fb).connect(this.delay);
        this.delay.connect(this.music);
        // noise buffer for drums and whooshes
        const len = ctx.sampleRate;
        this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.startTime = ctx.currentTime + 0.05;
        this.nextStep = 0;
        this.timer = setInterval(() => this.schedule(), 25);
    }

    toggleMute() {
        this.muted = !this.muted;
        try { localStorage.setItem("prism.muted", this.muted ? "1" : "0"); } catch { }
        if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.55, this.ctx.currentTime, 0.05);
        return this.muted;
    }

    // 0..1, peaks on every beat (for pulsing visuals)
    beat() {
        if (!this.ctx) return 0;
        const t = (this.ctx.currentTime - this.startTime) / (STEP * 4);
        return Math.pow(1 - (t - Math.floor(t)), 4);
    }

    // ---- music scheduler (look-ahead)
    schedule() {
        const ctx = this.ctx;
        while (this.startTime + this.nextStep * STEP < ctx.currentTime + 0.12) {
            this.playStep(this.nextStep, this.startTime + this.nextStep * STEP);
            this.nextStep++;
        }
    }

    playStep(i, t) {
        const bar = Math.floor(i / 16) % 16, s = i % 16;
        const root = ROOTS[Math.floor(bar / 4) % 4];
        const full = this.intensity > 0.5;
        // bass: eighth notes, octave bounce
        if (s % 2 === 0) this.tone("sawtooth", midi(root + (s % 4 === 2 ? 12 : 0)), t, STEP * 1.8, 0.16, 380 + 900 * this.intensity);
        // arpeggio
        if (full || s % 4 === 0) this.tone("square", midi(root + 24 + ARP[s % 8]), t, STEP * 0.9, full ? 0.05 : 0.035, 2600, true);
        // pad on the bar
        if (s === 0) for (const n of [0, 3, 7]) this.tone("triangle", midi(root + 12 + n), t, STEP * 15, 0.035, 1200);
        if (!full) return;
        if (s % 4 === 0) this.kick(t);
        if (s === 4 || s === 12) this.snare(t);
        if (s % 2 === 1) this.hat(t, s % 4 === 3 ? 0.05 : 0.03);
    }

    tone(type, freq, t, dur, vol, cutoff, echo = false, dest) {
        const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
        o.type = type; o.frequency.value = freq;
        f.type = "lowpass"; f.frequency.value = cutoff; f.Q.value = 4;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(f).connect(g).connect(dest || this.music);
        if (echo) g.connect(this.delay);
        o.start(t); o.stop(t + dur + 0.05);
        return o;
    }

    noiseHit(t, dur, vol, type, freq, dest) {
        const ctx = this.ctx, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        src.buffer = this.noise;
        f.type = type; f.frequency.value = freq;
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(f).connect(g).connect(dest || this.music);
        src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
        return { src, f };
    }

    kick(t) {
        const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.setValueAtTime(140, t);
        o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
        g.gain.setValueAtTime(0.55, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.connect(g).connect(this.music);
        o.start(t); o.stop(t + 0.32);
    }
    snare(t) { this.noiseHit(t, 0.18, 0.22, "bandpass", 1800); this.tone("triangle", 190, t, 0.1, 0.08, 2000); }
    hat(t, v) { this.noiseHit(t, 0.05, v, "highpass", 7000); }

    // ---- sound effects
    get ok() { return !!this.ctx && !this.muted; }
    orb(combo) {
        if (!this.ok) return;
        const t = this.ctx.currentTime, k = Math.min(combo, 24);
        const note = 69 + 12 * Math.floor(k / 5) + PENTA[k % 5];
        this.tone("sine", midi(note), t, 0.22, 0.2, 6000, true, this.sfx);
        this.tone("triangle", midi(note + 12), t + 0.02, 0.12, 0.06, 6000, false, this.sfx);
    }
    whoosh() {
        if (!this.ok) return;
        const t = this.ctx.currentTime, n = this.noiseHit(t, 0.35, 0.3, "bandpass", 600, this.sfx);
        n.f.frequency.exponentialRampToValueAtTime(3500, t + 0.3);
        n.f.Q.value = 3;
    }
    jump() {
        if (!this.ok) return;
        const t = this.ctx.currentTime, o = this.tone("square", 220, t, 0.18, 0.08, 3000, false, this.sfx);
        o.frequency.exponentialRampToValueAtTime(660, t + 0.15);
    }
    powerup() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        [0, 4, 7, 12, 16].forEach((n, i) => this.tone("square", midi(72 + n), t + i * 0.05, 0.2, 0.07, 5000, true, this.sfx));
    }
    shieldBreak() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        this.noiseHit(t, 0.4, 0.4, "highpass", 2500, this.sfx);
        this.tone("sawtooth", 880, t, 0.3, 0.08, 4000, false, this.sfx).frequency.exponentialRampToValueAtTime(110, t + 0.3);
    }
    crash() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        this.noiseHit(t, 1.2, 0.6, "lowpass", 900, this.sfx);
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.9);
        g.gain.setValueAtTime(0.6, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 1.05);
    }
    zone() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        [0, 7, 12, 19].forEach((n, i) => this.tone("sawtooth", midi(57 + n), t + i * 0.08, 0.9, 0.05, 2400, true, this.sfx));
    }
    chime() {
        if (!this.ok) return;
        const t = this.ctx.currentTime;
        [0, 4, 7, 12].forEach((n, i) => this.tone("sine", midi(84 + n), t + i * 0.07, 0.5, 0.1, 8000, true, this.sfx));
    }
}
