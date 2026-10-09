// SKYPUTT — mini golf across floating islands above a sea of clouds, rendered with the projection3d library (Space).
//
// Drag back from anywhere and release to putt (or use ←/→ to aim, ↑/↓ for power, Space to putt). Nine holes per
// course, each one generated: winding fairways with bumpers, sand traps, spinning logs, sliding stones, slopes
// and boost pads. Sink it under par for birdies and eagles; every finished course is a fresh one.
//
// Rendering: the sky, the sea of clouds, distant islands and the current hole's island (turf, rails, rock
// underside, trees) live in Space's buffers, rebuilt per hole. The ball, the flag, moving hazards, the aim guide
// and effects are rebuilt every frame into GameSpace's dynamic buffers.

import GameSpace from "./GameSpace.js";
import { createProgram } from "./shaders.js";
import { Audio } from "./audio.js";
import { generateHole, step, moverPos, mulberry32, CELL, BALL_R, CUP_R, MAX_SPEED } from "./course.js";

const params = new URLSearchParams(location.search);
const SPEED = Math.max(1, Math.min(8, +params.get("speed") || 1));
const HOLES = 9;
const TURF = [0.36, 0.66, 0.26], LAND = [0.3, 0.55, 0.22], WOOD = [0.62, 0.4, 0.22], STONE = [0.86, 0.84, 0.8], ROCK = [0.5, 0.42, 0.36];

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
    tri(a, b, c, col, mat = 0, w = 1) { this.v(...a, w, ...col, mat); this.v(...b, w, ...col, mat); this.v(...c, w, ...col, mat); }
    quad(a, b, c, d, col, mat = 0, w = 1) { this.tri(a, b, c, col, mat, w); this.tri(a, c, d, col, mat, w); }
    sprite(x, y, z, size, r, g, b, mat = 5) { for (const k of [0, 1, 2, 0, 2, 3]) this.v(x, y, z, size + k * 100, r, g, b, mat); }
    append(o) {
        while ((this.n + o.n) * 4 > this.pos.length) this.grow();
        this.pos.set(o.pos.subarray(0, o.n * 4), this.n * 4); this.col.set(o.col.subarray(0, o.n * 4), this.n * 4);
        this.n += o.n;
    }
}
function tube(m, cx, cy, n, r0, z0, r1, z1, col, mat = 0, rot = 0) {
    for (let i = 0; i < n; i++) {
        const a0 = rot + (i / n) * 6.2832, a1 = rot + ((i + 1) / n) * 6.2832;
        const p = (r, a, z) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r, z];
        if (r1 === 0) m.tri(p(r0, a0, z0), p(r0, a1, z0), [cx, cy, z1], col, mat);
        else { m.quad(p(r0, a0, z0), p(r0, a1, z0), p(r1, a1, z1), p(r1, a0, z1), col, mat); m.tri([cx, cy, z1], p(r1, a0, z1), p(r1, a1, z1), col, mat); }
    }
}
function bar(m, ax, ay, bx, by, t, z0, z1, col, mat = 0) {
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1, nx = -dy / L * t / 2, ny = dx / L * t / 2;
    const P = [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]];
    for (let i = 0; i < 4; i++) { const a = P[i], b = P[(i + 1) % 4]; m.quad([...a, z0], [...b, z0], [...b, z1], [...a, z1], col, mat); }
    m.quad([...P[0], z1], [...P[1], z1], [...P[2], z1], [...P[3], z1], col, mat);
}
function disc(m, x, y, z, r, col, mat, n = 20, w = 1) { for (let i = 0; i < n; i++) { const a0 = (i / n) * 6.2832, a1 = ((i + 1) / n) * 6.2832; m.tri([x, y, z], [x + Math.cos(a0) * r, y + Math.sin(a0) * r, z], [x + Math.cos(a1) * r, y + Math.sin(a1) * r, z], col, mat, w); } }
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

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

// ------------------------------------------------------------------ static scene (per hole)

