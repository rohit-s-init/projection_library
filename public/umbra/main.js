// UMBRA — a shadow puzzle, rendered with the projection3d library (Space).
//
// A floating sculpture of blocks hangs in a spotlight. From most angles its shadow is meaningless — turn it
// (drag) until the shadow on the wall becomes a picture. Each sculpture is built from a pixel silhouette:
// every filled pixel gets a block at some depth along the light, plus extra blocks hidden behind others in
// that exact direction, so only one orientation casts the shape. The match meter shows how close you are;
// near the answer the sculpture clicks into place. Solve fast and without hints for three stars.
//
// Rendering: backdrop, wall and floor live in Space's buffers; the sculpture, its shadow (projected onto the
// wall along the light every frame), the revealed picture, dust in the beam and sparkles are rebuilt into
// GameSpace's dynamic buffers each frame.

import GameSpace from "./GameSpace.js";
import { createProgram } from "./shaders.js";
import { Audio } from "./audio.js";
import { GLYPHS, SIZE } from "./glyphs.js";

// ------------------------------------------------------------------ tuning

const S = 0.34;                 // block size = one pixel of the silhouette
const WALL_Y = 6, FLOOR_Z = -2.3, H = 1.7;
const GRID = 56, RANGE = 3.9;   // silhouette comparison raster over [-RANGE, RANGE]²
// The light comes in at an angle (travelling along LIGHT = (-0.5, 1, 0)), so the shadow falls to the left of the
// sculpture where the camera can see all of it. Each sculpture is pre-turned by R0 so that its hidden shape faces
// along the light; the shadow is then that shape, a little wider (1 / cos θ).
const LX = -0.5, THETA = Math.atan(0.5), WIDEN = 1 / Math.cos(THETA);
const R0 = [Math.cos(THETA), -Math.sin(THETA), 0, Math.sin(THETA), Math.cos(THETA), 0, 0, 0, 1];
const SHADOW_X = LX * WALL_Y;   // where the sculpture's centre lands on the wall (x)
const PALETTES = [
    { a: [0.95, 0.62, 0.35], b: [0.85, 0.3, 0.3], warm: [1.0, 0.9, 0.76], glow: [1.0, 0.7, 0.35] },
    { a: [0.45, 0.75, 0.95], b: [0.35, 0.4, 0.9], warm: [0.92, 0.95, 1.0], glow: [0.5, 0.8, 1.0] },
    { a: [0.6, 0.9, 0.6], b: [0.2, 0.6, 0.5], warm: [1.0, 0.95, 0.85], glow: [0.5, 1.0, 0.7] },
    { a: [0.95, 0.75, 0.95], b: [0.6, 0.35, 0.85], warm: [1.0, 0.9, 0.95], glow: [0.95, 0.6, 1.0] },
    { a: [0.98, 0.9, 0.55], b: [0.95, 0.55, 0.2], warm: [1.0, 0.88, 0.7], glow: [1.0, 0.85, 0.4] },
];

// ------------------------------------------------------------------ small maths

const qmul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qaxis = (x, y, z, ang) => { const s = Math.sin(ang / 2); return [x * s, y * s, z * s, Math.cos(ang / 2)]; };
const qnorm = (q) => { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); };
const qangle = (q) => 2 * Math.acos(Math.min(1, Math.abs(q[3])));
function qslerpIdentity(q, t) {                 // rotate q towards the identity by fraction t
    const s = q[3] < 0 ? -1 : 1, target = [0, 0, 0, s];
    return qnorm(q.map((v, i) => v + (target[i] - v) * t));
}
function qmat(q) {
    const [x, y, z, w] = q;
    return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
        2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
        2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}
