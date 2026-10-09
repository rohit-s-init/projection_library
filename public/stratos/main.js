// STRATOS — stack glass slabs into the sky, rendered with the projection3d library (Space).
//
// A slab glides back and forth above the tower; tap (or Space) to drop it. Whatever hangs over the edge is sliced
// off and tumbles away, so the tower narrows unless you're precise. Perfect drops chain into a streak, and a long
// streak grows the slab back. The higher you climb, the more the world changes: the city falls away, you pass
// through the clouds, the sun sets, night falls, the aurora comes out and finally the stars of the stratosphere.
//
// Rendering: sky, city, the skyscraper the tower stands on and the cloud layers live in Space's buffers (built
// once). The tower, the moving slab, falling pieces and effects are rebuilt every frame into GameSpace's
// dynamic buffers.

import GameSpace from "./GameSpace.js";
import { createProgram } from "./shaders.js";
import { Audio } from "./audio.js";

const params = new URLSearchParams(location.search);
const SPEED = Math.max(1, Math.min(8, +params.get("speed") || 1));       // test/demo fast-forward
const H = 0.6;              // slab thickness
const START = 4;            // starting slab size
const PERFECT = 0.13;       // how close counts as perfect
const RANGE = 6.5;          // how far the slab swings

// ------------------------------------------------------------------ helpers