const stat = new Mesh(200000);
let H = null;                  // the current hole
const key = (i, j) => i + "," + j;
function buildStatic() {
    const m = stat, rng = mulberry32(H.seed * 7 + 3), C = CELL;
    m.reset();
    m.quad([-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], [0, 0, 0], 3);
    // the sea of clouds
    const [hx, hy] = H.cells.reduce((a, c) => [a[0] + c[0] * C / H.cells.length, a[1] + c[1] * C / H.cells.length], [0, 0]);
    for (let i = -6; i < 6; i++) for (let j = -6; j < 6; j++) {
        const x0 = hx + i * 80, y0 = hy + j * 80;
        m.quad([x0, y0, -38], [x0 + 80, y0, -38], [x0 + 80, y0 + 80, -38], [x0, y0 + 80, -38], [1, 1, 1], 7);
    }
    // distant floating islands
    for (let k = 0; k < 9; k++) {
        const a = rng() * 6.28, r = 55 + rng() * 90, x = hx + Math.cos(a) * r, y = hy + Math.abs(Math.sin(a)) * r + 20, s = 3 + rng() * 7, z = -6 + rng() * 14;
        islandBlob(m, x, y, z, s, rng);
    }
    // the hole's island: fairway tiles plus a ring of land around them
    const land = new Set();
    for (const [i, j] of H.cells) for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if (!H.set.has(key(i + di, j + dj))) land.add(key(i + di, j + dj));
    const isle = (i, j) => H.set.has(key(i, j)) || land.has(key(i, j));
    // turf, subdivided so the rails can darken it nearby
    const wallDist = (x, y) => {
        let d = 9;
        for (const w of H.walls) {
            const dx = w.bx - w.ax, dy = w.by - w.ay, L2 = dx * dx + dy * dy;
            const t = Math.max(0, Math.min(1, ((x - w.ax) * dx + (y - w.ay) * dy) / L2));
            d = Math.min(d, Math.hypot(x - w.ax - dx * t, y - w.ay - dy * t));
        }
        return Math.min(1, 0.25 + d / 0.7);
    };
    const N = 6;
    for (const [i, j] of H.cells) {
        for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
            const x0 = i * C - C / 2 + (a / N) * C, y0 = j * C - C / 2 + (b / N) * C, s = C / N;
            const P = [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];
            const W = P.map(([x, y]) => wallDist(x, y));
            m.v(...P[0], 0, W[0], ...TURF, 1); m.v(...P[1], 0, W[1], ...TURF, 1); m.v(...P[2], 0, W[2], ...TURF, 1);
            m.v(...P[0], 0, W[0], ...TURF, 1); m.v(...P[2], 0, W[2], ...TURF, 1); m.v(...P[3], 0, W[3], ...TURF, 1);
        }
    }
    // tee pad
    m.quad([H.tee[0] - 0.5, H.tee[1] - 0.5, 0.004], [H.tee[0] + 0.5, H.tee[1] - 0.5, 0.004], [H.tee[0] + 0.5, H.tee[1] + 0.5, 0.004], [H.tee[0] - 0.5, H.tee[1] + 0.5, 0.004], shade(TURF, 1.25), 1);
    for (const s of [-1, 1]) tube(m, H.tee[0] + s * 0.42, H.tee[1] + 0.42, 8, 0.06, 0, 0.06, 0.12, [0.95, 0.95, 0.95]);
    // sand traps (raised a hair, with a soft lip)
    for (const s of H.sand) {
        const n = 28, c = Math.cos(s.a), si = Math.sin(s.a);
        const P = (k, sc) => { const t = (k / n) * 6.2832, u = Math.cos(t) * s.rx * sc, v = Math.sin(t) * s.ry * sc; return [s.x + u * c - v * si, s.y + u * si + v * c]; };
        for (let k = 0; k < n; k++) {
            m.tri([s.x, s.y, 0.006], [...P(k, 1), 0.006], [...P(k + 1, 1), 0.006], [1, 1, 1], 4);
            m.quad([...P(k, 1), 0.006], [...P(k + 1, 1), 0.006], [...P(k + 1, 1.1), 0.003], [...P(k, 1.1), 0.003], shade(TURF, 0.8), 1);
        }
    }
    // slope tiles: painted chevrons showing the push
    for (const sl of H.slopes) {
        const L = Math.hypot(sl.fx, sl.fy), ux = sl.fx / L, uy = sl.fy / L, cx = sl.i * C, cy = sl.j * C;
        for (let r = -1; r <= 1; r++) for (let q = -1; q <= 1; q++) {
            const x = cx + (-uy * q + ux * r) * 0.85, y = cy + (ux * q + uy * r) * 0.85;
            const P = (u, v) => [x + ux * u - uy * v, y + uy * u + ux * v, 0.004];
            m.quad(P(0.05, 0), P(-0.15, 0.25), P(-0.25, 0.25), P(-0.05, 0), shade(TURF, 1.25), 1);
            m.quad(P(0.05, 0), P(-0.05, 0), P(-0.25, -0.25), P(-0.15, -0.25), shade(TURF, 1.25), 1);
        }
    }
    // rails and stone posts
    const posts = new Set();
    for (const w of H.walls) {
        bar(m, w.ax, w.ay, w.bx, w.by, 0.14, 0, 0.3, WOOD);
        bar(m, w.ax, w.ay, w.bx, w.by, 0.16, 0.3, 0.34, shade(WOOD, 1.25));
        for (const [x, y] of [[w.ax, w.ay], [w.bx, w.by]]) posts.add(x.toFixed(2) + "," + y.toFixed(2));
    }
    for (const p of posts) { const [x, y] = p.split(",").map(Number); tube(m, x, y, 8, 0.13, 0, 0.11, 0.42, STONE); tube(m, x, y, 8, 0.12, 0.42, 0, 0.5, STONE); }
    // land around the fairway: lower, wilder grass with trees, bushes, rocks and flowers
    const height = (i, j, x, y) => -0.1 - 0.12 * (Math.sin(x * 1.3 + y * 0.7) * 0.5 + 0.5);
    for (const k of land) {
        const [i, j] = k.split(",").map(Number);
        const N2 = 3, s = C / N2;
        for (let a = 0; a < N2; a++) for (let b = 0; b < N2; b++) {
            const x0 = i * C - C / 2 + a * s, y0 = j * C - C / 2 + b * s;
            const P = [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]].map(([x, y]) => [x, y, height(i, j, x, y)]);
            m.quad(P[0], P[1], P[2], P[3], shade(LAND, 0.9 + rng() * 0.2));
        }
        const r = rng();
        const x = i * C + (rng() - 0.5) * 1.8, y = j * C + (rng() - 0.5) * 1.8, z = height(i, j, x, y);
        if (r < 0.35) tree(m, x, y, z, rng);
        else if (r < 0.55) bush(m, x, y, z, rng);
        else if (r < 0.65) rock(m, x, y, z, 0.25 + rng() * 0.35, rng);
        for (let f = 0; f < 5; f++) {
            const fx = i * C + (rng() - 0.5) * 2.6, fy = j * C + (rng() - 0.5) * 2.6, fz = height(i, j, fx, fy);
            const fc = [[1, 0.9, 0.95], [1, 0.75, 0.3], [0.95, 0.45, 0.6], [0.7, 0.6, 1]][Math.floor(rng() * 4)];
            tube(m, fx, fy, 5, 0.06, fz + 0.12, 0.0, fz + 0.16, fc);
            m.tri([fx, fy, fz], [fx + 0.02, fy, fz], [fx, fy, fz + 0.13], [0.2, 0.45, 0.15]);
        }
    }
    // the underside: earth edges and hanging rock
    for (const k of [...H.set, ...land]) {
        const [i, j] = k.split(",").map(Number);
        const x0 = i * C - C / 2, x1 = i * C + C / 2, y0 = j * C - C / 2, y1 = j * C + C / 2;
        const top = H.set.has(k) ? 0 : -0.1, mid = -1.0 - rng() * 0.4;
        const edge = (ax, ay, bx, by) => {
            m.quad([ax, ay, mid], [bx, by, mid], [bx, by, top], [ax, ay, top], [0.45, 0.32, 0.2]);
        };
        if (!isle(i, j - 1)) edge(x0, y0, x1, y0);
        if (!isle(i + 1, j)) edge(x1, y0, x1, y1);
        if (!isle(i, j + 1)) edge(x1, y1, x0, y1);
        if (!isle(i - 1, j)) edge(x0, y1, x0, y0);
        const tip = [i * C + (rng() - 0.5), j * C + (rng() - 0.5), -3.5 - rng() * 5];
        const c = shade(ROCK, 0.8 + rng() * 0.3);
        m.tri([x0, y0, mid], [x1, y0, mid], tip, c); m.tri([x1, y0, mid], [x1, y1, mid], tip, c);
        m.tri([x1, y1, mid], [x0, y1, mid], tip, c); m.tri([x0, y1, mid], [x0, y0, mid], tip, c);
    }
    // the cup: a dark hole with a white rim
    disc(m, H.cup[0], H.cup[1], 0.003, CUP_R + 0.04, [0.95, 0.95, 0.95], 0, 22);
    disc(m, H.cup[0], H.cup[1], 0.005, CUP_R, [0.04, 0.05, 0.03], 0, 22);
    // windmill hubs (static base)
    for (const w of H.windmills) tube(m, w.x, w.y, 10, 0.32, 0, 0.26, 0.12, STONE);
    space.setStatic(m.pos, m.col, m.n);
    stat.count = m.n;
}
function tree(m, x, y, z, rng) {
    const h = 1.4 + rng() * 1.3, pine = rng() < 0.5;
    tube(m, x, y, 6, 0.09, z, 0.07, z + h * 0.4, [0.42, 0.28, 0.16]);
    if (pine) for (let k = 0; k < 3; k++) tube(m, x, y, 7, (0.6 - k * 0.14) * h / 1.8, z + h * (0.3 + k * 0.22), 0, z + h * (0.62 + k * 0.2), [0.12 + k * 0.03, 0.38 + k * 0.05, 0.2], 0, rng() * 3);
    else {
        const c = rng() < 0.3 ? [0.98, 0.7, 0.8] : [0.3, 0.6, 0.22];
        for (let k = 0; k < 3; k++) { const ox = (rng() - 0.5) * 0.5, oy = (rng() - 0.5) * 0.5, r = 0.4 + rng() * 0.3; tube(m, x + ox, y + oy, 7, r, z + h * 0.45, r * 0.8, z + h * 0.45 + r, c); tube(m, x + ox, y + oy, 7, r * 0.8, z + h * 0.45 + r, 0, z + h * 0.45 + r * 1.5, shade(c, 1.1)); }
    }
}
function bush(m, x, y, z, rng) { const r = 0.25 + rng() * 0.25, c = [0.22, 0.5 + rng() * 0.1, 0.2]; tube(m, x, y, 7, r, z, r * 0.9, z + r * 0.8, c); tube(m, x, y, 7, r * 0.9, z + r * 0.8, 0, z + r * 1.4, shade(c, 1.1)); }
function rock(m, x, y, z, r, rng) { tube(m, x, y, 6, r, z - 0.05, r * 0.7, z + r * 0.6, shade(STONE, 0.75), 0, rng() * 3); }
function islandBlob(m, x, y, z, s, rng) {
    const n = 9, top = [], ringR = [];
    for (let k = 0; k < n; k++) ringR.push(s * (0.75 + rng() * 0.35));
    for (let k = 0; k < n; k++) { const a = (k / n) * 6.2832; top.push([x + Math.cos(a) * ringR[k], y + Math.sin(a) * ringR[k] * 0.8]); }
    for (let k = 0; k < n; k++) {
        const a = top[k], b = top[(k + 1) % n];
        m.tri([x, y, z + 0.2], [...a, z], [...b, z], LAND);
        m.quad([...a, z], [...b, z], [b[0] * 0.8 + x * 0.2, b[1] * 0.8 + y * 0.2, z - s * 0.5], [a[0] * 0.8 + x * 0.2, a[1] * 0.8 + y * 0.2, z - s * 0.5], [0.45, 0.33, 0.22]);
        m.tri([a[0] * 0.8 + x * 0.2, a[1] * 0.8 + y * 0.2, z - s * 0.5], [b[0] * 0.8 + x * 0.2, b[1] * 0.8 + y * 0.2, z - s * 0.5], [x, y, z - s * 1.8], ROCK);
    }
    for (let k = 0; k < 3; k++) tree(m, x + (rng() - 0.5) * s, y + (rng() - 0.5) * s * 0.6, z, rng);
    if (rng() < 0.6) {                                                   // a waterfall spilling off the edge
        const a = top[Math.floor(rng() * n)];
        m.quad([a[0] - 0.4, a[1] - 0.6, z - s * 2.5], [a[0] + 0.4, a[1] - 0.6, z - s * 2.5], [a[0] + 0.4, a[1] - 0.6, z], [a[0] - 0.4, a[1] - 0.6, z], [1.1, 1.2, 1.3], 2);
    }
}