const mm = (A, B) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]));
const orient = (q) => mm(qmat(q), R0);            // the sculpture's full rotation: the player's turn on top of R0
const mv = (M, p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2], M[3] * p[0] + M[4] * p[1] + M[5] * p[2], M[6] * p[0] + M[7] * p[1] + M[8] * p[2]];
function mulberry32(seed) {
    return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ------------------------------------------------------------------ sculptures

// Each filled pixel (col c, row r) becomes a block at x = column, z = row, and some depth y along the light.
// Extra blocks are stacked along y behind existing pixels, so they never change the answer's shadow.
function buildSculpture(glyph, level, rng) {
    const blocks = new Map();
    const add = (c, r, k) => { const key = `${c},${r},${k}`; if (!blocks.has(key)) blocks.set(key, [c, r, k]); };
    const ph = [rng() * 6.28, rng() * 6.28, rng() * 6.28];
    const depthAmp = 3 + Math.min(4, level * 0.35);
    const extra = Math.min(0.75, 0.25 + level * 0.05);
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
        if (!glyph.grid[r][c]) continue;
        const f = Math.sin(c * 0.62 + ph[0]) * 0.6 + Math.cos(r * 0.5 + ph[1]) * 0.6 + Math.sin((c + r) * 0.9 + ph[2]) * 0.35;
        const k = Math.round(f * depthAmp);
        add(c, r, k);
        if (rng() < extra) {                          // a column of hidden blocks behind this pixel
            const len = 1 + Math.floor(rng() * (2 + level * 0.3)), dir = rng() < 0.5 ? -1 : 1;
            for (let j = 1; j <= len; j++) add(c, r, k + dir * j);
        }
    }
    // centre it, in block units
    const list = [...blocks.values()];
    const mean = [0, 1, 2].map((i) => list.reduce((s, b) => s + b[i], 0) / list.length);
    const out = list.map(([c, r, k]) => ({
        p: [(c - mean[0]) * S, (k - mean[2]) * S, -(r - mean[1]) * S],
        t: (k - mean[2]) / (depthAmp + 2) * 0.5 + 0.5,           // colour blend by depth
    }));
    return { blocks: out, mean };                                 // mean (in pixels) lines the picture up with the shadow
}

// ------------------------------------------------------------------ silhouettes (for the match meter)

// raster the shadow (projection along +y onto x/z) of every block after rotation M
function rasterize(blocks, M, out) {
    out.fill(0);
    const h = S / 2, cell = (2 * RANGE) / GRID;
    const ax = mv(M, [h, 0, 0]), ay = mv(M, [0, h, 0]), az = mv(M, [0, 0, h]);
    const pts = [];
    for (const b of blocks) {
        const c = mv(M, b.p);
        pts.length = 0;
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
        {
            const px = c[0] + ax[0] * sx + ay[0] * sy + az[0] * sz, py = c[1] + ax[1] * sx + ay[1] * sy + az[1] * sz;
            pts.push([px - LX * py, c[2] + ax[2] * sx + ay[2] * sy + az[2] * sz]);
        }
        const hull = convexHull(pts);
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const [x, z] of hull) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
        const i0 = Math.max(0, Math.floor((x0 + RANGE) / cell)), i1 = Math.min(GRID - 1, Math.floor((x1 + RANGE) / cell));
        const j0 = Math.max(0, Math.floor((z0 + RANGE) / cell)), j1 = Math.min(GRID - 1, Math.floor((z1 + RANGE) / cell));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
            if (out[j * GRID + i]) continue;
            const px = -RANGE + (i + 0.5) * cell, pz = -RANGE + (j + 0.5) * cell;
            if (insideConvex(hull, px, pz)) out[j * GRID + i] = 1;
        }
    }
}
function convexHull(p) {
    p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    up.pop(); lo.pop();
    return lo.concat(up);
}
function insideConvex(h, x, z) {
    for (let i = 0; i < h.length; i++) {
        const a = h[i], b = h[(i + 1) % h.length];
        if ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false;
    }
    return true;
}
function iou(a, b) {
    let inter = 0, uni = 0;
    for (let i = 0; i < a.length; i++) { inter += a[i] & b[i]; uni += a[i] | b[i]; }
    return uni ? inter / uni : 0;
}

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
    const m = new Mesh(64);
    m.quad([-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], [0, 0, 0], 3);
    m.quad([-14, WALL_Y, FLOOR_Z], [14, WALL_Y, FLOOR_Z], [14, WALL_Y, 10], [-14, WALL_Y, 10], [0, 0, 0], 1);
    m.quad([-14, -16, FLOOR_Z], [14, -16, FLOOR_Z], [14, WALL_Y, FLOOR_Z], [-14, WALL_Y, FLOOR_Z], [0, 0, 0], 2);
    space.setStatic(m.pos, m.col, m.n);
}

