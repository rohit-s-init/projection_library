// CHROMA DROP — bounce a glossy ball down a spinning helix tower. Rendered with the projection3d library (Space).
//
// Drag (or ← →) to spin the tower so the ball drops through the gaps. Each ring you fall through bursts apart
// and scores; falling through 3+ rings in a row sets the ball on fire, and a fiery ball smashes straight
// through the next ring — even the red parts. Touch red without fire and it's over. Reach the gold ring at
// the bottom to clear the level; every level is taller, meaner and has a new colour palette.
//
// Rendering: the sky quad lives in Space's buffers; the tower, ball, splats, shards and glows are rebuilt into
// GameSpace's dynamic buffers every frame (solid → translucent → additive).

import GameSpace from "./GameSpace.js";
import { createProgram } from "./shaders.js";
import { Audio } from "./audio.js";

// ------------------------------------------------------------------ tuning

const SEG = 12, SEG_A = (Math.PI * 2) / SEG;
const R0 = 0.85, R1 = 2.95, THICK = 0.42, SPACING = 3.3;
const BALL_R = 0.32, BALL_DIST = 1.9, BALL_ANG = -Math.PI / 2;      // the ball sits in front of the tower, facing the camera
const GRAVITY = 36, BOUNCE_V = 12.4;
const GAP = 1, DANGER = 2, FINISH = 3, NORMAL = 0;

const PALETTES = [
    { top: [0.99, 0.8, 0.86], bottom: [0.62, 0.78, 1.0], pillar: [1.0, 0.97, 0.93], a: [0.45, 0.72, 1.0], b: [0.58, 0.82, 1.0], ball: [1.0, 0.36, 0.55] },
    { top: [1.0, 0.9, 0.72], bottom: [1.0, 0.62, 0.62], pillar: [1.0, 0.96, 0.9], a: [0.98, 0.55, 0.42], b: [1.0, 0.7, 0.5], ball: [0.35, 0.6, 1.0] },
    { top: [0.8, 1.0, 0.9], bottom: [0.45, 0.8, 0.8], pillar: [0.97, 1.0, 0.98], a: [0.3, 0.8, 0.62], b: [0.46, 0.9, 0.72], ball: [1.0, 0.55, 0.2] },
    { top: [0.88, 0.8, 1.0], bottom: [0.55, 0.48, 0.9], pillar: [0.98, 0.96, 1.0], a: [0.62, 0.5, 0.98], b: [0.76, 0.64, 1.0], ball: [1.0, 0.85, 0.25] },
    { top: [1.0, 0.95, 0.8], bottom: [0.98, 0.72, 0.4], pillar: [1.0, 0.98, 0.92], a: [0.98, 0.78, 0.3], b: [1.0, 0.86, 0.45], ball: [0.4, 0.4, 0.95] },
    { top: [0.78, 0.94, 1.0], bottom: [0.4, 0.62, 0.95], pillar: [0.95, 0.98, 1.0], a: [0.3, 0.55, 0.95], b: [0.42, 0.68, 1.0], ball: [1.0, 0.4, 0.4] },
    { top: [1.0, 0.84, 0.95], bottom: [0.85, 0.45, 0.8], pillar: [1.0, 0.95, 0.99], a: [0.9, 0.42, 0.78], b: [0.98, 0.58, 0.86], ball: [0.3, 0.85, 0.7] },
];
const DANGER_COL = [1.0, 0.14, 0.2], FINISH_COL = [1.0, 0.78, 0.2];
const AUTOPLAY = new URLSearchParams(location.search).has("autoplay");      // demo / testing: the game plays itself

// ------------------------------------------------------------------ mesh writer (Space format)