// ------------------------------------------------------------------ game state

const save = (() => { try { return Object.assign({ best: null, courses: 0 }, JSON.parse(localStorage.getItem("skyputt.save")) || {}); } catch { return { best: null, courses: 0 }; } })();
const persist = () => { try { localStorage.setItem("skyputt.save", JSON.stringify(save)); } catch { } };

let state = "title";
let courseSeed = Math.floor(Math.random() * 1e6), holeNo = 1, card = [];
let ball = null, strokes = 0, time = 0, holeT = 0, flyT = 0;
let aim = { active: false, sx: 0, sy: 0, dx: 0, dy: 0, angle: Math.PI / 2, power: 0.4, keys: false };
let trail = [], confetti = [], puffs = [];
let cam = { x: 0, y: 0, d: 12 };

function loadHole(n) {
    holeNo = n;
    H = generateHole(courseSeed * 31 + n * 977, n);
    for (const w of H.windmills) w.t0 = time;
    buildStatic();
    ball = { x: H.tee[0], y: H.tee[1], vx: 0, vy: 0, sunk: false, sinkT: 0 };
    strokes = 0; trail = [];
    const d = [H.cup[0] - H.tee[0], H.cup[1] - H.tee[1]];
    aim.angle = Math.atan2(d[1], d[0]);
    flyT = 0;
    ui.hud();
}
function newCourse() { courseSeed = Math.floor(Math.random() * 1e6); card = []; }
function start() {
    if (state === "card" && holeT < 0.8) return;
    if (state === "title" || state === "card") { newCourse(); const h0 = Math.max(1, Math.min(HOLES, +params.get("hole") || 1)); for (let i = 1; i < h0; i++) card.push({ par: 3, strokes: 3 }); loadHole(h0); state = "fly"; ui.show("hud"); }
}
const moving = () => Math.hypot(ball.vx, ball.vy) > 0.04 || ball.onSlope && Math.hypot(ball.vx, ball.vy) > 0.01;
function shoot(dirx, diry, power) {
    if (state !== "aim" || power < 0.04) return;
    ball.vx = dirx * power * MAX_SPEED * 0.93; ball.vy = diry * power * MAX_SPEED * 0.93;
    strokes++; state = "roll"; holeT = 0;
    audio.putt(power);
    ui.hud();
}
function holeDone() {
    state = "sunk"; holeT = 0;
    const diff = strokes - H.par;
    card.push({ par: H.par, strokes });
    const name = strokes === 1 ? "HOLE IN ONE!" : diff <= -3 ? "ALBATROSS" : diff === -2 ? "EAGLE" : diff === -1 ? "BIRDIE" : diff === 0 ? "PAR" : diff === 1 ? "BOGEY" : diff === 2 ? "DOUBLE BOGEY" : `+${diff}`;
    const kind = strokes === 1 || diff <= -2 ? 2 : diff === -1 ? 1 : diff === 0 ? 0 : -1;
    audio.cup(kind);
    ui.banner(name, `${strokes} stroke${strokes > 1 ? "s" : ""} · par ${H.par}`, kind);
    const n = kind >= 1 ? 160 : 60;
    for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.28, s = 1 + Math.random() * (kind >= 1 ? 4 : 2);
        const c = [[1, 0.35, 0.4], [1, 0.85, 0.3], [0.4, 0.8, 1], [0.6, 1, 0.5], [1, 0.6, 1]][i % 5];
        confetti.push({ x: H.cup[0], y: H.cup[1], z: 0.2, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: 3 + Math.random() * (kind >= 1 ? 7 : 3), life: 2.5, col: c });
    }
    ui.hud();
}
function nextHole() {
    if (holeNo >= HOLES) {
        state = "card"; holeT = 0;
        const total = card.reduce((a, c) => a + c.strokes, 0), par = card.reduce((a, c) => a + c.par, 0);
        const rel = total - par, best = save.best === null || rel < save.best;
        if (best) save.best = rel;
        save.courses++; persist();
        ui.card(total, par, best);
        return;
    }
    loadHole(holeNo + 1); state = "fly";
}