// ------------------------------------------------------------------ state

const save = (() => { try { return Object.assign({ level: 1, found: {} }, JSON.parse(localStorage.getItem("umbra.save")) || {}); } catch { return { level: 1, found: {} }; } })();
const persist = () => { try { localStorage.setItem("umbra.save", JSON.stringify(save)); } catch { } };

let state = "title";            // title | play | solved
let level = save.level, glyph, blocks = [], pal, meanPx = [0, 0];
let q = [0, 0, 0, 1], spinZ = 0, spinX = 0, twoAxis = false;
const target = new Uint8Array(GRID * GRID), live = new Uint8Array(GRID * GRID);
let match = 0, shownMatch = 0, rasterTimer = 0, snapped = false;
let startTime = 0, hintUsed = false, solvedAt = 0, time = 0, lastTickAngle = 0;
let sparks = [];

function setupLevel(n, forTitle = false) {
    level = n;
    const rng = mulberry32(n * 7717 + 3);
    glyph = GLYPHS[(n - 1) % GLYPHS.length];
    pal = PALETTES[(n - 1) % PALETTES.length];
    ({ blocks, mean: meanPx } = buildSculpture(glyph, n, rng));
    rasterize(blocks, orient([0, 0, 0, 1]), target);
    twoAxis = n > 3;
    // start well away from the answer (and make sure the shadow really doesn't match yet)
    for (let tries = 0; tries < 30; tries++) {
        const yaw = (rng() < 0.5 ? -1 : 1) * (0.9 + rng() * 1.6);
        const pitch = twoAxis ? (rng() < 0.5 ? -1 : 1) * (0.6 + rng() * 1.0) : 0;
        q = qnorm(qmul(qaxis(1, 0, 0, pitch), qaxis(0, 0, 1, yaw)));
        rasterize(blocks, orient(q), live);
        if (iou(live, target) < 0.45) break;
    }
    spinZ = spinX = 0; snapped = false; hintUsed = false; match = shownMatch = 0;
    startTime = time; sparks = [];
    if (!forTitle) ui.hud();
}

function play() {
    audio.init();
    state = "play";
    setupLevel(save.level);
    ui.show("hud");
}

function solve() {
    state = "solved";
    solvedAt = time;
    audio.solve();
    const secs = time - startTime;
    const stars = Math.max(1, (secs < 30 ? 3 : secs < 75 ? 2 : 1) - (hintUsed ? 1 : 0));
    save.found[glyph.name] = Math.max(save.found[glyph.name] || 0, stars);
    save.level = Math.max(save.level, level + 1);
    persist();
    for (let i = 0; i < 120; i++) {
        const a = Math.random() * 6.28, r = Math.random() * 2.5;
        sparks.push({ x: SHADOW_X + Math.cos(a) * r, y: WALL_Y - 0.3 - Math.random() * 2, z: H + Math.sin(a) * r, vx: (Math.random() - 0.5) * 2, vy: -Math.random() * 2, vz: Math.random() * 2, life: 1.5 + Math.random() * 1.5, max: 3 });
    }
    setTimeout(() => ui.result(stars, secs), 1900);
}

