// RIPPLE — a moonlit pond puzzle, rendered with the projection3d library (Space).
//
// You never touch the little paper boat. Tap the water to drop a pebble: the ripple spreads, and as the ring
// passes the boat it pushes it away from where the pebble fell. Steer it around rocks and drifting lily pads,
// brush past the three lotus buds (they bloom) and sail through the lantern gate before your pebbles run out.
//
// Rendering: sky, garden, rocks, lanterns and the water plane live in Space's buffers (rebuilt per level). The
// water's look comes from a live wave simulation streamed into a texture every frame. Boat, lily pads, lotus,
// falling pebbles, splashes, fireflies and petals are rebuilt into GameSpace's dynamic buffers each frame.

import GameSpace from "./GameSpace.js";
import { createProgram } from "./shaders.js";
import { Audio } from "./audio.js";
import { Pond, generateLevel, GW, GH, CELL, X0, Y0, WAVE_SPEED, BOAT_R, cellOf, cellCenter, mulberry32 } from "./pond.js";

const SPEED = Math.max(1, Math.min(8, +new URLSearchParams(location.search).get("speed") || 1));   // test/demo fast-forward
const SIM_HZ = 48;              // simulation steps per second (makes the visible waves move at WAVE_SPEED)

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
    tri(a, b, c, col, mat = 0) { this.v(...a, 1, ...col, mat); this.v(...b, 1, ...col, mat); this.v(...c, 1, ...col, mat); }
    quad(a, b, c, d, col, mat = 0) { this.tri(a, b, c, col, mat); this.tri(a, c, d, col, mat); }
    sprite(x, y, z, size, r, g, b) { for (const k of [0, 1, 2, 0, 2, 3]) this.v(x, y, z, size + k * 100, r, g, b, 5); }
    append(o) {
        while ((this.n + o.n) * 4 > this.pos.length) this.grow();
        this.pos.set(o.pos.subarray(0, o.n * 4), this.n * 4); this.col.set(o.col.subarray(0, o.n * 4), this.n * 4);
        this.n += o.n;
    }
}
// a cone/prism ring helper: from radius r0 at z0 to r1 at z1, n sides
function tube(m, cx, cy, n, r0, z0, r1, z1, col, mat = 0, rot = 0) {
    for (let i = 0; i < n; i++) {
        const a0 = rot + (i / n) * 6.2832, a1 = rot + ((i + 1) / n) * 6.2832;
        const p = (r, a, z) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r, z];
        if (r1 === 0) m.tri(p(r0, a0, z0), p(r0, a1, z0), [cx, cy, z1], col, mat);
        else m.quad(p(r0, a0, z0), p(r0, a1, z0), p(r1, a1, z1), p(r1, a0, z1), col, mat);
    }
    if (r1 > 0) for (let i = 0; i < n; i++) {                 // cap
        const a0 = rot + (i / n) * 6.2832, a1 = rot + ((i + 1) / n) * 6.2832;
        m.tri([cx, cy, z1], [cx + Math.cos(a0) * r1, cy + Math.sin(a0) * r1, z1], [cx + Math.cos(a1) * r1, cy + Math.sin(a1) * r1, z1], col, mat);
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
const pond = new Pond();

const waterTex = gl.createTexture();
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, waterTex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, GW, GH, 0, gl.RGBA, gl.UNSIGNED_BYTE, pond.tex);
gl.uniform1i(U.uWater, 0);

// ------------------------------------------------------------------ state

const save = (() => { try { return Object.assign({ level: 1, best: {} }, JSON.parse(localStorage.getItem("ripple.save")) || {}); } catch { return { level: 1, best: {} }; } })();
const persist = () => { try { localStorage.setItem("ripple.save", JSON.stringify(save)); } catch { } };
const totalLotus = () => Object.values(save.best).reduce((a, b) => a + b, 0);

let state = "title";            // title | play | won | lost
let L = null, levelNo = save.level;
let boat = null, lilies = [], stonesLeft = 0, falling = [], pulses = [], splashes = [];
let lanterns = [], petals = [], fireflies = [];
let time = 0, simAcc = 0, idleTimer = 0, got = 0, pulseId = 0, demoTimer = 2;