// ------------------------------------------------------------------ input

const toGround = (sx, sy) => {
    const nx = (sx / innerWidth) * 2 - 1, ny = 1 - (sy / innerHeight) * 2, aspect = canvas.width / canvas.height, k = 1.6 / space.magnifier;
    const X = space.xUnitVec, Y = space.yUnitVec, Z = space.zUnitVec;
    const d = [0, 1, 2].map((i) => Z[i] - X[i] * nx * k + Y[i] * ny * k / aspect);
    if (d[2] > -0.02) d[2] = -0.02;
    const t = -space.Zc / d[2];
    return [space.Xc + d[0] * t, space.Yc + d[1] * t];
};
canvas.addEventListener("pointerdown", (e) => {
    audio.init();
    if (state === "title" || state === "card") { start(); return; }
    if (state === "fly") { flyT = 9; return; }
    if (state !== "aim") return;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = toGround(e.clientX, e.clientY);
    aim.active = true; aim.keys = false; aim.sx = x; aim.sy = y; aim.dx = 0; aim.dy = 0;
});
canvas.addEventListener("pointermove", (e) => {
    if (!aim.active) return;
    const [x, y] = toGround(e.clientX, e.clientY);
    aim.dx = aim.sx - x; aim.dy = aim.sy - y;
    const L = Math.hypot(aim.dx, aim.dy);
    if (L > 0.05) { aim.angle = Math.atan2(aim.dy, aim.dx); aim.power = Math.min(1, L / 4.5); }
});
const releaseAim = () => {
    if (!aim.active) return;
    aim.active = false;
    if (Math.hypot(aim.dx, aim.dy) > 0.25) shoot(Math.cos(aim.angle), Math.sin(aim.angle), aim.power);
};
canvas.addEventListener("pointerup", releaseAim);
canvas.addEventListener("pointercancel", () => (aim.active = false));
for (const id of ["title", "card"]) document.getElementById(id).addEventListener("pointerdown", (e) => { if (e.target.closest("button")) return; audio.init(); start(); });
document.getElementById("c-again").addEventListener("click", () => { audio.init(); start(); });
const held = {};
addEventListener("keydown", (e) => {
    audio.init();
    if (e.code === "KeyM") { ui.toast(audio.toggleMute() ? "Sound off" : "Sound on"); return; }
    if (state === "title" || state === "card") { if (e.code === "Space" || e.code === "Enter") start(); return; }
    if (state === "fly" && (e.code === "Space" || e.code === "Enter")) { flyT = 9; return; }
    held[e.code] = true;
    if (state === "aim" && (e.code === "Space" || e.code === "Enter") && !e.repeat) { e.preventDefault(); shoot(Math.cos(aim.angle), Math.sin(aim.angle), aim.power); }
});
addEventListener("keyup", (e) => { held[e.code] = false; });