// ------------------------------------------------------------------ input: drag to turn

let drag = null, mouse = [0, 0];
canvas.addEventListener("pointerdown", (e) => {
    audio.init();
    if (state === "title") { play(); return; }
    if (state !== "play") return;
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY };
    snapped = false;
});
canvas.addEventListener("pointermove", (e) => {
    mouse = [e.clientX / innerWidth - 0.5, e.clientY / innerHeight - 0.5];
    if (!drag || state !== "play") return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    turn(dx * 0.009, twoAxis ? dy * 0.009 : 0);
    spinZ = dx * 0.009 * 60; spinX = twoAxis ? dy * 0.009 * 60 : 0;
});
addEventListener("pointerup", () => { drag = null; });
const keys = new Set();
addEventListener("keydown", (e) => {
    audio.init();
    keys.add(e.code);
    if (e.code === "KeyM") { ui.toast(audio.toggleMute() ? "Sound off" : "Sound on"); return; }
    if ((e.code === "Space" || e.code === "Enter") && state === "title") play();
    else if (e.code === "KeyH" && state === "play") hint();
    else if ((e.code === "Space" || e.code === "Enter") && state === "solved" && !document.getElementById("result").classList.contains("hidden")) next();
});
addEventListener("keyup", (e) => keys.delete(e.code));

function turn(dz, dx) {
    q = qnorm(qmul(qaxis(1, 0, 0, dx), qmul(qaxis(0, 0, 1, dz), q)));
    const a = qangle(q);
    if (Math.abs(a - lastTickAngle) > 0.12) { lastTickAngle = a; audio.tick(match); }
}
function hint() {
    if (hintUsed) return;
    hintUsed = true;
    audio.hint();
    ui.toast("The shape's outline is on the wall");
    ui.hud();
}
function next() { state = "play"; setupLevel(level + 1); ui.show("hud"); }

// ------------------------------------------------------------------ update

function update(dt) {
    time += dt;
    if (state === "play") {
        const kz = (keys.has("ArrowRight") || keys.has("KeyD") ? 1 : 0) - (keys.has("ArrowLeft") || keys.has("KeyA") ? 1 : 0);
        const kx = twoAxis ? (keys.has("ArrowDown") || keys.has("KeyS") ? 1 : 0) - (keys.has("ArrowUp") || keys.has("KeyW") ? 1 : 0) : 0;
        if (kz || kx) { turn(kz * 1.6 * dt, kx * 1.6 * dt); snapped = false; }
        if (!drag) {                                               // a little inertia after letting go
            if (Math.abs(spinZ) + Math.abs(spinX) > 0.01) turn(spinZ * dt, spinX * dt);
            const d = Math.exp(-dt * 4); spinZ *= d; spinX *= d;
        }
        rasterTimer -= dt;
        if (rasterTimer <= 0) { rasterTimer = 0.06; rasterize(blocks, orient(q), live); match = iou(live, target); }
        // close to the answer: it gently clicks into place
        const ang = qangle(q);
        if (!drag && match > 0.72 && ang < 0.45) {
            if (!snapped) { snapped = true; audio.snap(); spinZ = spinX = 0; }
            q = qslerpIdentity(q, Math.min(1, dt * 5));
            if (qangle(q) < 0.02) { q = [0, 0, 0, 1]; match = 1; solve(); }
        } else if (!drag && match > 0.965) { match = 1; solve(); }       // (a symmetric shape can match at another angle)
        ui.meter();
    } else if (state === "title") {
        q = qnorm(qmul(qaxis(0, 0, 1, dt * 0.25), qmul(qaxis(1, 0, 0, Math.sin(time * 0.3) * dt * 0.1), q)));
    }
    shownMatch += (match - shownMatch) * Math.min(1, dt * 8);
    for (const s of sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt; s.vz -= 0.6 * dt; s.life -= dt; }
    sparks = sparks.filter((s) => s.life > 0);
}