function loadLevel(n) {
    levelNo = n;
    L = generateLevel(pond, n);
    pond.resetWater();
    buildStatic();
    resetBoats();
    ui.hud();
}
function resetBoats() {
    boat = { x: L.start.x, y: L.start.y, vx: 0, vy: 0, a: 0, hits: new Set(), r: BOAT_R };
    lilies = L.lilies.map((l) => ({ ...l, vx: 0, vy: 0, hits: new Set(), x: l.x, y: l.y }));
    L.lotus.forEach((l) => { l.got = false; l.open = 0; });
    stonesLeft = L.stones; falling = []; pulses = []; got = 0; idleTimer = 0;
    pond.resetWater();
}

// ------------------------------------------------------------------ static scene (per level)

const stat = new Mesh(150000);
const landDist = new Float32Array(GW * GH);
function buildStatic() {
    const m = stat;
    m.reset();
    m.quad([-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], [0, 0, 0], 3);

    // distance from water into the land (cells), for the banks
    const q = [];
    for (let k = 0; k < GW * GH; k++) { if (pond.mask[k]) { landDist[k] = 0; q.push(k); } else landDist[k] = 1e9; }
    for (let h = 0; h < q.length; h++) {
        const k = q[h], i = k % GW, j = (k / GW) | 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ni = i + di, nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= GW || nj >= GH) continue;
            const nk = nj * GW + ni;
            if (landDist[nk] > landDist[k] + 1) { landDist[nk] = landDist[k] + 1; q.push(nk); }
        }
    }
    const noise = (x, y) => Math.sin(x * 0.7 + y * 0.3) * 0.5 + Math.sin(x * 0.23 - y * 0.61) * 0.7 + Math.sin(x * 1.7 + y * 1.3) * 0.15;
    // signed distance in cells (water < 0 < land), smoothed so the banks don't follow the grid's staircase
    const SD = new Float32Array(GW * GH), tmp = new Float32Array(GW * GH);
    for (let k = 0; k < GW * GH; k++) SD[k] = pond.mask[k] ? 0.5 - pond.dist[k] : Math.min(landDist[k], 40) - 0.5;
    for (let pass = 0; pass < 3; pass++) {
        for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
            let sum = 0, n = 0;
            for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
                const a = i + di, b = j + dj;
                if (a < 0 || b < 0 || a >= GW || b >= GH) continue;
                sum += SD[b * GW + a]; n++;
            }
            tmp[j * GW + i] = sum / n;
        }
        SD.set(tmp);
    }
    const sd = (i, j) => SD[Math.max(0, Math.min(GH - 1, j)) * GW + Math.max(0, Math.min(GW - 1, i))];
    const ground = (x, y) => {
        const u = Math.max(0, Math.min(GW - 1.001, (x - X0) / CELL - 0.5)), w = Math.max(0, Math.min(GH - 1.001, (y - Y0) / CELL - 0.5));
        const i = Math.floor(u), j = Math.floor(w), fu = u - i, fw = w - j;
        let d = (sd(i, j) * (1 - fu) + sd(i + 1, j) * fu) * (1 - fw) + (sd(i, j + 1) * (1 - fu) + sd(i + 1, j + 1) * fu) * fw;
        d += Math.max(0, Math.abs(x) - (GW * CELL / 2 - 0.2), Math.abs(y) - (GH * CELL / 2 - 0.2)) / CELL;     // keep rising outside the grid
        const du = d * CELL;
        if (du <= 0) return -0.1 + Math.max(-0.5, du * 0.25);
        return 0.55 * (1 - Math.exp(-du / 0.9)) + Math.max(0, du - 5) * 0.12 + noise(x, y) * 0.14 * Math.min(1, du / 1.5);
    };
    const groundCol = (x, y, z) => {
        const n = noise(x * 1.7, y * 1.7) * 0.5 + 0.5;
        if (z < 0.14) return [0.3, 0.27, 0.22];                                      // muddy bank
        return [0.12 + n * 0.06, 0.24 + n * 0.08, 0.16 + n * 0.04];                   // moonlit grass
    };
    // fine terrain around the pond, and a coarse one further out that tucks under it (no cracks at the seam)
    const tile = (x, y, s, drop) => {
        const p = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map(([a, b]) => [a, b, ground(a, b) - drop]);
        if (Math.max(p[0][2], p[1][2], p[2][2], p[3][2]) < -0.05) return;          // fully under water
        m.quad(p[0], p[1], p[2], p[3], groundCol(x, y, (p[0][2] + p[2][2]) / 2 + drop));
    };
    const FX = 14, FY0 = -9.5, FY1 = 10;
    for (let y = FY0; y < FY1 - 1e-6; y += 0.25) for (let x = -FX; x < FX - 1e-6; x += 0.25) tile(x, y, 0.25, 0);
    for (let y = -18; y < 28; y += 1) for (let x = -32; x < 32; x += 1) {
        if (x >= -FX + 1 && x + 1 <= FX - 1 && y >= FY0 + 1 && y + 1 <= FY1 - 1) continue;
        tile(x, y, 1, 0.04);
    }
    // boulders in the water
    for (const r of L.rocks) {
        const rng = mulberry32(Math.floor(r.seed * 1000));
        const N = 9, rings = 4;
        const P = (ri, k) => {
            const ph = (ri / rings) * Math.PI / 2, a = (k / N) * 6.2832 + rng() * 0.0;
            const j = 0.85 + ((ri * 7 + k * 13 + Math.floor(r.seed)) % 5) * 0.06;
            return [r.x + Math.cos(a) * Math.cos(ph) * r.r * j, r.y + Math.sin(a) * Math.cos(ph) * r.r * j, -0.3 + Math.sin(ph) * r.r * 0.75 * j];
        };
        for (let ri = 0; ri < rings; ri++) for (let k = 0; k < N; k++) {
            const col = ri === rings - 1 ? [0.22, 0.3, 0.2] : [0.36 + (k % 3) * 0.03, 0.36, 0.38];
            const top = ri === rings - 1;
            if (top) m.tri(P(ri, k), P(ri, k + 1), [r.x, r.y, -0.3 + r.r * 0.78], col);
            else m.quad(P(ri, k), P(ri, k + 1), P(ri + 1, k + 1), P(ri + 1, k), col);
        }
    }
    // stone lanterns on the bank (their paper glows; they light the scene)
    lanterns = [];
    const rng = mulberry32(levelNo * 31 + 5);
    const candidates = [];
    for (let j = 2; j < GH - 2; j += 3) for (let i = 2; i < GW - 2; i += 3) { const k = j * GW + i; if (!pond.mask[k] && landDist[k] >= 3 && landDist[k] <= 5) candidates.push(cellCenter(i, j)); }
    const wantSpots = [[-8, -7.5], [8, -7.5], [-11, 4], [11, 4], [L.goal.x + 1.5, L.goal.y]];
    for (const [wx, wy] of wantSpots) {
        let best = null, bd = 1e9;
        for (const c of candidates) { const d = Math.hypot(c[0] - wx, c[1] - wy); if (d < bd) { bd = d; best = c; } }
        if (best && bd < 4 && !lanterns.some((l) => Math.hypot(l.x - best[0], l.y - best[1]) < 3)) lanterns.push({ x: best[0], y: best[1], z: ground(best[0], best[1]) });
    }
    for (const l of lanterns) {
        const { x, y, z } = l, stone = [0.5, 0.5, 0.52];
        tube(m, x, y, 6, 0.32, z, 0.26, z + 0.15, stone);
        tube(m, x, y, 6, 0.1, z + 0.15, 0.09, z + 0.75, stone);
        tube(m, x, y, 6, 0.26, z + 0.75, 0.24, z + 0.85, stone);
        tube(m, x, y, 4, 0.18, z + 0.85, 0.18, z + 1.15, [1.6, 1.05, 0.55], 2, Math.PI / 4);      // glowing paper box
        tube(m, x, y, 6, 0.42, z + 1.15, 0, z + 1.5, [0.42, 0.42, 0.45]);                         // roof
        l.lz = z + 1.0;
    }
    // reeds along the bank
    for (let t = 0; t < 260; t++) {
        const c = candidates[Math.floor(rng() * candidates.length)];
        if (!c) break;
        const x = c[0] + (rng() - 0.5) * 1.2, y = c[1] + (rng() - 0.5) * 1.2, z = ground(x, y);
        if (z < 0.05 || z > 0.4) continue;
        const h = 0.4 + rng() * 0.6, a = rng() * 6.28, lean = (rng() - 0.5) * 0.25;
        const col = [0.14 + rng() * 0.05, 0.3 + rng() * 0.1, 0.14];
        m.tri([x - Math.cos(a) * 0.03, y - Math.sin(a) * 0.03, z], [x + Math.cos(a) * 0.03, y + Math.sin(a) * 0.03, z], [x + lean, y + lean * 0.5, z + h], col);
    }
    // a cherry tree on the far bank
    const tx = -9.5, ty = 8.8, tz = ground(tx, ty);
    tube(m, tx, ty, 6, 0.28, tz, 0.18, tz + 2.2, [0.28, 0.2, 0.18]);
    for (let k = 0; k < 9; k++) {
        const a = k * 0.7, r = 0.6 + (k % 3) * 0.55, cx = tx + Math.cos(a) * r, cy = ty + Math.sin(a) * r * 0.6, cz = tz + 2.4 + (k % 4) * 0.3;
        tube(m, cx, cy, 7, 0.75 - (k % 3) * 0.12, cz - 0.3, 0, cz + 0.6, [0.95, 0.62, 0.72]);
        tube(m, cx, cy, 7, 0.75 - (k % 3) * 0.12, cz - 0.3, 0, cz - 0.75, [0.82, 0.5, 0.62]);
    }
    // the water: one plane over the whole pond; the shader reads the ripple texture
    let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;                // only as big as the pond itself
    for (let k = 0; k < GW * GH; k++) if (pond.mask[k]) {
        const [x, y] = cellCenter(k % GW, (k / GW) | 0);
        bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
    }
    bx0 -= 0.6; by0 -= 0.6; bx1 += 0.6; by1 += 0.6;
    m.quad([bx0, by0, 0], [bx1, by0, 0], [bx1, by1, 0], [bx0, by1, 0], [0, 0, 0], 1);
    space.setStatic(m.pos, m.col, m.n);
    stat.count = m.n;
}