class Mesh {
    constructor(verts = 65536) { this.pos = new Float32Array(verts * 4); this.col = new Float32Array(verts * 4); this.n = 0; }
    reset() { this.n = 0; }
    grow() { const p = new Float32Array(this.pos.length * 2), c = new Float32Array(this.col.length * 2); p.set(this.pos); c.set(this.col); this.pos = p; this.col = c; }
    v(x, y, z, w, r, g, b, mat) {
        if ((this.n + 1) * 4 > this.pos.length) this.grow();
        const o = this.n++ * 4;
        this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z; this.pos[o + 3] = w;
        this.col[o] = r; this.col[o + 1] = g; this.col[o + 2] = b; this.col[o + 3] = mat;
    }
    tri(a, b, c, col, mat, w = 1) { this.v(...a, w, ...col, mat); this.v(...b, w, ...col, mat); this.v(...c, w, ...col, mat); }
    quad(a, b, c, d, col, mat, w = 1) { this.tri(a, b, c, col, mat, w); this.tri(a, c, d, col, mat, w); }
    sprite(x, y, z, size, r, g, b) { for (const k of [0, 1, 2, 0, 2, 3]) this.v(x, y, z, size + k * 100, r, g, b, 5); }
    append(o) {
        while ((this.n + o.n) * 4 > this.pos.length) this.grow();
        this.pos.set(o.pos.subarray(0, o.n * 4), this.n * 4); this.col.set(o.col.subarray(0, o.n * 4), this.n * 4);
        this.n += o.n;
    }
}

// ------------------------------------------------------------------ canvas + library

const canvas = document.getElementById("view");
/** @type {WebGLRenderingContext} */
const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
function sizeCanvas() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * dpr); canvas.height = Math.round(innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
}
sizeCanvas();
addEventListener("resize", sizeCanvas);

const space = new GameSpace(gl);
const U = createProgram(gl, space);
const audio = new Audio();
{
    const m = new Mesh(16);
    m.tri([-1, -1, 0], [1, -1, 0], [1, 1, 0], [0, 0, 0], 3);
    m.tri([-1, -1, 0], [1, 1, 0], [-1, 1, 0], [0, 0, 0], 3);
    space.setStatic(m.pos, m.col, m.n);
}

// ------------------------------------------------------------------ state

const save = (() => { try { return Object.assign({ best: 0, level: 1 }, JSON.parse(localStorage.getItem("chroma.save")) || {}); } catch { return { best: 0, level: 1 }; } })();
const persist = () => { try { localStorage.setItem("chroma.save", JSON.stringify(save)); } catch { } };

let state = "title";          // title | play | dead | clear
let level = save.level, pal = PALETTES[(level - 1) % PALETTES.length];
let rings = [], pieces = [], particles = [];
let theta = 0, thetaVel = 0;
const ball = { z: 2, vz: 0, squash: 0, fire: false, alive: true };
let combo = 0, score = 0, passed = 0;
let camZ = 0, shake = 0, flash = 0, time = 0;
const trail = [];