// ------------------------------------------------------------------ rendering

const solid = new Mesh(40000), glow = new Mesh(20000);
const dust = Array.from({ length: 70 }, () => ({ x: (Math.random() - 0.5) * 9, y: -6 + Math.random() * 11, z: -1.5 + Math.random() * 7, s: Math.random() * 6.28 }));
const lerp3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function buildDynamic() {
    solid.reset(); glow.reset();
    const M = orient(q);
    const bob = Math.sin(time * 1.1) * 0.06;
    const cz = H + bob, h = S / 2 * 0.94;
    const ax = mv(M, [h, 0, 0]), ay = mv(M, [0, h, 0]), az = mv(M, [0, 0, h]);
    const hs = S / 2;
    const sax = mv(M, [hs, 0, 0]), say = mv(M, [0, hs, 0]), saz = mv(M, [0, 0, hs]);
    const shadowHulls = [];

    for (const b of blocks) {
        const c = mv(M, b.p);
        const C = [c[0], c[1], c[2] + cz];
        const col = lerp3(pal.a, pal.b, b.t);
        const P = (sx, sy, sz) => [C[0] + ax[0] * sx + ay[0] * sy + az[0] * sz, C[1] + ax[1] * sx + ay[1] * sy + az[1] * sz, C[2] + ax[2] * sx + ay[2] * sy + az[2] * sz];
        const f = [[P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1)], [P(-1, 1, -1), P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1)],
            [P(1, 1, -1), P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1)], [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)],
            [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)], [P(-1, 1, -1), P(1, 1, -1), P(1, -1, -1), P(-1, -1, -1)]];
        for (const [a, bb, cc, d] of f) solid.quad(a, bb, cc, d, col, 0);
        // this block's shadow outline on the wall (full-size block, projected along the light)
        const pts = [];
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
            const px = C[0] + sax[0] * sx + say[0] * sy + saz[0] * sz, py = C[1] + sax[1] * sx + say[1] * sy + saz[1] * sz;
            pts.push([px + LX * (WALL_Y - py), C[2] + sax[2] * sx + say[2] * sy + saz[2] * sz]);      // along the light onto the wall
        }
        shadowHulls.push(convexHull(pts));
    }
    // shadow: a soft, slightly larger layer behind a crisp one
    for (const [grow, dark, dy] of [[0.07, 0.62, 0.012], [0, 0.26, 0.024]]) {
        for (const hull of shadowHulls) {
            const mx = hull.reduce((s, p) => s + p[0], 0) / hull.length, mz = hull.reduce((s, p) => s + p[1], 0) / hull.length;
            const E = (p) => { const dx = p[0] - mx, dz = p[1] - mz, l = Math.hypot(dx, dz) || 1; return [p[0] + dx / l * grow, WALL_Y - dy, p[1] + dz / l * grow]; };
            for (let i = 1; i + 1 < hull.length; i++) solid.tri(E(hull[0]), E(hull[i]), E(hull[i + 1]), [0, 0, 0], 4, dark);
        }
    }

    // the answer's outline on the wall (after a hint), and the revealed picture when solved
    const cellXZ = (c, r) => [(c - meanPx[0]) * S * WIDEN + SHADOW_X, -(r - meanPx[1]) * S + H];
    const CW = S / 2 * WIDEN;                      // half a pixel's width on the wall
    if (hintUsed || state === "solved") {
        const a = state === "solved" ? 0 : 0.35 + 0.2 * Math.sin(time * 3);
        if (a > 0) for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
            if (!glyph.grid[r][c]) continue;
            const [x, z] = cellXZ(c, r), hs2 = S / 2, w = CW, t = 0.025, y = WALL_Y - 0.035, col = pal.glow.map((v) => v * a);
            if (!glyph.grid[r - 1]?.[c]) solid.quad([x - w, y, z + hs2 - t], [x + w, y, z + hs2 - t], [x + w, y, z + hs2 + t], [x - w, y, z + hs2 + t], col, 6);
            if (!glyph.grid[r + 1]?.[c]) solid.quad([x - w, y, z - hs2 - t], [x + w, y, z - hs2 - t], [x + w, y, z - hs2 + t], [x - w, y, z - hs2 + t], col, 6);
            if (!glyph.grid[r][c - 1]) solid.quad([x - w - t, y, z - hs2], [x - w + t, y, z - hs2], [x - w + t, y, z + hs2], [x - w - t, y, z + hs2], col, 6);
            if (!glyph.grid[r][c + 1]) solid.quad([x + w - t, y, z - hs2], [x + w + t, y, z - hs2], [x + w + t, y, z + hs2], [x + w - t, y, z + hs2], col, 6);
        }
    }
    if (state === "solved") {
        const t = Math.min(1, (time - solvedAt) / 1.2);
        for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
            if (!glyph.grid[r][c]) continue;
            const d = Math.hypot(c - meanPx[0], r - meanPx[1]) / 8;
            if (d > t * 1.2) continue;
            const [x, z] = cellXZ(c, r), g = S / 2 * 0.96, gw = CW * 0.96, y = WALL_Y - 0.04;
            const k = 1.2 + 0.25 * Math.sin(time * 3 + c * 0.7 + r * 0.5);
            const col = lerp3(pal.a, pal.glow, r / SIZE).map((v) => v * k);
            solid.quad([x - gw, y, z - g], [x + gw, y, z - g], [x + gw, y, z + g], [x - gw, y, z + g], col, 6);
        }
        glow.sprite(SHADOW_X, WALL_Y - 0.3, H, 3.8 * t, pal.glow[0] * 0.35, pal.glow[1] * 0.35, pal.glow[2] * 0.35);
    }

    // dust drifting in the beam
    for (const d of dust) {
        const x = d.x + Math.sin(time * 0.2 + d.s) * 0.4, z = d.z + Math.sin(time * 0.13 + d.s * 2) * 0.3, y = d.y + Math.cos(time * 0.1 + d.s) * 0.5;
        const bx = SHADOW_X * (y + 6) / (WALL_Y + 6) * 0.9;           // the beam slants towards the shadow
        const inBeam = Math.max(0, 1 - Math.hypot(x - bx, z - H) / 4.5);
        const k = inBeam * (0.5 + 0.5 * Math.sin(time * 1.5 + d.s * 3)) * 0.35;
        glow.sprite(x, y, z, 0.035, pal.warm[0] * k, pal.warm[1] * k, pal.warm[2] * k);
    }
    for (const s of sparks) { const f = s.life / s.max; glow.sprite(s.x, s.y, s.z, 0.06 * (0.5 + f), pal.glow[0] * f, pal.glow[1] * f, pal.glow[2] * f); }

    const n = solid.n;
    solid.append(glow);
    space.setDynamic(solid.pos, solid.col, solid.n);
    return { sN: n, gN: glow.n };
}
function render() {
    const aspect = canvas.width / canvas.height;
    space.magnifier = aspect < 1 ? 1.15 : 1.75;
    const sx = mouse[0] * 1.2, sz = -mouse[1] * 0.7;
    space.lookAt(-4.2 + sx, -11.2, 3.4 + sz, -1.2, 2.6, 1.8);
    const { sN, gN } = buildDynamic();
    gl.uniform1f(U.aspect, aspect);
    gl.uniform3f(U.veriables, space.zShifter, space.magnifier, 0);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, time);
    gl.uniform3f(U.uSpot, SHADOW_X, WALL_Y, H);
    gl.uniform3fv(U.uWarm, pal.warm);
    gl.uniform1f(U.uSolved, state === "solved" ? Math.min(1, (time - solvedAt) * 2) * (0.7 + 0.3 * Math.sin(time * 4)) : 0);
    space.applyCamera();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    space.bind(false); space.draw(0, 18);
    space.bind(true); space.draw(0, sN);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
    space.draw(sN, gN);
    gl.depthMask(true); gl.disable(gl.BLEND);
}