// ------------------------------------------------------------------ input

const toWater = (sx, sy) => {
    const nx = (sx / innerWidth) * 2 - 1, ny = 1 - (sy / innerHeight) * 2, aspect = canvas.width / canvas.height, k = 1.6 / space.magnifier;
    const X = space.xUnitVec, Y = space.yUnitVec, Z = space.zUnitVec;
    const d = [0, 1, 2].map((i) => Z[i] - X[i] * nx * k + Y[i] * ny * k / aspect);
    if (d[2] >= 0) return null;
    const t = -space.Zc / d[2];
    return [space.Xc + d[0] * t, space.Yc + d[1] * t];
};
canvas.addEventListener("pointerdown", (e) => {
    audio.init();
    if (state === "title") { start(); return; }
    if (state !== "play") return;
    const p = toWater(e.clientX, e.clientY);
    if (!p || !pond.isWater(p[0], p[1])) return;
    if (stonesLeft <= 0) { ui.toast("No pebbles left — press R to retry"); return; }
    stonesLeft--;
    falling.push({ x: p[0], y: p[1], z: 5, vz: 0 });
    ui.hud();
});
addEventListener("keydown", (e) => {
    audio.init();
    if (e.code === "KeyM") { ui.toast(audio.toggleMute() ? "Sound off" : "Sound on"); return; }
    if (state === "title" && (e.code === "Space" || e.code === "Enter")) start();
    else if (e.code === "KeyR" && (state === "play" || state === "lost")) retry();
    else if ((e.code === "Space" || e.code === "Enter") && state === "won") next();
    else if ((e.code === "Space" || e.code === "Enter") && state === "lost") retry();
});
function start() { state = "play"; loadLevel(save.level); ui.show("hud"); }
function retry() { state = "play"; resetBoats(); ui.show("hud"); ui.hud(); }
function next() { state = "play"; loadLevel(levelNo + 1); ui.show("hud"); }