// ------------------------------------------------------------------ update

function update(dt) {
    time += dt; holeT += dt;
    if (state === "title") {
        // attract: a robot plays the hole
        if (!H) { courseSeed = 42; loadHole(3); }
        if (!moving() && !ball.sunk && holeT > 1.5) { robotShot(); holeT = 0; }
        if (ball.sunk && holeT > 2.5) { loadHole(1 + (holeNo % 6)); holeT = 0; }
    }
    if (state === "fly") { flyT += dt; if (flyT > 2.6) { state = "aim"; holeT = 0; } }
    if (state === "aim") {
        if (held.ArrowLeft) { aim.angle += dt * 1.6; aim.keys = true; }
        if (held.ArrowRight) { aim.angle -= dt * 1.6; aim.keys = true; }
        if (held.ArrowUp) { aim.power = Math.min(1, aim.power + dt * 0.7); aim.keys = true; }
        if (held.ArrowDown) { aim.power = Math.max(0.05, aim.power - dt * 0.7); aim.keys = true; }
        if (params.has("autoplay") && holeT > 1.0) robotShot();
    }
    const events = [];
    if (!ball.sunk) step(H, ball, dt, time, events);
    else ball.sinkT += dt;
    for (const e of events) {
        if (e.type === "wall") audio.wall(e.v);
        else if (e.type === "bumper") { audio.bumper(); for (let i = 0; i < 8; i++) puffs.push(spark(e.x, e.y, [1, 0.5, 0.4])); }
        else if (e.type === "windmill" || e.type === "mover") audio.windmill();
        else if (e.type === "sand") { audio.sand(); for (let i = 0; i < 5; i++) puffs.push({ ...spark(e.x, e.y, [0.5, 0.42, 0.3]), vz: 1 }); }
        else if (e.type === "boost") { audio.boost(); for (let i = 0; i < 14; i++) puffs.push(spark(e.x, e.y, [0.4, 0.9, 1])); }
        else if (e.type === "lip") audio.lip();
        else if (e.type === "cup" && state !== "title") holeDone();
        else if (e.type === "cup") holeT = 0;
    }
    if (state === "roll" && !ball.sunk && !moving() && holeT > 0.2) {
        ball.vx = ball.vy = 0;
        if (strokes >= 10) { ui.toast("Picked up — max 10 strokes"); strokes = 10; card.push({ par: H.par, strokes }); state = "sunk"; holeT = 0; ui.hud(); }
        else { state = "aim"; holeT = 0; const d = [H.cup[0] - ball.x, H.cup[1] - ball.y]; if (!aim.keys) aim.angle = Math.atan2(d[1], d[0]); }
    }
    if (state === "sunk" && holeT > 2.6) nextHole();
    for (const b of H.bumpers) b.flash = Math.max(0, b.flash - dt * 4);
    for (const b of H.boosts) b.flash = Math.max(0, (b.flash || 0) - dt * 3);
    // trail
    if (Math.hypot(ball.vx, ball.vy) > 2) trail.push({ x: ball.x, y: ball.y, life: 0.5 });
    for (const t of trail) t.life -= dt;
    trail = trail.filter((t) => t.life > 0);
    for (const c of confetti) { c.vz -= 9 * dt; c.vx *= 0.99; c.vy *= 0.99; c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt; if (c.z < 0.02 && H.set.has(key(Math.round(c.x / CELL), Math.round(c.y / CELL)))) { c.z = 0.02; c.vz = 0; c.vx *= 0.8; c.vy *= 0.8; } c.life -= dt; }
    confetti = confetti.filter((c) => c.life > 0 && c.z > -40);
    for (const p of puffs) { p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vz -= 6 * dt; p.life -= dt; }
    puffs = puffs.filter((p) => p.life > 0);
}
const spark = (x, y, col) => { const a = Math.random() * 6.28, s = 1 + Math.random() * 2; return { x, y, z: 0.2, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: 1.5 + Math.random() * 2, life: 0.6, col }; };
function robotShot() {
    // aim at the farthest route tile it can see in a straight line, sometimes straight for the cup
    const C = CELL, ci = Math.round(ball.x / C), cj = Math.round(ball.y / C);
    let k = H.cells.findIndex(([i, j]) => i === ci && j === cj); if (k < 0) k = 0;
    const clear = (tx, ty) => { const n = 30; for (let s = 1; s <= n; s++) { const x = ball.x + (tx - ball.x) * s / n, y = ball.y + (ty - ball.y) * s / n; if (!H.set.has(key(Math.round(x / C), Math.round(y / C)))) return false; } return true; };
    let tgt = [H.cells[Math.min(k + 1, H.cells.length - 1)][0] * C, H.cells[Math.min(k + 1, H.cells.length - 1)][1] * C];
    if (clear(...H.cup)) tgt = H.cup;
    else for (let m = H.cells.length - 1; m > k; m--) { const t = [H.cells[m][0] * C, H.cells[m][1] * C]; if (clear(...t)) { tgt = t; break; } }
    const dx = tgt[0] - ball.x, dy = tgt[1] - ball.y, d = Math.hypot(dx, dy);
    const v = Math.min(MAX_SPEED, Math.sqrt(2 * 1.35 * d) + (tgt === H.cup ? 0.4 : 1.2) + (Math.random() - 0.5) * 0.6);
    aim.angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.06; aim.power = v / (MAX_SPEED * 0.93);
    if (state === "title") { ball.vx = Math.cos(aim.angle) * v; ball.vy = Math.sin(aim.angle) * v; audio.putt(0.4); }
    else shoot(Math.cos(aim.angle), Math.sin(aim.angle), aim.power);
}