function rngFor(seed) {
    return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// each level's tower is the same every time you retry it
function buildLevel(lv) {
    const rng = rngFor(lv * 7919 + 13);
    const n = 10 + Math.min(lv * 2, 34);
    rings = [];
    for (let i = 0; i < n; i++) {
        const segs = new Array(SEG).fill(NORMAL);
        const gapLen = lv > 6 && rng() < 0.5 ? 2 : lv > 12 && rng() < 0.3 ? 1 : 3;
        const g = Math.floor(rng() * SEG);
        for (let k = 0; k < gapLen; k++) segs[(g + k) % SEG] = GAP;
        if (i > 0) {
            const nd = Math.min(5, Math.floor(lv / 2) + (rng() < 0.4 ? 1 : 0) + Math.floor(i / 12));
            for (let d = 0; d < nd; d++) {
                const k = Math.floor(rng() * SEG);
                if (segs[k] === NORMAL && segs[(k + 1) % SEG] !== GAP && segs[(k + SEG - 1) % SEG] !== GAP) segs[k] = DANGER;
            }
        }
        rings.push({ z: -i * SPACING, segs, broken: false, passed: false, splats: [], color: i % 2 ? pal.b : pal.a, spin: 0 });
    }
    rings.push({ z: -n * SPACING, segs: new Array(SEG).fill(FINISH), broken: false, passed: false, splats: [], color: FINISH_COL, finish: true });
    // start with the ball above a solid part of the first ring
    theta = 0;
    const first = rings[0].segs;
    for (let k = 0; k < SEG && first[segIndex()] !== NORMAL; k++) theta += SEG_A;
}

function segIndex(t = theta) {
    const a = (((BALL_ANG - t) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return Math.floor(a / SEG_A) % SEG;
}

function startLevel(lv) {
    level = lv;
    pal = PALETTES[(lv - 1) % PALETTES.length];
    buildLevel(lv);
    pieces = []; particles = []; trail.length = 0;
    Object.assign(ball, { z: 2.2, vz: 0, squash: 0, fire: false, alive: true });
    combo = 0; passed = 0; camZ = 0;
    ui.progress();
}

function play() {
    audio.init();
    state = "play";
    score = 0;
    startLevel(level);
    ui.show("hud");
}

// ------------------------------------------------------------------ gameplay

function shatter(ring, smashed) {
    ring.broken = true;
    const base = theta;
    ring.segs.forEach((t, k) => {
        if (t === GAP) return;
        pieces.push({
            z: ring.z, a0: k * SEG_A + base, type: t, color: t === DANGER ? DANGER_COL : ring.color,
            vr: 2.5 + Math.random() * 3.5, vz: (smashed ? 3 : 1) + Math.random() * 4, spin: (Math.random() - 0.5) * 3,
            r: 0, dz: 0, da: 0, life: 1,
        });
    });
    for (const s of ring.splats) s.gone = true;
}

function passRing(ring) {
    ring.passed = true;
    passed++;
    combo++;
    score += combo * (ball.fire ? 2 : 1);
    audio.pass(combo);
    shatter(ring, false);
    popup(combo > 1 ? `+${combo}` : "+1", combo >= 3 ? "big" : "");
    if (combo === 3 && !ball.fire) { ball.fire = true; audio.fire(); popup("ON FIRE!", "fire"); }
    ui.progress();
}

function land(ring) {
    const t = ring.segs[segIndex()];
    if (ring.finish && state === "play") { levelClear(); return; }
    if (ball.fire && state === "play") {                                                   // fiery ball smashes straight through
        ring.passed = true;
        passed++;
        score += 5 + combo;
        audio.smash();
        shatter(ring, true);
        burst(0, -BALL_DIST, ring.z, 40, [1, 0.6, 0.2], 6);
        popup("SMASH!", "fire");
        shake = 0.35; flash = 0.25;
        ball.fire = false; combo = 0;
        ui.progress();
        return;
    }
    if (t === DANGER && state === "play") { die(); return; }
    // bounce
    ball.z = ring.z + BALL_R;
    ball.vz = BOUNCE_V;
    ball.squash = 1;
    combo = 0;
    audio.bounce();
    const a = BALL_ANG - theta;
    const pts = Array.from({ length: 10 }, (_, i) => 0.32 + Math.random() * 0.2);
    ring.splats.push({ a, pts, col: pal.ball.map((c) => c * 0.85) });
    if (ring.splats.length > 5) ring.splats.shift();
    burst(0, -BALL_DIST, ring.z + 0.05, 8, pal.ball, 2.2);
}

function die() {
    ball.alive = false;
    state = "dead";
    audio.die();
    shake = 0.6; flash = 0.35;
    burst(0, -BALL_DIST, ball.z, 50, pal.ball, 5);
    save.best = Math.max(save.best, score);
    persist();
    setTimeout(() => ui.over(), 700);
}

function levelClear() {
    state = "clear";
    ball.vz = BOUNCE_V * 0.8;
    audio.level();
    flash = 0.3;
    for (let i = 0; i < 160; i++) {
        const P = PALETTES[i % PALETTES.length];
        const c = [P.a, P.ball, FINISH_COL][i % 3];
        particles.push({ x: (Math.random() - 0.5) * 3, y: -BALL_DIST + (Math.random() - 0.5) * 2, z: ball.z + 0.5, vx: (Math.random() - 0.5) * 9, vy: (Math.random() - 0.5) * 6, vz: 4 + Math.random() * 9, life: 1.6 + Math.random(), max: 2.6, size: 0.14, col: c, g: 9 });
    }
    save.level = level + 1;
    save.best = Math.max(save.best, score);
    persist();
    ui.banner(`LEVEL ${level} COMPLETE`);
    setTimeout(() => { if (state === "clear") { state = "play"; startLevel(level + 1); } }, 1800);
}

function burst(x, y, z, n, col, spd) {
    for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.28, s = spd * (0.3 + Math.random() * 0.7);
        particles.push({ x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: Math.random() * spd, life: 0.5 + Math.random() * 0.4, max: 0.9, size: 0.1, col, g: 10 });
    }
}

// the title screen's demo: spin towards the gap of the next ring
function autopilot(dt) {
    const next = rings.find((r) => !r.passed && !r.broken);
    if (!next) return;
    let bestK = -1, bestD = 1e9;
    next.segs.forEach((t, k) => {
        if (t !== GAP) return;
        const target = BALL_ANG - (k + 0.5) * SEG_A;
        const d = Math.atan2(Math.sin(target - theta), Math.cos(target - theta));
        if (Math.abs(d) < Math.abs(bestD)) { bestD = d; bestK = k; }
    });
    if (bestK >= 0 && ball.z < next.z + 2.6) theta += Math.sign(bestD) * Math.min(Math.abs(bestD), dt * 6);
}

// ------------------------------------------------------------------ input

let drag = null;
const keys = new Set();
canvas.addEventListener("pointerdown", (e) => { audio.init(); drag = { x: e.clientX }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointermove", (e) => {
    if (!drag || state !== "play") return;
    const dx = e.clientX - drag.x;
    drag.x = e.clientX;
    theta += dx * 0.0115;
    thetaVel = dx * 0.0115 * 60;
});
addEventListener("pointerup", () => { drag = null; });
addEventListener("keydown", (e) => {
    audio.init();
    keys.add(e.code);
    if (e.code === "KeyM") { ui.toast(audio.toggleMute() ? "Sound off" : "Sound on"); return; }
    if ((e.code === "Space" || e.code === "Enter") && (state === "title" || state === "dead")) play();
});
addEventListener("keyup", (e) => keys.delete(e.code));

// ------------------------------------------------------------------ update

function update(dt) {
    time += dt;
    if (state === "play") {
        const dir = (keys.has("ArrowRight") || keys.has("KeyD") ? 1 : 0) - (keys.has("ArrowLeft") || keys.has("KeyA") ? 1 : 0);
        theta += dir * 3.6 * dt;
    }
    if (state === "title" || (AUTOPLAY && state === "play")) autopilot(dt);

    if (ball.alive && state !== "dead") {
        const prevBottom = ball.z - BALL_R;
        ball.vz -= GRAVITY * dt;
        ball.vz = Math.max(ball.vz, -24);
        ball.z += ball.vz * dt;
        const bottom = ball.z - BALL_R;
        for (const ring of rings) {
            if (ring.broken || ring.passed) continue;
            // falling onto the ring's top surface
            if (ball.vz < 0 && prevBottom >= ring.z - 0.001 && bottom < ring.z) {
                if (ring.segs[segIndex()] !== GAP) { land(ring); break; }
            }
            // fell all the way through it
            if (ball.z + BALL_R < ring.z - THICK) {
                if (state === "title") { ring.passed = true; shatter(ring, false); } else passRing(ring);
            }
        }
        if (state === "title" && ball.z < rings[rings.length - 1].z + 3) startLevel(level);    // loop the demo
    }

    ball.squash = Math.max(0, ball.squash - dt * 6);
    // camera follows the ball down (never back up)
    const want = Math.min(camZ, ball.z);
    camZ += (want - camZ) * Math.min(1, dt * 6);
    if (ball.z < camZ - 1) camZ = ball.z + 1;

    // shards
    for (const p of pieces) {
        p.r += p.vr * dt; p.vz -= 14 * dt; p.dz += p.vz * dt; p.da += p.spin * dt; p.life -= dt * 1.1;
    }
    pieces = pieces.filter((p) => p.life > 0);
    for (const p of particles) {
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vz -= p.g * dt;
        const d = Math.exp(-dt * 1.5); p.vx *= d; p.vy *= d; p.life -= dt;
    }
    particles = particles.filter((p) => p.life > 0);
    if (ball.alive) {
        trail.unshift(ball.z);
        if (trail.length > 14) trail.pop();
        if (ball.fire) for (let i = 0; i < 3; i++) particles.push({ x: (Math.random() - 0.5) * 0.3, y: -BALL_DIST + (Math.random() - 0.5) * 0.3, z: ball.z, vx: (Math.random() - 0.5), vy: (Math.random() - 0.5), vz: 3 + Math.random() * 2, life: 0.4, max: 0.4, size: 0.22, col: [1.2, 0.5, 0.1], g: -2 });
    }
    shake = Math.max(0, shake - dt * 2);
    flash = Math.max(0, flash - dt * 2);
}

// ------------------------------------------------------------------ rendering

const solid = new Mesh(40000), alpha = new Mesh(20000), glow = new Mesh(8000);
const SPHERE = (() => {        // icosphere for the ball
    const t = (1 + Math.sqrt(5)) / 2;
    let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const nrm = (p) => { const l = Math.hypot(...p); return p.map((c) => c / l); };
    v = v.map(nrm);
    for (let l = 0; l < 3; l++) {
        const cache = new Map(), nf = [];
        const mid = (a, b) => { const k = Math.min(a, b) * 1e5 + Math.max(a, b); if (!cache.has(k)) { cache.set(k, v.length); v.push(nrm(v[a].map((c, i) => (c + v[b][i]) / 2))); } return cache.get(k); };
        for (const [a, b, c] of f) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
        f = nf;
    }
    return { v, f };
})();

// one tower segment between angles a0..a1, top at zt; rOff/zOff move it (for shards)
function segment(m, zt, a0, a1, col, mat, rOff = 0, zOff = 0, w = 1) {
    const zb = zt - THICK, n = 3, P = (r, a, z) => [Math.cos(a) * (r + rOff), Math.sin(a) * (r + rOff), z + zOff];
    const e = 0.006;
    a0 += e; a1 -= e;
    for (let i = 0; i < n; i++) {
        const b0 = a0 + (a1 - a0) * i / n, b1 = a0 + (a1 - a0) * (i + 1) / n;
        m.quad(P(R0, b0, zt), P(R1, b0, zt), P(R1, b1, zt), P(R0, b1, zt), col, mat, w);
        m.quad(P(R0, b0, zb), P(R0, b1, zb), P(R1, b1, zb), P(R1, b0, zb), col.map((c) => c * 0.75), mat, w);
        m.quad(P(R1, b0, zb), P(R1, b1, zb), P(R1, b1, zt), P(R1, b0, zt), col.map((c) => c * 0.92), mat, w);
        m.quad(P(R0, b1, zb), P(R0, b0, zb), P(R0, b0, zt), P(R0, b1, zt), col.map((c) => c * 0.85), mat, w);
    }
    m.quad(P(R0, a0, zb), P(R1, a0, zb), P(R1, a0, zt), P(R0, a0, zt), col.map((c) => c * 0.88), mat, w);
    m.quad(P(R1, a1, zb), P(R0, a1, zb), P(R0, a1, zt), P(R1, a1, zt), col.map((c) => c * 0.88), mat, w);
}

function buildDynamic() {
    solid.reset(); alpha.reset(); glow.reset();
    const zTop = camZ + 9, zBot = camZ - 42;

    // central pillar with soft bands
    const pz0 = Math.max(zBot, rings[rings.length - 1].z - 2), pz1 = zTop;
    const sides = 24;
    for (let z = Math.floor(pz1 / 1.65) * 1.65; z > pz0; z -= 1.65) {
        const band = Math.round(z / 1.65) % 2 === 0 ? 1 : 0.93;
        const c = pal.pillar.map((v) => v * band);
        for (let i = 0; i < sides; i++) {
            const a0 = (i / sides) * Math.PI * 2 + theta, a1 = ((i + 1) / sides) * Math.PI * 2 + theta;
            solid.quad([Math.cos(a0) * R0, Math.sin(a0) * R0, z - 1.65], [Math.cos(a1) * R0, Math.sin(a1) * R0, z - 1.65],
                [Math.cos(a1) * R0, Math.sin(a1) * R0, z], [Math.cos(a0) * R0, Math.sin(a0) * R0, z], c, 0);
        }
    }

    // rings
    rings.forEach((ring) => {
        if (ring.broken || ring.z > zTop || ring.z < zBot) return;
        ring.segs.forEach((t, k) => {
            if (t === GAP) return;
            const a0 = k * SEG_A + theta, a1 = a0 + SEG_A;
            const col = t === DANGER ? DANGER_COL : t === FINISH ? FINISH_COL : ring.color;
            segment(solid, ring.z, a0, a1, col, t === DANGER || t === FINISH ? 1 : 0);
        });
        // paint splats where the ball bounced
        for (const s of ring.splats) {
            const a = s.a + theta, cx = Math.cos(a) * BALL_DIST, cy = Math.sin(a) * BALL_DIST, z = ring.z + 0.006;
            s.pts.forEach((r, i) => {
                const b0 = (i / s.pts.length) * Math.PI * 2, b1 = ((i + 1) / s.pts.length) * Math.PI * 2, r1 = s.pts[(i + 1) % s.pts.length];
                solid.tri([cx, cy, z], [cx + Math.cos(b0) * r, cy + Math.sin(b0) * r, z], [cx + Math.cos(b1) * r1, cy + Math.sin(b1) * r1, z], s.col, 4);
            });
        }
    });

    // flying shards of broken rings
    for (const p of pieces) {
        const col = p.color;
        segment(alpha, p.z, p.a0 + p.da, p.a0 + p.da + SEG_A, col, 6, p.r, p.dz, Math.max(0, p.life));
    }

    // ball (squashes on bounce) with a soft shadow on the ring below
    if (ball.alive) {
        const sq = Math.sin(ball.squash * Math.PI) * 0.28, sx = 1 + sq * 0.6, sz = 1 - sq;
        const bx = 0, by = -BALL_DIST, bz = ball.z - BALL_R * (1 - sz);
        const col = ball.fire ? [1.0, 0.55, 0.18] : pal.ball;
        for (const [a, b, c] of SPHERE.f) {
            const P = (i) => [bx + SPHERE.v[i][0] * BALL_R * sx, by + SPHERE.v[i][1] * BALL_R * sx, bz + SPHERE.v[i][2] * BALL_R * sz];
            solid.tri(P(a), P(b), P(c), col, 2);
        }
        const below = rings.find((r) => !r.broken && !r.passed && r.z < ball.z - BALL_R + 0.01);
        if (below && below.segs[segIndex()] !== GAP) {
            const h = ball.z - below.z, s = Math.max(0.15, 0.42 - h * 0.05), a = Math.max(0.08, 0.35 - h * 0.05);
            for (let i = 0; i < 12; i++) {
                const b0 = i / 12 * 6.28, b1 = (i + 1) / 12 * 6.28;
                alpha.tri([bx, by, below.z + 0.01], [bx + Math.cos(b0) * s, by + Math.sin(b0) * s, below.z + 0.01], [bx + Math.cos(b1) * s, by + Math.sin(b1) * s, below.z + 0.01], [0.05, 0.05, 0.12], 6, a);
            }
        }
        // trail
        trail.forEach((z, i) => {
            const f = 1 - i / trail.length;
            const c = ball.fire ? [1.0, 0.45, 0.12] : pal.ball;
            glow.sprite(bx, by, z, BALL_R * (0.9 * f + 0.2), c[0] * 0.35 * f, c[1] * 0.35 * f, c[2] * 0.35 * f);
        });
        if (ball.fire) glow.sprite(bx, by, ball.z, 1.2, 1.0, 0.45, 0.1);
    }
    for (const p of particles) {
        const f = Math.max(0, p.life / p.max);
        glow.sprite(p.x, p.y, p.z, p.size * (0.5 + f), p.col[0] * f, p.col[1] * f, p.col[2] * f);
    }
    const sN = solid.n; solid.append(alpha);
    const aN = alpha.n; solid.append(glow);
    space.setDynamic(solid.pos, solid.col, solid.n);
    return { sN, aN, gN: glow.n };
}

function render() {
    const sx = (Math.random() - 0.5) * shake * 0.5, sz = (Math.random() - 0.5) * shake * 0.5;
    space.magnifier = canvas.width / canvas.height < 1 ? 1.2 : 1.85;           // wider view on portrait screens
    space.lookAt(sx, -11.5, camZ + 4.6 + sz, 0, 0, camZ - 1.2);
    const { sN, aN, gN } = buildDynamic();
    gl.uniform1f(U.aspect, canvas.width / canvas.height);
    gl.uniform3f(U.veriables, space.zShifter, space.magnifier, 0);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, time);
    gl.uniform3fv(U.uTop, pal.top);
    gl.uniform3fv(U.uBottom, pal.bottom);
    gl.uniform3f(U.uBall, 0, -BALL_DIST, ball.z);
    gl.uniform1f(U.uFlash, flash * flash);
    space.applyCamera();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    space.bind(false); space.draw(0, 6);
    space.bind(true);
    space.draw(0, sN);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    space.draw(sN, aN);
    gl.blendFunc(gl.ONE, gl.ONE);
    space.draw(sN + aN, gN);
    gl.depthMask(true); gl.disable(gl.BLEND);
}

// ------------------------------------------------------------------ UI

const $ = (id) => document.getElementById(id);
function project(x, y, z) {
    const X = space.xUnitVec, Y = space.yUnitVec, Z = space.zUnitVec;
    const dx = x - space.Xc, dy = y - space.Yc, dz = z - space.Zc, zp = dx * Z[0] + dy * Z[1] + dz * Z[2];
    const k = space.magnifier / 1.6 / zp;
    return [(-(dx * X[0] + dy * X[1] + dz * X[2]) * k + 1) / 2 * innerWidth, (1 - (dx * Y[0] + dy * Y[1] + dz * Y[2]) * k * (canvas.width / canvas.height)) / 2 * innerHeight];
}
function popup(text, kind) {
    if (state === "title") return;
    const [x, y] = project(0.9, -BALL_DIST, ball.z + 0.6);
    const el = document.createElement("div");
    el.className = `pop ${kind}`; el.textContent = text;
    el.style.left = x + "px"; el.style.top = y + "px";
    $("popups").appendChild(el);
    setTimeout(() => el.remove(), 900);
}
const css = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
const ui = {
    show(which) { for (const id of ["title", "hud", "over"]) $(id).classList.toggle("hidden", id !== which); this.progress(); },
    progress() {
        const total = rings.length - 1;
        $("lvA").textContent = level; $("lvB").textContent = level + 1;
        $("fill").style.width = `${Math.min(100, (passed / total) * 100)}%`;
        $("fill").style.background = `linear-gradient(90deg, ${css(pal.a)}, ${css(pal.ball)})`;
        $("lvA").style.background = css(pal.ball);
        $("score").textContent = score;
        $("bestv").textContent = Math.max(save.best, score);
    },
    over() {
        this.show("over");
        $("o-score").textContent = score;
        $("o-best").textContent = `Best ${save.best}`;
        $("o-level").textContent = `Level ${level} · ${Math.round(passed / (rings.length - 1) * 100)}% done`;
    },
    banner(t) { const b = $("banner"); b.textContent = t; b.classList.remove("show"); void b.offsetWidth; b.classList.add("show"); },
    toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 1200); },
};
$("title").addEventListener("click", play);
$("over").addEventListener("click", play);
$("t-best").textContent = save.best;
$("t-level").textContent = save.level;

// ------------------------------------------------------------------ loop

startLevel(level);
ui.show("title");
if (AUTOPLAY) play();
let last = performance.now();
function frame(now) {
    const dt = Math.max(0, Math.min(0.033, (now - last) / 1000));
    last = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