// a pebble hits the water
function splash(x, y) {
    pond.drop(x, y);
    pulses.push({ id: pulseId++, x, y, t: 0, strength: 1 });
    audio.plop(0.9 + Math.random() * 0.3);
    for (let i = 0; i < 26; i++) {
        const a = Math.random() * 6.28, s = 0.6 + Math.random() * 1.6;
        splashes.push({ x, y, z: 0.05, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: 2 + Math.random() * 2.5, life: 0.7 + Math.random() * 0.4, max: 1.1 });
    }
}

// ------------------------------------------------------------------ physics

function pushFloaters(dt) {
    for (const p of pulses) p.t += dt;
    pulses = pulses.filter((p) => p.t * WAVE_SPEED < 32);
    const floaters = [boat, ...lilies];
    for (const f of floaters) {
        for (const p of pulses) {
            if (f.hits.has(p.id)) continue;
            const dx = f.x - p.x, dy = f.y - p.y, d = Math.hypot(dx, dy) || 0.001;
            if (p.t * WAVE_SPEED < d - 0.2) continue;             // the ring hasn't reached it yet
            f.hits.add(p.id);
            const k = (f === boat ? 3.3 : 2.4) * Math.exp(-d / 6.5) * p.strength;
            f.vx += (dx / d) * k; f.vy += (dy / d) * k;
        }
        // move, with drag; bounce off banks and rocks
        const drag = Math.exp(-dt * 0.85);
        f.vx *= drag; f.vy *= drag;
        const nx = f.x + f.vx * dt, ny = f.y + f.vy * dt;
        if (pond.clearance(nx, ny) < f.r) {
            const e = 0.25, gx = pond.clearance(f.x + e, f.y) - pond.clearance(f.x - e, f.y), gy = pond.clearance(f.x, f.y + e) - pond.clearance(f.x, f.y - e);
            const gl2 = Math.hypot(gx, gy) || 1, n = [gx / gl2, gy / gl2];
            const vn = f.vx * n[0] + f.vy * n[1];
            if (vn < 0) { f.vx -= 1.6 * vn * n[0]; f.vy -= 1.6 * vn * n[1]; if (f === boat && vn < -0.4) audio.bump(); }
        } else { f.x = nx; f.y = ny; }
    }
    // the boat turns to face where it's going
    if (Math.hypot(boat.vx, boat.vy) > 0.08) {
        const want = Math.atan2(boat.vy, boat.vx), d = Math.atan2(Math.sin(want - boat.a), Math.cos(want - boat.a));
        boat.a += d * Math.min(1, dt * 4);
    }
    // floaters bump into each other
    for (let i = 0; i < floaters.length; i++) for (let j = i + 1; j < floaters.length; j++) {
        const a = floaters[i], b = floaters[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r;
        if (d > 0 && d < min) {
            const nx = dx / d, ny = dy / d, push = (min - d) / 2;
            a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
            const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
            if (rel < 0) { a.vx += rel * nx * 0.9; a.vy += rel * ny * 0.9; b.vx -= rel * nx * 0.9; b.vy -= rel * ny * 0.9; }
        }
    }
}

function update(dt) {
    time += dt;
    // wave simulation at a fixed rate
    simAcc += dt;
    for (let s = 0; s < 4 && simAcc >= 1 / SIM_HZ; s++) { pond.step(); simAcc -= 1 / SIM_HZ; }
    simAcc = Math.min(simAcc, 1 / SIM_HZ);

    // the title screen: pebbles drop by themselves for the view
    if (state === "title") {
        demoTimer -= dt;
        if (demoTimer <= 0) { demoTimer = 1.6 + Math.random() * 1.5; const a = Math.random() * 6.28, r = Math.random() * 5; if (pond.isWater(Math.cos(a) * r, Math.sin(a) * r * 0.6)) falling.push({ x: Math.cos(a) * r, y: Math.sin(a) * r * 0.6, z: 5, vz: 0 }); }
    }
    for (const f of falling) { f.vz -= 22 * dt; f.z += f.vz * dt; }
    for (const f of falling.filter((f) => f.z <= 0)) splash(f.x, f.y);
    falling = falling.filter((f) => f.z > 0);

    pushFloaters(dt);

    if (state === "play") {
        for (const l of L.lotus) {
            if (!l.got && Math.hypot(l.x - boat.x, l.y - boat.y) < 0.75) {
                l.got = true; got++;
                audio.lotus(got);
                for (let i = 0; i < 30; i++) { const a = Math.random() * 6.28; splashes.push({ x: l.x, y: l.y, z: 0.3, vx: Math.cos(a) * 1.2, vy: Math.sin(a) * 1.2, vz: 1 + Math.random() * 2, life: 1, max: 1, pink: true }); }
                ui.hud();
            }
        }
        if (Math.hypot(L.goal.x - boat.x, L.goal.y - boat.y) < 0.95) win();
        // out of pebbles and everything has settled → lost
        const moving = Math.hypot(boat.vx, boat.vy) > 0.05 || falling.length || pulses.some((p) => p.t * WAVE_SPEED < 20);
        idleTimer = stonesLeft === 0 && !moving ? idleTimer + dt : 0;
        if (idleTimer > 1.2) lose();
    }
    if (state === "won") { boat.vx += (L.goal.x - boat.x) * dt * 2; boat.vy += (L.goal.y - boat.y) * dt * 2; }
    for (const l of L.lotus) l.open += ((l.got ? 1 : 0) - l.open) * Math.min(1, dt * 3);

    for (const s of splashes) { s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt; s.vz -= 9 * dt; s.life -= dt; }
    splashes = splashes.filter((s) => s.life > 0 && s.z > -0.1);
    // petals drift down onto the water and float
    if (Math.random() < dt * 1.5) petals.push({ x: -9.5 + (Math.random() - 0.5) * 4, y: 8.4 + (Math.random() - 0.5) * 2, z: 4, vx: 0.3 + Math.random() * 0.4, vy: -0.4 - Math.random() * 0.4, life: 14 });
    for (const p of petals) {
        if (p.z > 0.02) { p.z -= dt * 0.6; p.x += (p.vx + Math.sin(time * 2 + p.life) * 0.3) * dt; p.y += p.vy * dt; }
        else { p.z = 0.02 + pond.height(p.x, p.y) * 0.3; p.x += p.vx * dt * 0.1; }
        p.life -= dt;
    }
    petals = petals.filter((p) => p.life > 0);
    pond.pack();
}

function win() {
    state = "won";
    audio.win();
    const prev = save.best[levelNo] || 0;
    save.best[levelNo] = Math.max(prev, got);
    save.level = Math.max(save.level, levelNo + 1);
    persist();
    for (let i = 0; i < 80; i++) { const a = Math.random() * 6.28, s = Math.random() * 2; splashes.push({ x: L.goal.x, y: L.goal.y, z: 0.3, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: 1.5 + Math.random() * 3, life: 1.6, max: 1.6, gold: true }); }
    setTimeout(() => ui.result(true, got, prev), 1200);
}
function lose() { state = "lost"; audio.fail(); ui.result(false, got, 0); }

// ------------------------------------------------------------------ per-frame geometry

const solid = new Mesh(30000), glow = new Mesh(20000);
for (let i = 0; i < 46; i++) fireflies.push({ x: (Math.random() - 0.5) * 26, y: (Math.random() - 0.5) * 18, z: 0.4 + Math.random() * 2, s: Math.random() * 100 });

function paperBoat(m, b) {
    const ca = Math.cos(b.a), sa = Math.sin(b.a), [gx, gy] = pond.slope(b.x, b.y);
    const z0 = pond.height(b.x, b.y) * 0.35 + 0.02;
    const roll = Math.max(-0.4, Math.min(0.4, -gy * ca * 0.2 + gx * sa * 0.2)), pitch = Math.max(-0.4, Math.min(0.4, gx * ca * 0.2 + gy * sa * 0.2));
    const P = (fx, sy, z) => {                       // forward, side, up in the boat's frame
        fx *= 1.25; sy *= 1.25; z *= 1.25;
        const zz = z + sy * roll + fx * pitch;
        return [b.x + fx * ca - sy * sa, b.y + fx * sa + sy * ca, z0 + zz];
    };
    const W = [0.95, 0.95, 0.92], S2 = [0.82, 0.83, 0.86];
    const bowL = P(0.55, 0, 0.2), sternL = P(-0.55, 0, 0.2), mid = P(0, 0, -0.02);
    m.tri(P(0.55, 0, 0.22), P(-0.55, 0, 0.22), P(0, 0.22, 0.12), W);
    m.tri(P(0.55, 0, 0.22), P(0, -0.22, 0.12), P(-0.55, 0, 0.22), S2);
    m.tri(P(0.55, 0, 0.22), P(0, 0.22, 0.12), mid, S2);
    m.tri(P(-0.55, 0, 0.22), mid, P(0, 0.22, 0.12), W);
    m.tri(P(0.55, 0, 0.22), mid, P(0, -0.22, 0.12), W);
    m.tri(P(-0.55, 0, 0.22), P(0, -0.22, 0.12), mid, S2);
    m.tri(P(0.3, 0, 0.18), P(-0.3, 0, 0.18), P(0, 0, 0.62), [0.97, 0.96, 0.93]);              // the folded sail
    const c = P(0.05, 0.06, 0.3);
    return c;
}
function lilyPad(m, l, flower) {
    const z = pond.height(l.x, l.y) * 0.3 + 0.015;
    const N = 12;
    for (let i = 0; i < N; i++) {
        if (i === 0) continue;                        // the notch
        const a0 = l.a + (i / N) * 6.2832, a1 = l.a + ((i + 1) / N) * 6.2832;
        m.tri([l.x, l.y, z], [l.x + Math.cos(a0) * l.r, l.y + Math.sin(a0) * l.r, z], [l.x + Math.cos(a1) * l.r, l.y + Math.sin(a1) * l.r, z], i % 2 ? [0.16, 0.42, 0.18] : [0.2, 0.48, 0.2]);
    }
}
function lotus(m, g, l) {
    const z = pond.height(l.x, l.y) * 0.3 + 0.02;
    lilyPad(m, { x: l.x, y: l.y, r: 0.42, a: l.x }, false);
    const open = l.open, pet = 8;
    const col = l.got ? [1.5, 0.75, 1.0] : [0.9, 0.5, 0.7];
    for (let i = 0; i < pet; i++) {
        const a = (i / pet) * 6.2832 + time * 0.1, spread = 0.05 + open * 0.28, h = 0.28 - open * 0.08;
        const bx = l.x + Math.cos(a) * spread, by = l.y + Math.sin(a) * spread;
        const left = a - 0.3, right = a + 0.3;
        m.tri([l.x + Math.cos(left) * 0.05, l.y + Math.sin(left) * 0.05, z + 0.04], [l.x + Math.cos(right) * 0.05, l.y + Math.sin(right) * 0.05, z + 0.04], [bx, by, z + 0.04 + h], col, l.got ? 2 : 0);
    }
    g.sprite(l.x, l.y, z + 0.25, l.got ? 0.9 : 0.5, l.got ? 0.7 : 0.35, l.got ? 0.35 : 0.18, l.got ? 0.5 : 0.28);
}

function buildDynamic() {
    solid.reset(); glow.reset();
    // goal: a ring of floating candles and a glow
    const G = L.goal;
    for (let k = 0; k < 14; k++) {
        const a = (k / 14) * 6.2832 + time * 0.2, x = G.x + Math.cos(a) * 1.0, y = G.y + Math.sin(a) * 1.0, z = pond.height(x, y) * 0.3;
        tube(solid, x, y, 5, 0.07, z, 0.07, z + 0.12, [0.9, 0.86, 0.75]);
        glow.sprite(x, y, z + 0.2, 0.22 + 0.04 * Math.sin(time * 9 + k), 1.0, 0.65, 0.25);
    }
    glow.sprite(G.x, G.y, 0.2, 1.3, 0.16, 0.11, 0.05);
    for (const l of lilies) lilyPad(solid, l);
    for (const l of L.lotus) lotus(solid, glow, l);
    if (state !== "title" || true) {
        const c = paperBoat(solid, boat);
        glow.sprite(c[0], c[1], c[2] + 0.12, 0.35 + 0.05 * Math.sin(time * 13), 1.0, 0.7, 0.3);           // candle
        glow.sprite(c[0], c[1], c[2] + 0.12, 0.12, 1.4, 1.2, 0.8);
    }
    for (const f of falling) tube(solid, f.x, f.y, 6, 0.09, f.z, 0, f.z + 0.14, [0.55, 0.53, 0.5]);
    for (const s of splashes) {
        const k = s.life / s.max;
        const c = s.pink ? [1.0, 0.5, 0.75] : s.gold ? [1.2, 0.85, 0.35] : [0.55, 0.7, 0.9];
        glow.sprite(s.x, s.y, s.z, s.pink || s.gold ? 0.07 : 0.05, c[0] * k, c[1] * k, c[2] * k);
    }
    for (const p of petals) {
        const s = 0.07, a = p.life * 2;
        solid.tri([p.x, p.y, p.z], [p.x + Math.cos(a) * s, p.y + Math.sin(a) * s, p.z + 0.01], [p.x + Math.cos(a + 1.2) * s, p.y + Math.sin(a + 1.2) * s, p.z], [0.95, 0.65, 0.75]);
    }
    for (const f of fireflies) {
        const x = f.x + Math.sin(time * 0.3 + f.s) * 1.5, y = f.y + Math.cos(time * 0.23 + f.s * 2) * 1.2, z = f.z + Math.sin(time * 0.7 + f.s) * 0.4;
        const k = Math.max(0, Math.sin(time * 1.3 + f.s * 7)) ** 3;
        glow.sprite(x, y, z, 0.07, 0.8 * k, 1.0 * k, 0.35 * k);
        if (k > 0.3) glow.sprite(x, y, z, 0.3, 0.12 * k, 0.16 * k, 0.05 * k);
    }
    for (const l of lanterns) glow.sprite(l.x, l.y, l.lz, 1.0 + 0.05 * Math.sin(time * 7 + l.x), 0.35, 0.22, 0.1);
    const n = solid.n;
    solid.append(glow);
    space.setDynamic(solid.pos, solid.col, solid.n);
    return { sN: n, gN: glow.n };
}

const lightBuf = new Float32Array(24);
function render() {
    const aspect = canvas.width / canvas.height;
    space.magnifier = aspect < 1 ? 1.1 : aspect < 1.5 ? 1.6 : 1.95;
    const sway = state === "title" ? [Math.sin(time * 0.12) * 2.5, Math.cos(time * 0.1) * 1] : [0, 0];
    space.lookAt(sway[0], -15.5 + sway[1], 15.5, 0, -0.6, 0);
    const { sN, gN } = buildDynamic();

    gl.bindTexture(gl.TEXTURE_2D, waterTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GW, GH, gl.RGBA, gl.UNSIGNED_BYTE, pond.tex);
    const nl = Math.min(6, lanterns.length);
    lanterns.slice(0, nl).forEach((l, i) => lightBuf.set([l.x, l.y, l.lz, 0.9 + 0.1 * Math.sin(time * 8 + i * 3)], i * 4));
    gl.uniform1f(U.aspect, aspect);
    gl.uniform3f(U.veriables, space.zShifter, space.magnifier, 0);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, time);
    gl.uniform4f(U.uPondRect, X0, Y0, GW * CELL, GH * CELL);
    gl.uniform4fv(U.uLights, lightBuf);
    gl.uniform1f(U.uLightCount, nl);
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
const ui = {
    show(which) { for (const id of ["title", "hud", "result"]) $(id).classList.toggle("hidden", id !== which); if (which === "hud") this.hud(); },
    hud() {
        if (!L) return;
        $("lv").textContent = levelNo;
        $("stones").innerHTML = Array.from({ length: L.stones }, (_, i) => `<i class="${i < stonesLeft ? "" : "used"}"></i>`).join("");
        $("lotus").innerHTML = [0, 1, 2].map((i) => `<b class="${i < got ? "on" : ""}">✿</b>`).join("");
    },
    result(won, n, prev) {
        this.show("result");
        $("r-title").textContent = won ? "The boat found its way" : "Out of pebbles";
        $("r-lotus").innerHTML = [0, 1, 2].map((i) => `<b class="${i < n ? "on" : ""}" style="animation-delay:${0.15 + i * 0.2}s">✿</b>`).join("");
        $("r-msg").textContent = won ? (n === 3 ? "Every lotus bloomed." : n > prev ? "A new best for this pond." : `${3 - n} lotus still asleep — try again for all three?`) : "The boat drifts still. Try a different path.";
        $("r-next").classList.toggle("hidden", !won);
        $("r-total").textContent = totalLotus();
    },
    toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(this._t); this._t = setTimeout(() => el.classList.remove("show"), 1600); },
};
$("r-next").addEventListener("click", (e) => { e.stopPropagation(); next(); });
$("r-retry").addEventListener("click", (e) => { e.stopPropagation(); retry(); });
$("retry").addEventListener("click", (e) => { e.stopPropagation(); if (state === "play") retry(); });
$("title").addEventListener("pointerdown", () => { audio.init(); if (state === "title") start(); });
$("t-level").textContent = save.level;
$("t-lotus").textContent = totalLotus();