// ------------------------------------------------------------------ per-frame geometry

const solid = new Mesh(30000), glow = new Mesh(10000);
function buildDynamic() {
    solid.reset(); glow.reset();
    // bumpers: red-and-white mushrooms that flash when hit
    for (const b of H.bumpers) {
        const f = b.flash;
        tube(solid, b.x, b.y, 12, b.r, 0, b.r, 0.25, [0.95, 0.95, 0.95]);
        tube(solid, b.x, b.y, 12, b.r * 1.08, 0.25, b.r * 0.9, 0.42, [0.9 + f, 0.2 + f * 0.6, 0.2 + f * 0.4]);
        tube(solid, b.x, b.y, 12, b.r * 0.9, 0.42, 0, 0.52, [0.95 + f, 0.3 + f * 0.6, 0.3 + f * 0.4]);
        if (f > 0) glow.sprite(b.x, b.y, 0.4, 0.8, f * 0.6, f * 0.25, f * 0.2);
    }
    // spinning logs
    for (const w of H.windmills) {
        const a = w.angle + w.omega * (time - w.t0), c = Math.cos(a) * w.len, s = Math.sin(a) * w.len;
        bar(solid, w.x - c, w.y - s, w.x + c, w.y + s, 0.2, 0.05, 0.28, [0.55, 0.33, 0.18]);
        bar(solid, w.x - c * 0.98, w.y - s * 0.98, w.x + c * 0.98, w.y + s * 0.98, 0.22, 0.28, 0.32, [0.95, 0.85, 0.3]);
        tube(solid, w.x, w.y, 10, 0.2, 0.12, 0.16, 0.5, [0.95, 0.85, 0.3]);
        tube(solid, w.x, w.y, 10, 0.16, 0.5, 0, 0.62, [0.9, 0.3, 0.25]);
    }
    // sliding stones
    for (const m of H.movers) {
        const [px, py] = moverPos(m, time), ux = -m.ay, uy = m.ax, L = m.half + m.r;
        bar(solid, px - ux * L, py - uy * L, px + ux * L, py + uy * L, m.r * 2, 0, 0.45, [0.6, 0.62, 0.7]);
        bar(solid, px - ux * L * 0.9, py - uy * L * 0.9, px + ux * L * 0.9, py + uy * L * 0.9, m.r * 1.6, 0.45, 0.5, [0.4, 0.7, 0.95]);
    }
    // boost pads: glowing chevrons that race forward
    for (const p of H.boosts) {
        const k = 0.5 + (p.flash || 0);
        for (let i = 0; i < 3; i++) {
            const o = ((time * 1.5 + i / 3) % 1) - 0.5, x = p.x + p.dx * o * 1.0, y = p.y + p.dy * o * 1.0, fade = 1 - Math.abs(o) * 1.6;
            const P = (u, v) => [x + p.dx * u - p.dy * v, y + p.dy * u + p.dx * v, 0.01];
            const col = [0.2 * k * fade, 0.8 * k * fade, 1.0 * k * fade];
            solid.quad(P(0.15, 0), P(-0.1, 0.35), P(-0.25, 0.35), P(0, 0), col, 2);
            solid.quad(P(0.15, 0), P(0, 0), P(-0.25, -0.35), P(-0.1, -0.35), col, 2);
        }
        disc(solid, p.x, p.y, 0.006, p.r, [0.1, 0.25, 0.35], 0, 18);
        glow.sprite(p.x, p.y, 0.1, 0.9, 0.05 * k, 0.2 * k, 0.3 * k);
    }
    // the flag: lifts out when the ball is close
    const near = Math.hypot(ball.x - H.cup[0], ball.y - H.cup[1]);
    const lift = ball.sunk ? 1.6 : near < 1.5 && state === "roll" ? 0.5 : 0;
    const fx = H.cup[0], fy = H.cup[1] + 0.0, fz = lift;
    tube(solid, fx, fy, 6, 0.035, fz, 0.035, fz + 2.2, [0.97, 0.97, 0.97]);
    const N = 6;
    for (let i = 0; i < N; i++) {
        const u0 = i / N, u1 = (i + 1) / N;
        const wave = (u) => Math.sin(time * 6 - u * 5) * 0.12 * u;
        const P = (u, v) => [fx + 0.05 + u * 0.9, fy + wave(u) + 0.02, fz + 2.15 - v * 0.55 + (u * 0.22) * v];
        const col = i % 2 ? [0.95, 0.2, 0.18] : [0.88, 0.15, 0.14];
        solid.quad(P(u0, 0), P(u1, 0), P(u1, 1 - u1 * 0.4), P(u0, 1 - u0 * 0.4), col);
    }
    // ball and its shadow
    if (!ball.sunk || ball.sinkT < 0.3) {
        const z = ball.sunk ? BALL_R - ball.sinkT * 2 : BALL_R;
        solid.sprite(ball.x, ball.y, z, BALL_R, 1, 1, 1, 6);
        if (!ball.sunk) for (const [r, d] of [[BALL_R * 1.3, 0.8], [BALL_R * 0.9, 0.62]]) disc(solid, ball.x + 0.08, ball.y + 0.1, 0.008 + (1 - d) * 0.002, r, TURF, 8, 12, d);
    }
    for (const t of trail) glow.sprite(t.x, t.y, BALL_R, 0.12 * t.life * 2, 0.3 * t.life, 0.3 * t.life, 0.25 * t.life);
    // aim guide: dots to the target with colour by power, and a ring
    if (state === "aim") {
        const p = aim.power, n = 4 + Math.round(p * 12), cx = Math.cos(aim.angle), cy = Math.sin(aim.angle);
        const col = p < 0.5 ? [0.4 + p, 1, 0.4] : [1, 1.6 - p * 1.2, 0.3];
        for (let i = 1; i <= n; i++) {
            const d = i * 0.32 + ((time * 1.2) % 1) * 0.32, k = 1 - i / (n + 2);
            glow.sprite(ball.x + cx * d, ball.y + cy * d, 0.06, 0.07, col[0] * k * 0.7, col[1] * k * 0.7, col[2] * k * 0.7);
        }
        const r = 0.38 + Math.sin(time * 4) * 0.03;
        for (let i = 0; i < 24; i++) { const a0 = (i / 24) * 6.2832, a1 = ((i + 1) / 24) * 6.2832; solid.quad([ball.x + Math.cos(a0) * r, ball.y + Math.sin(a0) * r, 0.012], [ball.x + Math.cos(a1) * r, ball.y + Math.sin(a1) * r, 0.012], [ball.x + Math.cos(a1) * (r + 0.05), ball.y + Math.sin(a1) * (r + 0.05), 0.012], [ball.x + Math.cos(a0) * (r + 0.05), ball.y + Math.sin(a0) * (r + 0.05), 0.012], shade(col, 0.8), 2); }
        // a putter behind the ball, drawn back by the power
        const back = 0.3 + p * 0.9, hx = ball.x - cx * back, hy = ball.y - cy * back;
        bar(solid, hx - cy * 0.18, hy + cx * 0.18, hx + cy * 0.18, hy - cx * 0.18, 0.12, 0.02, 0.16, [0.75, 0.76, 0.8]);
        tube(solid, hx, hy, 6, 0.03, 0.16, 0.03, 1.4, [0.3, 0.3, 0.32]);
    }
    for (const c of confetti) { const k = Math.min(1, c.life); glow.sprite(c.x, c.y, c.z, 0.07, c.col[0] * k, c.col[1] * k, c.col[2] * k); }
    for (const p of puffs) { const k = p.life * 1.2; glow.sprite(p.x, p.y, p.z, 0.08, p.col[0] * k, p.col[1] * k, p.col[2] * k); }
    const n = solid.n;
    solid.append(glow);
    space.setDynamic(solid.pos, solid.col, solid.n);
    return { sN: n, gN: glow.n };
}