// ------------------------------------------------------------------ UI

const $ = (id) => document.getElementById(id);
const glyphSVG = (g, size, color) => {
    let s = `<svg viewBox="0 0 ${SIZE} ${SIZE}" width="${size}" height="${size}" shape-rendering="crispEdges">`;
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (g.grid[r][c]) s += `<rect x="${c}" y="${r}" width="1.02" height="1.02" fill="${color}"/>`;
    return s + "</svg>";
};
const css = (c) => `rgb(${c.map((v) => Math.round(Math.min(1, v) * 255)).join(",")})`;
const ui = {
    show(which) { for (const id of ["title", "hud", "result", "album"]) $(id).classList.toggle("hidden", id !== which); if (which === "hud") this.hud(); },
    hud() {
        $("lv").textContent = level;
        $("axes").textContent = twoAxis ? "drag in any direction" : "drag left / right";
        $("hintbtn").disabled = hintUsed;
        $("hintbtn").textContent = hintUsed ? "Hint used" : "Hint (H)";
    },
    meter() {
        const m = Math.max(0, Math.min(1, (shownMatch - 0.15) / 0.8));
        $("ring").style.strokeDashoffset = String(283 * (1 - m));
        $("ring").style.stroke = m > 0.8 ? "#ffd27a" : m > 0.5 ? "#f5e6c8" : "#9c8f86";
        $("pct").textContent = `${Math.round(m * 100)}%`;
        $("timer").textContent = `${Math.floor(time - startTime)}s`;
    },
    result(stars, secs) {
        this.show("result");
        $("r-shape").innerHTML = glyphSVG(glyph, 120, css(pal.glow));
        $("r-name").textContent = `It's ${glyph.name}!`;
        $("r-stars").innerHTML = [0, 1, 2].map((i) => `<i class="${i < stars ? "on" : ""}" style="animation-delay:${0.2 + i * 0.2}s">★</i>`).join("");
        $("r-info").textContent = `Found in ${Math.round(secs)} s${hintUsed ? " with a hint" : ""} · ${Object.keys(save.found).length} / ${GLYPHS.length} shapes discovered`;
    },
    album() {
        this.show("album");
        $("grid").innerHTML = GLYPHS.map((g) => {
            const st = save.found[g.name];
            return `<div class="cell ${st ? "" : "unknown"}">${st ? glyphSVG(g, 56, "#f3dcb4") : "<b>?</b>"}<span>${st ? g.name.replace(/^(a|an|the) /, "") : "???"}</span><small>${st ? "★".repeat(st) : ""}</small></div>`;
        }).join("");
    },
    toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(this._t); this._t = setTimeout(() => el.classList.remove("show"), 1500); },
};
$("hintbtn").addEventListener("click", (e) => { e.stopPropagation(); hint(); });
$("r-next").addEventListener("click", () => next());
$("r-album").addEventListener("click", () => ui.album());
$("t-album").addEventListener("click", (e) => { e.stopPropagation(); ui.album(); });
$("a-back").addEventListener("click", () => { if (state === "solved") next(); else { state = "title"; ui.show("title"); } });
$("title").addEventListener("click", () => play());
$("t-found").textContent = `${Object.keys(save.found).length} / ${GLYPHS.length}`;

// ------------------------------------------------------------------ loop

setupLevel(save.level, true);
ui.show("title");
if (new URLSearchParams(location.search).has("autoplay")) {          // demo / testing: solve by itself
    play();
    setInterval(() => { if (state === "play") q = qslerpIdentity(q, 0.08); else if (state === "solved" && !$("result").classList.contains("hidden")) next(); }, 50);
}
let last = performance.now();
function frame(now) {
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