// ------------------------------------------------------------------ loop

loadLevel(save.level);
ui.show("title");
if (new URLSearchParams(location.search).has("autoplay")) {      // demo / testing: drop pebbles behind the boat towards the goal
    start();
    window.__ripple = () => ({ state, level: levelNo, boat: [boat.x.toFixed(2), boat.y.toFixed(2)], goal: [L.goal.x, L.goal.y.toFixed(2)], stonesLeft, got, card: $("result").classList.contains("hidden") ? "" : $("r-title").textContent + " / " + $("r-msg").textContent });
    setInterval(() => {
        if (state === "play" && stonesLeft > 0 && Math.hypot(boat.vx, boat.vy) < 0.6 && !falling.length) {
            const tx = L.path[Math.min(L.path.length - 1, L.path.findIndex((p) => Math.hypot(p[0] - boat.x, p[1] - boat.y) < 1.2) + 12)] || [L.goal.x, L.goal.y];
            const dx = tx[0] - boat.x, dy = tx[1] - boat.y, d = Math.hypot(dx, dy) || 1;
            const px = boat.x - (dx / d) * 1.2, py = boat.y - (dy / d) * 1.2;
            if (pond.isWater(px, py)) { stonesLeft--; falling.push({ x: px, y: py, z: 5, vz: 0 }); ui.hud(); }
        } else if (state === "won" && !$("result").classList.contains("hidden")) next();
        else if (state === "lost") retry();
    }, 900 / SPEED);
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