const SUN = [0.35, -0.5, 0.75];
function render(dt) {
    const aspect = canvas.width / canvas.height;
    space.magnifier = aspect < 0.7 ? 1.0 : aspect < 1.2 ? 1.35 : 1.7;
    // camera: a fly-over from the cup to the tee at the start of a hole, then it follows the ball
    let tx, ty, td;
    if (state === "fly") {
        const k = Math.min(1, flyT / 2.4), e = k * k * (3 - 2 * k);
        tx = H.cup[0] + (ball.x - H.cup[0]) * e; ty = H.cup[1] + (ball.y - H.cup[1]) * e; td = 18 - 6 * e;
    } else if (state === "title") { tx = ball.x + Math.sin(time * 0.2) * 2; ty = ball.y + 1.5; td = 14; }
    else {
        const toCup = Math.hypot(H.cup[0] - ball.x, H.cup[1] - ball.y);
        const lead = state === "aim" ? Math.min(0.35, 3 / (toCup + 1)) : 0;
        tx = ball.x + (H.cup[0] - ball.x) * lead * 0.6 + (state === "aim" ? Math.cos(aim.angle) * aim.power * 1.5 : 0);
        ty = ball.y + 1.2 + (H.cup[1] - ball.y) * lead * 0.6 + (state === "aim" ? Math.sin(aim.angle) * aim.power * 1.5 : 0);
        td = 11.5 + (state === "roll" ? Math.min(3, Math.hypot(ball.vx, ball.vy) * 0.25) : 0);
    }
    const f = Math.min(1, dt * (state === "fly" ? 8 : 2.5));
    cam.x += (tx - cam.x) * f; cam.y += (ty - cam.y) * f; cam.d += (td - cam.d) * f;
    space.lookAt(cam.x, cam.y - cam.d * 0.78, cam.d * 0.72, cam.x, cam.y, 0);
    const { sN, gN } = buildDynamic();

    gl.uniform1f(U.aspect, aspect);
    gl.uniform3f(U.veriables, space.zShifter, space.magnifier, 0);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, time);
    gl.uniform3fv(U.uSunDir, SUN); gl.uniform3f(U.uSunCol, 1.05, 0.95, 0.82);
    gl.uniform3f(U.uTop, 0.22, 0.5, 0.95); gl.uniform3f(U.uHor, 0.78, 0.87, 0.97);
    space.applyCamera();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    space.bind(false); space.draw(0, stat.count);
    space.bind(true); space.draw(0, sN);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
    space.draw(sN, gN);
    gl.depthMask(true); gl.disable(gl.BLEND);
}