function mulberry32(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hsl(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const f = (n) => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0), f(8), f(4)];
}
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

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
    tri(a, b, c, col, mat = 0) { this.v(...a, 1, ...col, mat); this.v(...b, 1, ...col, mat); this.v(...c, 1, ...col, mat); }
    quad(a, b, c, d, col, mat = 0) { this.tri(a, b, c, col, mat); this.tri(a, c, d, col, mat); }
    sprite(x, y, z, size, r, g, b, mat = 5) { for (const k of [0, 1, 2, 0, 2, 3]) this.v(x, y, z, size + k * 100, r, g, b, mat); }
    append(o) {
        while ((this.n + o.n) * 4 > this.pos.length) this.grow();
        this.pos.set(o.pos.subarray(0, o.n * 4), this.n * 4); this.col.set(o.col.subarray(0, o.n * 4), this.n * 4);
        this.n += o.n;
    }
}
// an axis-aligned box: centre (x, y), from z0 to z0 + h
function box(m, x, y, z0, sx, sy, h, col, mat = 0, bottom = false) {
    const x0 = x - sx / 2, x1 = x + sx / 2, y0 = y - sy / 2, y1 = y + sy / 2, z1 = z0 + h;
    m.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col, mat);
    m.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], col, mat);
    m.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], col, mat);
    m.quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], col, mat);
    m.quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], col, mat);
    if (bottom) m.quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], col, mat);
}
// a box rotated by angle `a` about a horizontal axis (ax, ay) through its centre — for falling pieces
function spunBox(m, d, col) {
    const { x, y, z, sx, sy, sz, ax, ay, a } = d;
    const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    const R = [t * ax * ax + c, t * ax * ay, s * ay, t * ax * ay, t * ay * ay + c, -s * ax, -s * ay, s * ax, c];
    const P = (u, v, w) => [x + R[0] * u + R[1] * v + R[2] * w, y + R[3] * u + R[4] * v + R[5] * w, z + R[6] * u + R[7] * v + R[8] * w];
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const C = [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(-hx, hy, -hz), P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)];
    for (const [a1, b1, c1, d1] of [[4, 5, 6, 7], [3, 2, 1, 0], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) m.quad(C[a1], C[b1], C[c1], C[d1], col, 0);
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

// ------------------------------------------------------------------ static scene: the city and the clouds

const stat = new Mesh(200000);
let solidCount = 0, cloudCount = 0;
function buildStatic() {
    const m = stat, rng = mulberry32(2024);
    m.quad([-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], [0, 0, 0], 3);
    const G = -70;                                                   // street level
    for (let gx = -6; gx < 6; gx++) for (let gy = -6; gy < 6; gy++) m.quad([gx * 100, gy * 100, G], [gx * 100 + 100, gy * 100, G], [gx * 100 + 100, gy * 100 + 100, G], [gx * 100, gy * 100 + 100, G], [0, 0, 0], 6);
    // the skyscraper the tower is built on, with a crown of setbacks
    box(m, 0, 0, G, 6.4, 6.4, 50, [0.42, 0.46, 0.52], 1);
    box(m, 0, 0, G + 50, 5.6, 5.6, 14, [0.45, 0.48, 0.55], 1);
    box(m, 0, 0, G + 64, 4.9, 4.9, 6, [0.5, 0.52, 0.58], 1);
    for (const [x, y] of [[-2.6, -2.6], [2.6, -2.6], [2.6, 2.6], [-2.6, 2.6]]) box(m, x, y, -0.5, 0.18, 0.18, 0.6, [1.4, 1.1, 0.7], 2);   // beacons
    // the city: blocks of towers on a street grid, taller near the centre
    for (let gx = -22; gx <= 22; gx++) for (let gy = -22; gy <= 22; gy++) {
        if (Math.abs(gx) <= 0 && Math.abs(gy) <= 0) continue;
        const cx = gx * 9, cy = gy * 9, r = Math.hypot(cx, cy);
        if (r > 200) continue;
        const n = 1 + Math.floor(rng() * 3);
        for (let k = 0; k < n; k++) {
            const sx = 2.5 + rng() * 3.5, sy = 2.5 + rng() * 3.5;
            const x = cx + (rng() - 0.5) * (8 - sx), y = cy + (rng() - 0.5) * (8 - sy);
            if (Math.hypot(x, y) < 9) continue;
            const h = Math.min(52, (5 + rng() * 16) * (1 + 1.3 * Math.exp(-r / 50)) * (rng() < 0.08 ? 1.6 : 1));
            const tint = 0.3 + rng() * 0.25, col = [tint * (0.9 + rng() * 0.2), tint, tint * (1 + rng() * 0.25)];
            box(m, x, y, G, sx, sy, h, col, 1);
            if (rng() < 0.15) box(m, x, y, G + h, sx * 0.6, sy * 0.6, h * 0.15, col, 1);
            if (h > 30 && rng() < 0.5) box(m, x, y, G + h, 0.15, 0.15, 3, [1.6, 0.25, 0.2], 2);    // aircraft warning light
        }
    }
    solidCount = m.n;
    // cloud layers: soft puffs in clusters
    for (const [z0, count, spread] of [[14, 70, 70], [38, 60, 90], [70, 40, 120]]) {
        for (let i = 0; i < count; i++) {
            const a = rng() * 6.28, r = 12 + rng() * spread, cx = Math.cos(a) * r, cy = Math.sin(a) * r;
            for (let k = 0; k < 6; k++) m.sprite(cx + (rng() - 0.5) * 9, cy + (rng() - 0.5) * 9, z0 + (rng() - 0.5) * 2.5, 5 + rng() * 6, rng(), rng(), 0.5 + rng() * 0.5, 7);
        }
    }
    cloudCount = m.n - solidCount;
    space.setStatic(m.pos, m.col, m.n);
}
buildStatic();

// ------------------------------------------------------------------ sky by altitude

const SKY = [   // floor, top, horizon, sun direction, sun colour, cloud tint, night, aurora, fog
    [0, [0.08, 0.32, 0.95], [0.48, 0.68, 0.97], [-0.5, 0.62, 0.6], [1.0, 0.95, 0.85], [1.0, 1.0, 1.0], 0, 0, 0.0028],
    [35, [0.05, 0.25, 0.9], [0.45, 0.66, 0.97], [-0.55, 0.68, 0.45], [1.0, 0.92, 0.8], [1.0, 0.98, 0.95], 0, 0, 0.0024],
    [65, [0.28, 0.32, 0.66], [1.0, 0.6, 0.32], [-0.62, 0.78, 0.07], [1.0, 0.55, 0.25], [1.0, 0.68, 0.55], 0.1, 0, 0.003],
    [95, [0.07, 0.06, 0.22], [0.6, 0.28, 0.42], [-0.65, 0.75, -0.04], [0.9, 0.3, 0.25], [0.55, 0.35, 0.55], 0.6, 0.1, 0.003],
    [125, [0.01, 0.02, 0.07], [0.06, 0.09, 0.2], [-0.6, 0.6, -0.4], [0.15, 0.15, 0.3], [0.14, 0.17, 0.3], 1, 1, 0.0025],
    [180, [0.0, 0.0, 0.015], [0.02, 0.04, 0.12], [-0.6, 0.6, -0.4], [0.1, 0.1, 0.2], [0.08, 0.1, 0.2], 1, 0.5, 0.003],
];
function skyAt(f) {
    let i = 0;
    while (i < SKY.length - 2 && f > SKY[i + 1][0]) i++;
    const a = SKY[i], b = SKY[i + 1], t = Math.max(0, Math.min(1, (f - a[0]) / (b[0] - a[0])));
    const s = t * t * (3 - 2 * t);
    return { top: lerp3(a[1], b[1], s), hor: lerp3(a[2], b[2], s), sun: lerp3(a[3], b[3], s), sunCol: lerp3(a[4], b[4], s), cloud: lerp3(a[5], b[5], s), night: lerp(a[6], b[6], s), aurora: lerp(a[7], b[7], s), fog: lerp(a[8], b[8], s) };
}
const MILESTONES = { 10: "ABOVE THE CITY", 25: "THROUGH THE CLOUDS", 50: "GOLDEN HOUR", 75: "TWILIGHT", 100: "AURORA SKY", 150: "THE STRATOSPHERE", 200: "BEYOND" };

// ------------------------------------------------------------------ game state

const save = (() => { try { return Object.assign({ best: 0, games: 0 }, JSON.parse(localStorage.getItem("stratos.save")) || {}); } catch { return { best: 0, games: 0 }; } })();
const persist = () => { try { localStorage.setItem("stratos.save", JSON.stringify(save)); } catch { } };

let state = "title";
let tower = [], cur = null, debris = [], rings = [], sparks = [];
let combo = 0, bestCombo = 0, perfects = 0, hue0 = 200;
let time = 0, camTop = 0, zoomOut = 0, shownFloor = 0, overT = 0, skyF = 0;

const top = () => tower[tower.length - 1];
const colorFor = (i) => hsl(hue0 + i * 6.5, 0.75, 0.55);
function reset() {
    hue0 = Math.random() * 360;
    tower = [{ x: 0, y: 0, sx: START, sy: START, z: -H, col: colorFor(0) }];
    debris = []; rings = []; combo = 0; bestCombo = 0; perfects = 0; zoomOut = 0;
    const pre = +params.get("start") || 0;                       // testing: start with a tall tower
    for (let i = 0; i < pre; i++) { const n = tower.length; tower.push({ x: 0, y: 0, sx: START, sy: START, z: n * H - H, col: colorFor(n) }); }
    skyF = pre; camTop = pre * H;
    spawn();
    ui.score();
}
function spawn() {
    const t = top(), n = tower.length, axis = n % 2 ? "x" : "y";
    cur = { x: t.x, y: t.y, sx: t.sx, sy: t.sy, z: t.z + H, axis, dir: 1, col: colorFor(n) };
    cur[axis] = t[axis] - RANGE;
    cur.speed = Math.min(9.5, 4.2 + (n - 1) * 0.075);
}
function drop() {
    if (!cur) return;
    const t = top(), ax = cur.axis, sk = ax === "x" ? "sx" : "sy";
    const d = cur[ax] - t[ax], size = cur[sk];
    if (Math.abs(d) <= PERFECT) {
        cur[ax] = t[ax];
        combo++; perfects++; bestCombo = Math.max(bestCombo, combo);
        if (combo >= 4 && cur[sk] < START) {                       // a long streak grows the slab back
            cur[sk] = Math.min(START, cur[sk] + 0.25);
            audio.grow();
        }
        audio.perfect(combo);
        rings.push({ x: cur.x, y: cur.y, sx: cur.sx, sy: cur.sy, z: cur.z + H, t: 0, col: cur.col });
        for (let i = 0; i < 18 + combo * 3; i++) sparkle(cur);
        ui.perfect(combo);
    } else if (Math.abs(d) >= size) {
        debris.push(piece(cur, cur.x, cur.y, cur.sx, cur.sy, Math.sign(d)));
        cur = null;
        gameOver();
        return;
    } else {
        combo = 0;
        const keep = size - Math.abs(d), cutSize = Math.abs(d);
        const keepC = t[ax] + d / 2, cutC = keepC + Math.sign(d) * (keep / 2 + cutSize / 2);
        const pc = { ...cur };
        pc[ax] = cutC; pc[sk] = cutSize;
        debris.push(piece(cur, pc.x, pc.y, pc.sx, pc.sy, Math.sign(d)));
        cur[ax] = keepC; cur[sk] = keep;
        audio.cut(); audio.place(0, tower.length);
        ui.perfect(0);
    }
    tower.push({ x: cur.x, y: cur.y, sx: cur.sx, sy: cur.sy, z: cur.z, col: cur.col, land: 1 });
    const n = tower.length - 1;
    if (MILESTONES[n]) { ui.banner(MILESTONES[n]); audio.milestone(); }
    ui.score();
    spawn();
}
function piece(src, x, y, sx, sy, sign) {
    const ax = src.axis === "x" ? 0 : 1, ay = src.axis === "x" ? 1 : 0;   // tumble about the axis across the cut
    const v = src.axis === "x" ? [sign * 1.5, 0] : [0, sign * 1.5];
    return { x, y, z: src.z + H / 2, sx, sy, sz: H, vx: v[0], vy: v[1], vz: 0, ax, ay, a: 0, w: (src.axis === "x" ? -sign : sign) * (1.5 + Math.random() * 1.5), col: src.col, life: 6 };
}
function sparkle(s) {
    const edge = Math.random() * 4 | 0, u = Math.random() - 0.5;
    const x = s.x + (edge < 2 ? u * s.sx : (edge === 2 ? -0.5 : 0.5) * s.sx), y = s.y + (edge >= 2 ? u * s.sy : (edge === 0 ? -0.5 : 0.5) * s.sy);
    sparks.push({ x, y, z: s.z + H, vx: (x - s.x) * 0.6, vy: (y - s.y) * 0.6, vz: 1 + Math.random() * 2.5, life: 0.8 + Math.random() * 0.6, col: s.col });
}
function gameOver() {
    if (state === "title") { setTimeout(() => { if (state === "title") reset(); }, 1500); return; }
    state = "over"; overT = 0;
    audio.fall();
    const floors = tower.length - 1, best = floors > save.best;
    if (best) save.best = floors;
    save.games++; persist();
    setTimeout(() => ui.over(floors, best), 1100 / SPEED);
}
function start() {
    if (state === "over" && overT < 1.0) return;
    state = "play"; reset(); ui.show("hud");
}

// ------------------------------------------------------------------ input

const tap = () => {
    audio.init();
    if (state === "title") { start(); return; }
    if (state === "over") { start(); return; }
    drop();
};
canvas.addEventListener("pointerdown", tap);
for (const id of ["title", "over"]) document.getElementById(id).addEventListener("pointerdown", tap);
addEventListener("keydown", (e) => {
    if (e.code === "KeyM") { audio.init(); ui.toast(audio.toggleMute() ? "Sound off" : "Sound on"); return; }
    if (e.repeat) return;
    if (e.code === "Space" || e.code === "Enter" || e.code === "ArrowDown") { e.preventDefault(); tap(); }
});

// ------------------------------------------------------------------ update

let robotAim = 0;
function update(dt) {
    time += dt;
    if (cur) {
        const t = top(), ax = cur.axis;
        cur[ax] += cur.dir * cur.speed * dt;
        if (cur[ax] > t[ax] + RANGE) { cur[ax] = t[ax] + RANGE; cur.dir = -1; }
        if (cur[ax] < t[ax] - RANGE) { cur[ax] = t[ax] - RANGE; cur.dir = 1; }
        // the demo robot (title screen, ?autoplay): mostly precise, now and then a little off
        if (state === "title" || params.has("autoplay")) {
            if (robotAim === null) robotAim = Math.random() < 0.75 ? 0 : (Math.random() - 0.5) * 0.9;
            if (Math.abs(cur[ax] - (t[ax] + robotAim)) < cur.speed * dt * 0.7) { robotAim = null; drop(); }
        }
    }
    if (state === "title" && tower.length > 60) reset();
    for (const s of tower) if (s.land) s.land = Math.max(0, s.land - dt * 5);
    for (const d of debris) { d.vz -= 18 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt; d.a += d.w * dt; d.life -= dt; }
    debris = debris.filter((d) => d.life > 0 && d.z > -75);
    for (const r of rings) r.t += dt;
    rings = rings.filter((r) => r.t < 0.9);
    for (const s of sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt; s.vz -= 3 * dt; s.life -= dt; }
    sparks = sparks.filter((s) => s.life > 0);
    if (state === "over") overT += dt;
    // the camera rides up with the tower; after a fall it pulls back to show the whole thing
    camTop += (top().z + H - camTop) * Math.min(1, dt * 3);
    zoomOut += ((state === "over" ? 1 : 0) - zoomOut) * Math.min(1, dt * 1.2);
    skyF += (tower.length - 1 - skyF) * Math.min(1, dt * 0.8);
}

// ------------------------------------------------------------------ per-frame geometry

const solid = new Mesh(60000), glow = new Mesh(20000);
function slabMesh(s, z, lift = 0) {
    const col = s.col;
    box(solid, s.x, s.y, z + lift, s.sx, s.sy, H, col, 0);
    // a bright seam where slabs meet
    const k = 0.25;
    solid.quad([s.x - s.sx / 2, s.y - s.sy / 2 - 0.002, z + lift + 0.02], [s.x + s.sx / 2, s.y - s.sy / 2 - 0.002, z + lift + 0.02], [s.x + s.sx / 2, s.y - s.sy / 2 - 0.002, z + lift + 0.06], [s.x - s.sx / 2, s.y - s.sy / 2 - 0.002, z + lift + 0.06], [col[0] + k, col[1] + k, col[2] + k], 2);
    solid.quad([s.x + s.sx / 2 + 0.002, s.y - s.sy / 2, z + lift + 0.02], [s.x + s.sx / 2 + 0.002, s.y + s.sy / 2, z + lift + 0.02], [s.x + s.sx / 2 + 0.002, s.y + s.sy / 2, z + lift + 0.06], [s.x + s.sx / 2 + 0.002, s.y - s.sy / 2, z + lift + 0.06], [col[0] + k, col[1] + k, col[2] + k], 2);
}
function buildDynamic() {
    solid.reset(); glow.reset();
    const first = Math.max(0, tower.length - (zoomOut > 0.05 ? 400 : 70));
    for (let i = first; i < tower.length; i++) {
        const s = tower[i];
        slabMesh(s, s.z, (s.land || 0) * 0.15);
    }
    if (cur) {
        slabMesh(cur, cur.z);
        // a soft glow under the moving slab and a guide line showing where the tower is
        const t = top();
        glow.sprite(cur.x, cur.y, cur.z + H / 2, Math.max(cur.sx, cur.sy) * 0.55, cur.col[0] * 0.12, cur.col[1] * 0.12, cur.col[2] * 0.12);
        const g = 0.25 + 0.1 * Math.sin(time * 6), x0 = t.x - t.sx / 2, x1 = t.x + t.sx / 2, y0 = t.y - t.sy / 2, y1 = t.y + t.sy / 2, z = t.z + H + 0.01, w = 0.05;
        const c = [t.col[0] * g, t.col[1] * g, t.col[2] * g];
        glow.quad([x0, y0, z], [x1, y0, z], [x1, y0 + w, z], [x0, y0 + w, z], c, 2);
        glow.quad([x0, y1 - w, z], [x1, y1 - w, z], [x1, y1, z], [x0, y1, z], c, 2);
        glow.quad([x0, y0, z], [x0 + w, y0, z], [x0 + w, y1, z], [x0, y1, z], c, 2);
        glow.quad([x1 - w, y0, z], [x1, y0, z], [x1, y1, z], [x1 - w, y1, z], c, 2);
    }
    for (const d of debris) spunBox(solid, d, d.col);
    // perfect rings: a glowing outline that expands outward and fades
    for (const r of rings) {
        const k = 1 - r.t / 0.9, e = r.t * 2.2, w = 0.12 * k + 0.02;
        const x0 = r.x - r.sx / 2 - e, x1 = r.x + r.sx / 2 + e, y0 = r.y - r.sy / 2 - e, y1 = r.y + r.sy / 2 + e, z = r.z;
        const c = [(r.col[0] * 0.6 + 0.6) * k, (r.col[1] * 0.6 + 0.6) * k, (r.col[2] * 0.6 + 0.6) * k];
        glow.quad([x0, y0, z], [x1, y0, z], [x1, y0 + w, z], [x0, y0 + w, z], c, 2);
        glow.quad([x0, y1 - w, z], [x1, y1 - w, z], [x1, y1, z], [x0, y1, z], c, 2);
        glow.quad([x0, y0 + w, z], [x0 + w, y0 + w, z], [x0 + w, y1 - w, z], [x0, y1 - w, z], c, 2);
        glow.quad([x1 - w, y0 + w, z], [x1, y0 + w, z], [x1, y1 - w, z], [x1 - w, y1 - w, z], c, 2);
    }
    for (const s of sparks) { const k = Math.min(1, s.life) * 0.9; glow.sprite(s.x, s.y, s.z, 0.08, (s.col[0] + 0.5) * k, (s.col[1] + 0.5) * k, (s.col[2] + 0.5) * k); }
    const n = solid.n;
    solid.append(glow);
    space.setDynamic(solid.pos, solid.col, solid.n);
    return { sN: n, gN: glow.n };
}

function render() {
    const aspect = canvas.width / canvas.height;
    space.magnifier = aspect < 0.7 ? 1.05 : aspect < 1.2 ? 1.4 : 1.75;
    const height = camTop - tower[0].z;
    const dist = lerp(1, Math.max(1, height / 9), zoomOut);
    const sway = Math.sin(time * 0.2) * 0.12 + (state === "title" ? time * 0.08 : 0);
    const ang = -Math.PI / 4 + sway;
    const tz = lerp(camTop - 1.2, (camTop + tower[0].z) / 2, zoomOut);
    const D = 15.5 * dist;
    space.lookAt(Math.cos(ang) * D, Math.sin(ang) * D, tz + 6.5 * dist, 0, 0, tz + 1.2 + Math.min(3.5, skyF / 35) * (1 - zoomOut));
    const { sN, gN } = buildDynamic();
    const S = skyAt(skyF);

    gl.uniform1f(U.aspect, aspect);
    gl.uniform3f(U.veriables, space.zShifter, space.magnifier, 0);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, time);
    gl.uniform3fv(U.uTop, S.top); gl.uniform3fv(U.uHor, S.hor);
    gl.uniform3fv(U.uSunDir, S.sun); gl.uniform3fv(U.uSunCol, S.sunCol); gl.uniform3fv(U.uCloud, S.cloud);
    gl.uniform1f(U.uNight, S.night); gl.uniform1f(U.uAurora, S.aurora); gl.uniform1f(U.uFog, S.fog);
    space.applyCamera();

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    space.bind(false); space.draw(0, solidCount);
    space.bind(true); space.draw(0, sN);
    gl.enable(gl.BLEND); gl.depthMask(false);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    space.bind(false); space.draw(solidCount, cloudCount);
    gl.blendFunc(gl.ONE, gl.ONE);
    space.bind(true); space.draw(sN, gN);
    gl.depthMask(true); gl.disable(gl.BLEND);
    audio.altitude(Math.min(1, skyF / 130));
}