// ------------------------------------------------------------------ UI

const $ = (id) => document.getElementById(id);
const fmtRel = (r) => (r === 0 ? "E" : r > 0 ? "+" + r : "" + r);
const ui = {
    show(which) { for (const id of ["title", "hud", "card"]) $(id).classList.toggle("hidden", id !== which); },
    hud() {
        if (!H) return;
        $("hole").textContent = holeNo;
        $("par").textContent = H.par;
        $("strokes").textContent = strokes;
        const tot = card.reduce((a, c) => a + c.strokes - c.par, 0);
        $("total").textContent = fmtRel(tot);
        $("pips").innerHTML = Array.from({ length: HOLES }, (_, i) => {
            const c = card[i]; let cls = i + 1 === holeNo && state !== "card" ? "cur" : "";
            if (c) cls = c.strokes < c.par ? "under" : c.strokes === c.par ? "par" : "over";
            return `<i class="${cls}">${c ? c.strokes : ""}</i>`;
        }).join("");
    },
    banner(t, sub, kind) {
        const el = $("banner");
        $("b-title").textContent = t; $("b-sub").textContent = sub;
        el.className = ""; void el.offsetWidth; el.className = "show k" + Math.max(0, kind);
    },
    card(total, par, best) {
        this.show("card");
        $("c-rows").innerHTML = `<tr><th>HOLE</th>${card.map((_, i) => `<td>${i + 1}</td>`).join("")}<td class="t">TOT</td></tr>`
            + `<tr><th>PAR</th>${card.map((c) => `<td>${c.par}</td>`).join("")}<td class="t">${par}</td></tr>`
            + `<tr><th>YOU</th>${card.map((c) => `<td class="${c.strokes < c.par ? "under" : c.strokes > c.par ? "over" : ""}">${c.strokes}</td>`).join("")}<td class="t">${total}</td></tr>`;
        $("c-rel").textContent = fmtRel(total - par);
        $("c-best").textContent = best ? "NEW COURSE RECORD" : `Best round: ${fmtRel(save.best)}`;
        $("c-best").classList.toggle("new", best);
    },
    toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(this._t); this._t = setTimeout(() => el.classList.remove("show"), 1500); },
};
$("t-best").textContent = save.best === null ? "—" : fmtRel(save.best);

// ------------------------------------------------------------------ loop

courseSeed = 42; loadHole(3); holeT = 0;
ui.show("title");
if (params.has("autoplay")) {
    start();
    window.__skyputt = () => ({ state, hole: holeNo, strokes, par: H.par, card: card.map((c) => c.strokes).join(","), ball: [ball.x.toFixed(2), ball.y.toFixed(2)] });
    setInterval(() => { if (state === "card" && holeT > 1) start(); }, 500);
}
let last = performance.now();
function frame(now) {
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    for (let s = 0; s < SPEED; s++) update(dt);
    render(dt * SPEED);
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