// ------------------------------------------------------------------ UI

const $ = (id) => document.getElementById(id);
const ui = {
    show(which) { for (const id of ["title", "hud", "over"]) $(id).classList.toggle("hidden", id !== which); },
    score() {
        const n = Math.max(0, tower.length - 1);
        if (n !== shownFloor) { $("score").classList.remove("bump"); void $("score").offsetWidth; $("score").classList.add("bump"); }
        shownFloor = n;
        $("score").textContent = n;
        $("best").textContent = Math.max(save.best, state === "play" ? n : 0);
    },
    perfect(c) {
        const el = $("combo");
        if (c <= 0) { el.className = ""; return; }
        el.textContent = c === 1 ? "PERFECT" : `PERFECT ×${c}`;
        el.className = ""; void el.offsetWidth; el.className = "show" + (c >= 4 ? " hot" : "");
    },
    banner(t) { const el = $("banner"); el.textContent = t; el.className = ""; void el.offsetWidth; el.className = "show"; },
    over(floors, best) {
        this.show("over");
        $("o-floors").textContent = floors;
        $("o-info").textContent = `${perfects} perfect drops · best streak ${bestCombo}`;
        $("o-best").textContent = best ? "NEW HIGHEST TOWER" : `Highest tower: ${save.best}`;
        $("o-best").classList.toggle("new", best);
        const zone = Object.entries(MILESTONES).filter(([k]) => floors >= +k).pop();
        $("o-zone").textContent = zone ? `You reached ${zone[1].toLowerCase()}` : "Still in the city lights";
    },
    toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(this._t); this._t = setTimeout(() => el.classList.remove("show"), 1300); },
};
$("t-best").textContent = save.best;

// ------------------------------------------------------------------ loop

reset();
ui.show("title");
if (params.has("autoplay")) {
    start();
    window.__stratos = () => ({ state, floors: tower.length - 1, combo, bestCombo, size: cur ? [cur.sx.toFixed(2), cur.sy.toFixed(2)] : null });
    setInterval(() => { if (state === "over" && overT > 1.2) start(); }, 300);
}
let last = performance.now();
function frame(now) {
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    for (let s = 0; s < SPEED; s++) update(dt);
    render();
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
