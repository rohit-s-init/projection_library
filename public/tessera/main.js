// TESSERA — grow a little island, one hex tile at a time. Rendered with the projection3d library (Space).
//
// You hold one tile. Rotate it and place it next to the island: every edge that matches its neighbour scores,
// rivers must connect, and a tile that fits all its neighbours ("perfect") earns an extra tile. Quests ask you
// to grow a region (a forest, a wheat field, a village, a river) to a size — finishing one earns more tiles.
// The game ends when your stack runs out. Best score is saved in the browser.
//
// Rendering: the static scene (sky, sea with shoreline foam, all settled tiles) lives in Space's buffers and is
// rebuilt when a tile lands; the tile in your hand, falling tiles, outlines, smoke, birds and glows are rebuilt
// into GameSpace's dynamic buffers every frame.

import GameSpace from "./GameSpace.js";
import { createProgram } from "./shaders.js";
import { Audio } from "./audio.js";
import {
    T, TYPE_NAMES, TYPE_COLORS, DIRS, LAND_Z, hexKey, hexCenter, pixelToHex, corner,
    randomTile, rotated, hubType, buildTile, regionSize, mulberry32,
} from "./tiles.js";

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
    tri(a, b, c, col, mat, w = 1) {
        this.v(a[0], a[1], a[2], w, col[0], col[1], col[2], mat);
        this.v(b[0], b[1], b[2], w, col[0], col[1], col[2], mat);
        this.v(c[0], c[1], c[2], w, col[0], col[1], col[2], mat);
    }
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
    const dpr = Math.min(1.75, window.devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * dpr); canvas.height = Math.round(innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
}
sizeCanvas();
addEventListener("resize", sizeCanvas);

const space = new GameSpace(gl);
const U = createProgram(gl, space);
const audio = new Audio();
const SUN = (() => { const v = [-0.55, -0.45, 0.5], m = Math.hypot(...v); return v.map((x) => x / m); })();
space.magnifier = 2.2;

// ------------------------------------------------------------------ game state

const board = new Map();                 // "q,r" → { q, r, tile, t0 (landing time), settled }
let state = "title";                     // title | play | over
let stack = [], hand = null, handRot = 0, spin = 0;
let score = 0, placed = 0, perfects = 0, questsDone = 0;
let quests = [];                         // { key, sector, type, target }
let time = 0, rng = mulberry32(Date.now() & 0xffffffff);
let chimneys = [];
let staticDirty = true;
let best = 0;
try { best = +localStorage.getItem("tessera.best") || 0; } catch { }

const cam = { tx: 0, ty: 0, yaw: -2.2, pitch: 0.85, dist: 17, cyaw: -2.2, cpitch: 0.85, cdist: 17, ctx: 0, cty: 0 };

function freeSpots() {
    const spots = new Map();
    for (const { q, r } of board.values())
        for (const [dq, dr] of DIRS) {
            const k = hexKey(q + dq, r + dr);
            if (!board.has(k)) spots.set(k, [q + dq, r + dr]);
        }
    return spots;
}

// how a tile would fit at (q, r): matching edges, neighbours, and whether rivers line up
function evaluate(q, r, tile) {
    let n = 0, match = 0, ok = true;
    const marks = [];
    for (let i = 0; i < 6; i++) {
        const nb = board.get(hexKey(q + DIRS[i][0], r + DIRS[i][1]));
        if (!nb) { marks.push(null); continue; }
        n++;
        const mine = tile.edges[i], theirs = nb.tile.edges[(i + 3) % 6];
        const m = mine === theirs;
        if (m) match++;
        if (!m && (mine === T.WATER || theirs === T.WATER)) ok = false;
        marks.push(m ? "match" : (mine === T.WATER || theirs === T.WATER) ? "block" : "miss");
    }
    return { n, match, ok: ok && n > 0, marks };
}

function hasPlacement(tile) {
    for (const [, [q, r]] of freeSpots()) for (let s = 0; s < 6; s++) if (evaluate(q, r, rotated(tile, s)).ok) return true;
    return false;
}

function drawHand() {
    hand = null;
    while (stack.length) {
        const t = stack.pop();
        if (hasPlacement(t)) { hand = t; break; }
        toast("No room for that tile — skipped");
    }
    handRot = 0; spin = 0;
    if (!hand && state === "play") endGame();
}

function newGame() {
    board.clear(); quests = []; score = 0; placed = 0; perfects = 0; questsDone = 0;
    rng = mulberry32((Math.random() * 1e9) | 0);
    let start;
    do { start = randomTile(rng); } while (start.edges.includes(T.WATER) || new Set(start.edges).size < 3);
    board.set("0,0", { q: 0, r: 0, tile: start, t0: -9, settled: true });
    stack = Array.from({ length: 28 }, () => randomTile(rng));
    state = "play";
    staticDirty = true;
    drawHand();
    cam.tx = 0; cam.ty = 0; cam.dist = 15; cam.pitch = 0.9;
    ui.show("hud");
}

// a decorative island for the title screen: tiles placed greedily by best fit
function demoIsland() {
    board.clear(); quests = [];
    const r = mulberry32(7);
    board.set("0,0", { q: 0, r: 0, tile: randomTile(r), t0: -9, settled: true });
    for (let n = 0; n < 26; n++) {
        const tile = randomTile(r);
        let bestPick = null;
        for (const [, [q, rr]] of freeSpots()) {
            if (Math.hypot(...hexCenter(q, rr)) > 5.5) continue;
            for (let s = 0; s < 6; s++) {
                const t2 = rotated(tile, s), e = evaluate(q, rr, t2);
                const sc = e.ok ? e.match * 2 + e.n + r() : -1;
                if (!bestPick || sc > bestPick.sc) bestPick = { q, r: rr, t2, sc };
            }
        }
        if (bestPick && bestPick.sc >= 0) board.set(hexKey(bestPick.q, bestPick.r), { q: bestPick.q, r: bestPick.r, tile: bestPick.t2, t0: -9, settled: true });
    }
    staticDirty = true;
}

function place(q, r) {
    const tile = rotated(hand, handRot);
    const ev = evaluate(q, r, tile);
    if (!ev.ok) { audio.deny(); toast(ev.n === 0 ? "Place it next to the island" : "Rivers have to connect"); return; }
    const key = hexKey(q, r);
    board.set(key, { q, r, tile, t0: time, settled: false });
    placed++;
    let gained = ev.match * 10, bonus = 0, extra = 0;
    const [x, y] = hexCenter(q, r);
    if (ev.match === ev.n && ev.n >= 2) {
        bonus = ev.n === 6 ? 60 : 20;
        extra = ev.n === 6 ? 2 : 1;
        perfects++;
        popup(x, y, 1.6, ev.n === 6 ? `PERFECT ×6!  +${extra} tiles` : `Perfect fit!  +1 tile`, "perfect");
        audio.perfect();
        burst(x, y, LAND_Z + 0.4, 40, [1.2, 1.05, 0.6], 2.5);
    }
    for (let k = 0; k < extra; k++) stack.push(randomTile(rng));
    score += gained + bonus;
    if (gained) popup(x, y, 1.0, `+${gained + bonus}`, "points");
    audio.place(ev.match);
    checkQuests(key);
    maybeNewQuest(key, tile);
    drawHand();
    ui.hud();
}

function checkQuests(justPlaced) {
    quests = quests.filter((qu) => {
        const size = regionSize(board, qu.key, qu.sector);
        qu.size = size;
        if (size < qu.target) return true;
        const reward = 3 + Math.floor(qu.target / 8);
        for (let k = 0; k < reward; k++) stack.push(randomTile(rng));
        const pts = qu.target * 6;
        score += pts; questsDone++;
        const c = board.get(qu.key), [x, y] = hexCenter(c.q, c.r);
        popup(x, y, 2.2, `${TYPE_NAMES[qu.type]} quest done!  +${reward} tiles  +${pts}`, "quest");
        burst(x, y, LAND_Z + 0.6, 60, [1.1, 0.95, 0.5], 3.5);
        audio.quest();
        return false;
    });
}

function maybeNewQuest(key, tile) {
    if (quests.length >= 3 || rng() > 0.34) return;
    const options = [];
    tile.edges.forEach((t, i) => { if (t !== T.MEADOW && !quests.some((q) => q.type === t && regionSize(board, q.key, q.sector) === regionSize(board, key, i) && q.key === key)) options.push(i); });
    if (!options.length) return;
    const sector = options[Math.floor(rng() * options.length)], type = tile.edges[sector];
    const size = regionSize(board, key, sector);
    const grow = type === T.VILLAGE ? 2 + Math.floor(rng() * 4) : type === T.WATER ? 2 + Math.floor(rng() * 3) : 4 + Math.floor(rng() * 6);
    quests.push({ key, sector, type, target: size + grow, size });
}

function endGame() {
    state = "over";
    const newBest = score > best;
    best = Math.max(best, score);
    try { localStorage.setItem("tessera.best", String(best)); } catch { }
    audio.end();
    setTimeout(() => ui.over(newBest), 900);
}

// ------------------------------------------------------------------ particles

const MAXP = 900;
const P = { n: 0, d: new Float32Array(MAXP * 12) };        // x y z vx vy vz life max size r g b
function emit(x, y, z, vx, vy, vz, life, size, col) {
    if (P.n >= MAXP) return;
    const o = P.n++ * 12, d = P.d;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
    d[o + 6] = d[o + 7] = life; d[o + 8] = size; d[o + 9] = col[0]; d[o + 10] = col[1]; d[o + 11] = col[2];
}
function burst(x, y, z, n, col, spd) {
    for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.28, s = spd * (0.3 + Math.random() * 0.7);
        emit(x, y, z, Math.cos(a) * s, Math.sin(a) * s, 0.5 + Math.random() * spd, 0.6 + Math.random() * 0.6, 0.12, col);
    }
}
function updateParticles(dt) {
    const d = P.d;
    for (let i = 0; i < P.n; i++) {
        const o = i * 12;
        d[o + 6] -= dt;
        if (d[o + 6] <= 0) { const l = --P.n * 12; for (let k = 0; k < 12; k++) d[o + k] = d[l + k]; i--; continue; }
        d[o] += d[o + 3] * dt; d[o + 1] += d[o + 4] * dt; d[o + 2] += d[o + 5] * dt;
        const drag = Math.exp(-dt * 2.2); d[o + 3] *= drag; d[o + 4] *= drag; d[o + 5] = d[o + 5] * drag - 1.2 * dt;
    }
}

// ------------------------------------------------------------------ static scene

const staticMesh = new Mesh(200000);
let ranges = { sky: 0, opaque: [0, 0] };

function buildStatic() {
    const m = staticMesh;
    m.reset();
    m.tri([-1, -1, 0], [1, -1, 0], [1, 1, 0], [0, 0, 0], 3);
    m.tri([-1, -1, 0], [1, 1, 0], [-1, 1, 0], [0, 0, 0], 3);
    const sky = m.n;

    // sea: a grid around the island; pos.w = distance to the island's shore (turquoise shallows + foam)
    const centers = [...board.values()].map(({ q, r }) => hexCenter(q, r));
    const shore = (x, y) => {
        let d = 1e9;
        for (const c of centers) d = Math.min(d, Math.hypot(x - c[0], y - c[1]));
        return Math.max(0, d - 0.88);
    };
    const G = 44, S = 1.1;
    const W = [];
    for (let j = 0; j <= 2 * G; j++) { const row = []; for (let i = 0; i <= 2 * G; i++) row.push(shore((i - G) * S, (j - G) * S)); W.push(row); }
    for (let j = 0; j < 2 * G; j++) for (let i = 0; i < 2 * G; i++) {
        const x0 = (i - G) * S, y0 = (j - G) * S, x1 = x0 + S, y1 = y0 + S;
        const w00 = W[j][i], w10 = W[j][i + 1], w11 = W[j + 1][i + 1], w01 = W[j + 1][i];
        m.v(x0, y0, 0, w00, 0, 0, 0, 2); m.v(x1, y0, 0, w10, 0, 0, 0, 2); m.v(x1, y1, 0, w11, 0, 0, 0, 2);
        m.v(x0, y0, 0, w00, 0, 0, 0, 2); m.v(x1, y1, 0, w11, 0, 0, 0, 2); m.v(x0, y1, 0, w01, 0, 0, 0, 2);
    }
    // open sea out to the horizon
    const E = G * S, F = 500;
    for (const [a, b, c, d] of [[[-F, -F], [F, -F], [F, -E], [-F, -E]], [[-F, E], [F, E], [F, F], [-F, F]], [[-F, -E], [-E, -E], [-E, E], [-F, E]], [[E, -E], [F, -E], [F, E], [E, E]]]) {
        m.v(...a, -0.01, 30, 0, 0, 0, 2); m.v(...b, -0.01, 30, 0, 0, 0, 2); m.v(...c, -0.01, 30, 0, 0, 0, 2);
        m.v(...a, -0.01, 30, 0, 0, 0, 2); m.v(...c, -0.01, 30, 0, 0, 0, 2); m.v(...d, -0.01, 30, 0, 0, 0, 2);
    }
    // settled tiles
    chimneys = [];
    for (const c of board.values()) if (c.settled) chimneys.push(...buildTile(m, c.tile, c.q, c.r));
    ranges = { sky, opaque: [sky, m.n - sky] };
    space.setStatic(m.pos, m.col, m.n);
    staticDirty = false;
}

// ------------------------------------------------------------------ input

let hover = null, drag = null, mouse = { x: 0, y: 0 };
const pickRay = (sx, sy) => {
    const nx = (sx / innerWidth) * 2 - 1, ny = 1 - (sy / innerHeight) * 2, aspect = canvas.width / canvas.height;
    const X = space.xUnitVec, Y = space.yUnitVec, Z = space.zUnitVec, k = 1.6 / space.magnifier;
    const d = [Z[0] - X[0] * nx * k + Y[0] * ny * k / aspect, Z[1] - X[1] * nx * k + Y[1] * ny * k / aspect, Z[2] - X[2] * nx * k + Y[2] * ny * k / aspect];
    if (d[2] >= -1e-4) return null;
    const t = (LAND_Z - space.Zc) / d[2];
    return [space.Xc + d[0] * t, space.Yc + d[1] * t];
};
function updateHover() {
    hover = null;
    if (state !== "play" || !hand) return;
    const p = pickRay(mouse.x, mouse.y);
    if (!p) return;
    const [q, r] = pixelToHex(p[0], p[1]), k = hexKey(q, r);
    if (!board.has(k) && freeSpots().has(k)) hover = { q, r, ev: evaluate(q, r, rotated(hand, handRot)) };
}
function rotateHand(dir) {
    if (!hand) return;
    handRot = (handRot + dir + 6) % 6;
    audio.rotate();
    updateHover();
    ui.hud();
}

canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerdown", (e) => {
    audio.init();
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false, shift: e.shiftKey, yaw: cam.yaw, pitch: cam.pitch, tx: cam.tx, ty: cam.ty, touch: e.pointerType === "touch" };
});
canvas.addEventListener("pointermove", (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.hypot(dx, dy) > 6) drag.moved = true;
        if (drag.moved) {
            if (drag.button === 2 || (drag.touch && state !== "play")) {           // orbit
                cam.yaw = drag.yaw - dx * 0.006;
                cam.pitch = Math.max(0.42, Math.min(1.35, drag.pitch + dy * 0.005));
            } else {                                                                 // pan: drag the ground
                const k = cam.dist * 0.0022, c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
                // camera right on the ground = (-s, c), forward = (-c, -s)
                cam.tx = drag.tx + (s * dx - c * dy) * k;
                cam.ty = drag.ty + (-c * dx - s * dy) * k;
            }
        }
    }
    updateHover();
});
canvas.addEventListener("pointerup", (e) => {
    const d = drag; drag = null;
    if (!d || d.moved) return;
    if (state !== "play") return;
    if (d.button === 2) { rotateHand(1); return; }
    mouse = { x: e.clientX, y: e.clientY };
    updateHover();
    if (hover) { place(hover.q, hover.r); updateHover(); }
});
canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    cam.dist = Math.max(6, Math.min(42, cam.dist * Math.exp(e.deltaY * 0.0012)));
}, { passive: false });

const keys = new Set();
addEventListener("keydown", (e) => {
    audio.init();
    keys.add(e.code);
    if (e.code === "KeyM") { toast(audio.toggleMute() ? "Sound off" : "Sound on"); return; }
    if (state === "title") { if (e.code === "Space" || e.code === "Enter") newGame(); return; }
    if (state === "over") { if (e.code === "Space" || e.code === "Enter") newGame(); return; }
    if (e.code === "KeyR" || e.code === "KeyE" || e.code === "Space") { e.preventDefault(); rotateHand(1); }
    if (e.code === "KeyQ") rotateHand(-1);
});
addEventListener("keyup", (e) => keys.delete(e.code));

// ------------------------------------------------------------------ per frame

const dyn = new Mesh(80000), glow = new Mesh(20000);
const birds = Array.from({ length: 6 }, (_, i) => ({ r: 6 + Math.random() * 5, a: Math.random() * 6.28, z: 4.5 + Math.random() * 2.5, sp: 0.18 + Math.random() * 0.12, ph: Math.random() * 6 }));
let smokeTimer = 0;

function update(dt) {
    time += dt;
    // camera: WASD pan, gentle orbit on the title screen
    const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw), pan = cam.dist * 0.9 * dt;
    if (keys.has("KeyW") || keys.has("ArrowUp")) { cam.tx -= c * pan; cam.ty -= s * pan; }
    if (keys.has("KeyS") || keys.has("ArrowDown")) { cam.tx += c * pan; cam.ty += s * pan; }
    if (keys.has("KeyA") || keys.has("ArrowLeft")) { cam.tx += s * pan; cam.ty -= c * pan; }
    if (keys.has("KeyD") || keys.has("ArrowRight")) { cam.tx -= s * pan; cam.ty += c * pan; }
    if (state === "title") cam.yaw += dt * 0.06;
    const k = Math.min(1, dt * 7);
    cam.cyaw += (cam.yaw - cam.cyaw) * k; cam.cpitch += (cam.pitch - cam.cpitch) * k; cam.cdist += (cam.dist - cam.cdist) * k;
    cam.ctx += (cam.tx - cam.ctx) * k; cam.cty += (cam.ty - cam.cty) * k;
    spin += (handRot * Math.PI / 3 - spin) * Math.min(1, dt * 14);
    if (Math.abs(handRot * Math.PI / 3 - spin) > Math.PI) spin = handRot * Math.PI / 3;

    // tiles finishing their drop become part of the static scene
    for (const cell of board.values()) {
        if (cell.settled || time - cell.t0 < 0.5) continue;
        cell.settled = true; staticDirty = true;
        const [x, y] = hexCenter(cell.q, cell.r);
        for (let i = 0; i < 18; i++) { const a = i / 18 * 6.28; emit(x + Math.cos(a) * 0.9, y + Math.sin(a) * 0.9, 0.35, Math.cos(a) * 0.8, Math.sin(a) * 0.8, 0.4, 0.7, 0.14, [0.35, 0.33, 0.3]); }
    }

    // chimney smoke
    smokeTimer -= dt;
    if (smokeTimer <= 0) {
        smokeTimer = 0.12;
        for (const ch of chimneys) if (Math.random() < 0.25) emit(ch[0], ch[1], ch[2], 0.08 + Math.random() * 0.05, 0.05, 0.28, 2.6, 0.09, [0.22, 0.21, 0.21]);
    }
    updateParticles(dt);
}

function bounce(t) {                               // 0 → 1 drop with a little bounce
    if (t >= 1) return 0;
    const h = 1 - t;
    return t < 0.7 ? (1 - (t / 0.7) ** 2) * 2.2 : Math.sin((t - 0.7) / 0.3 * Math.PI) * 0.12 * h;
}

function buildDynamic() {
    dyn.reset(); glow.reset();
    // falling tiles
    for (const cell of board.values()) if (!cell.settled) buildTile(dyn, cell.tile, cell.q, cell.r, { lift: bounce((time - cell.t0) / 0.5) });

    if (state === "play" && hand) {
        // free spots: faint hex outlines
        for (const [, [q, r]] of freeSpots()) {
            const [x, y] = hexCenter(q, r);
            for (let i = 0; i < 6; i++) {
                const a = corner(i, 0.94), b = corner(i + 1, 0.94), a2 = corner(i, 0.86), b2 = corner(i + 1, 0.86);
                const col = [1, 1, 0.9];
                dyn.tri([x + a[0], y + a[1], 0.03], [x + b[0], y + b[1], 0.03], [x + b2[0], y + b2[1], 0.03], col, 7);
                dyn.tri([x + a[0], y + a[1], 0.03], [x + b2[0], y + b2[1], 0.03], [x + a2[0], y + a2[1], 0.03], col, 7);
            }
        }
        // the tile in hand, hovering over the spot under the cursor
        if (hover) {
            buildTile(dyn, hand, hover.q, hover.r, { ghost: true, spin, lift: 0.18 + Math.sin(time * 4) * 0.04 });
            const [x, y] = hexCenter(hover.q, hover.r);
            hover.ev.marks.forEach((m, i) => {
                if (!m) return;
                const a = (Math.PI / 3) * i, col = m === "match" ? [0.4, 1.3, 0.5] : m === "block" ? [1.6, 0.2, 0.2] : [1.2, 0.5, 0.2];
                glow.sprite(x + Math.cos(a) * 0.87, y + Math.sin(a) * 0.87, LAND_Z + 0.35, m === "match" ? 0.28 : 0.22, ...col);
            });
        }
    }

    // quest markers: a glowing beacon over the tile, coloured by terrain
    for (const qu of quests) {
        const c = board.get(qu.key);
        if (!c) continue;
        const [x, y] = hexCenter(c.q, c.r), col = hexToRgb(TYPE_COLORS[qu.type]), p = 0.8 + 0.2 * Math.sin(time * 3);
        for (let z = 0.6; z < 2.4; z += 0.25) glow.sprite(x, y, z, 0.18 * p, col[0] * 0.35, col[1] * 0.35, col[2] * 0.35);
        glow.sprite(x, y, 2.5 + Math.sin(time * 2) * 0.1, 0.45 * p, col[0] * 0.9, col[1] * 0.9, col[2] * 0.9);
    }

    // birds circling the island
    for (const b of birds) {
        const a = b.a + time * b.sp, x = Math.cos(a) * b.r, y = Math.sin(a) * b.r, z = b.z + Math.sin(time * 0.7 + b.ph) * 0.3;
        const dx = -Math.sin(a), dy = Math.cos(a), px = -dy, py = dx, flap = Math.sin(time * 9 + b.ph) * 0.12;
        const body = [x, y, z], tail = [x - dx * 0.12, y - dy * 0.12, z];
        const col = [0.18, 0.16, 0.2];
        dyn.tri(body, tail, [x + px * 0.28, y + py * 0.28, z + flap], col, 0);
        dyn.tri(body, tail, [x - px * 0.28, y - py * 0.28, z + flap], col, 0);
    }

    // particles (smoke, dust, sparkles)
    const d = P.d;
    for (let i = 0; i < P.n; i++) {
        const o = i * 12, f = d[o + 6] / d[o + 7];
        glow.sprite(d[o], d[o + 1], d[o + 2], d[o + 8] * (1.6 - f * 0.6), d[o + 9] * f, d[o + 10] * f, d[o + 11] * f);
    }
    const solidN = dyn.n;
    dyn.append(glow);
    space.setDynamic(dyn.pos, dyn.col, dyn.n);
    return { solidN, glowN: glow.n };
}

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

function render() {
    if (staticDirty) buildStatic();
    const cx = cam.ctx + Math.cos(cam.cpitch) * Math.cos(cam.cyaw) * cam.cdist;
    const cy = cam.cty + Math.cos(cam.cpitch) * Math.sin(cam.cyaw) * cam.cdist;
    const cz = Math.sin(cam.cpitch) * cam.cdist;
    space.lookAt(cx, cy, cz, cam.ctx, cam.cty, 0.2);
    const { solidN, glowN } = buildDynamic();

    gl.uniform1f(U.aspect, canvas.width / canvas.height);
    gl.uniform3f(U.veriables, space.zShifter, space.magnifier, 0);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, time);
    gl.uniform3fv(U.uSun, SUN);
    gl.uniform1f(U.uGhost, 0.5 + 0.5 * Math.sin(time * 5));
    gl.uniform3fv(U.uGhostTint, hover && !hover.ev.ok ? [1.0, 0.25, 0.2] : [1.0, 0.95, 0.8]);
    space.applyCamera();

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    space.bind(false);
    space.draw(0, ranges.sky);
    space.draw(ranges.opaque[0], ranges.opaque[1]);          // sea + settled tiles
    space.bind(true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);      // ghost / outlines are translucent
    space.draw(0, solidN);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    space.draw(solidN, glowN);                                // glows
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    ui.follow();
}

// ------------------------------------------------------------------ UI

const $ = (id) => document.getElementById(id);
const project = (x, y, z) => {
    const X = space.xUnitVec, Y = space.yUnitVec, Z = space.zUnitVec;
    const dx = x - space.Xc, dy = y - space.Yc, dz = z - space.Zc, zp = dx * Z[0] + dy * Z[1] + dz * Z[2];
    if (zp < 0.1) return null;
    const k = space.magnifier / 1.6 / zp;
    return [(-(dx * X[0] + dy * X[1] + dz * X[2]) * k + 1) / 2 * innerWidth, (1 - (dx * Y[0] + dy * Y[1] + dz * Y[2]) * k * (canvas.width / canvas.height)) / 2 * innerHeight];
};

function popup(x, y, z, text, kind) {
    const p = project(x, y, z);
    if (!p) return;
    const el = document.createElement("div");
    el.className = `pop ${kind}`; el.textContent = text;
    el.style.left = p[0] + "px"; el.style.top = p[1] + "px";
    $("popups").appendChild(el);
    setTimeout(() => el.remove(), 1600);
}
let toastT = 0;
function toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 1600); }

// the tile in hand drawn as a little hex diagram
function tileSVG(tile, size = 64) {
    const pts = (s) => [0, 1, 2, 3, 4, 5].map((i) => corner(i, s)).map(([x, y]) => [x * size * 0.46 + size / 2, -y * size * 0.46 + size / 2]);
    const O = pts(1), H = pts(0.3);
    let s = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`;
    for (let i = 0; i < 6; i++) {
        const j = (i + 1) % 6;
        s += `<polygon points="${[H[i], O[i], O[j], H[j]].map((p) => p.join(",")).join(" ")}" fill="${TYPE_COLORS[tile.edges[i]]}" stroke="#1d2a1d" stroke-width="0.6"/>`;
    }
    s += `<polygon points="${H.map((p) => p.join(",")).join(" ")}" fill="${TYPE_COLORS[hubType(tile.edges)]}" stroke="#1d2a1d" stroke-width="0.6"/></svg>`;
    return s;
}

const ui = {
    show(which) { for (const id of ["title", "hud", "over"]) $(id).classList.toggle("hidden", id !== which); if (which === "hud") this.hud(); },
    hud() {
        $("score").textContent = score.toLocaleString();
        $("left").textContent = stack.length + (hand ? 1 : 0);
        $("left").parentElement.classList.toggle("low", stack.length < 4);
        $("hand").innerHTML = hand ? tileSVG(rotated(hand, handRot), 92) : "";
        $("next").innerHTML = stack.length ? tileSVG(stack[stack.length - 1], 44) : "";
        $("bestv").textContent = Math.max(best, score).toLocaleString();
        $("quests").innerHTML = quests.map((q) => {
            const size = regionSize(board, q.key, q.sector);
            return `<div class="quest"><i style="background:${TYPE_COLORS[q.type]}"></i><span>${TYPE_NAMES[q.type]}</span><b>${Math.min(size, q.target)} / ${q.target}</b>` +
                `<div class="qbar"><em style="width:${Math.min(100, size / q.target * 100)}%;background:${TYPE_COLORS[q.type]}"></em></div></div>`;
        }).join("") || `<div class="qhint">Quests appear on tiles now and then — grow that area to earn tiles.</div>`;
    },
    // quest labels floating over their tiles
    follow() {
        const layer = $("labels");
        if (state !== "play") { layer.innerHTML = ""; return; }
        while (layer.children.length < quests.length) layer.appendChild(document.createElement("div"));
        while (layer.children.length > quests.length) layer.lastChild.remove();
        quests.forEach((q, i) => {
            const c = board.get(q.key), el = layer.children[i];
            const p = c && project(...hexCenter(c.q, c.r), 2.9);
            if (!p) { el.style.display = "none"; return; }
            el.style.display = "block";
            el.className = "qlabel";
            el.style.borderColor = TYPE_COLORS[q.type];
            el.style.transform = `translate(${p[0]}px, ${p[1]}px) translate(-50%, -100%)`;
            el.textContent = `${TYPE_NAMES[q.type]} ${Math.min(regionSize(board, q.key, q.sector), q.target)}/${q.target}`;
        });
    },
    over(newBest) {
        this.show("over");
        $("o-score").textContent = score.toLocaleString();
        $("o-best").textContent = newBest ? "New best!" : `Best ${best.toLocaleString()}`;
        $("o-best").classList.toggle("nb", newBest);
        $("o-stats").innerHTML = `<div><b>${placed}</b><span>tiles placed</span></div><div><b>${perfects}</b><span>perfect fits</span></div><div><b>${questsDone}</b><span>quests done</span></div>`;
    },
};

$("title").addEventListener("click", () => { audio.init(); newGame(); });
$("again").addEventListener("click", () => newGame());
$("rotL").addEventListener("click", (e) => { e.stopPropagation(); rotateHand(-1); });
$("rotR").addEventListener("click", (e) => { e.stopPropagation(); rotateHand(1); });
$("t-best").textContent = best.toLocaleString();

// ------------------------------------------------------------------ loop

demoIsland();
ui.show("title");

// ?autoplay: starts a game that places tiles by itself (best fit), for demos and testing
if (new URLSearchParams(location.search).has("autoplay")) {
    newGame();
    const tick = setInterval(() => {
        if (state !== "play" || !hand) { clearInterval(tick); return; }
        let pick = null;
        for (const [, [q, r]] of freeSpots()) for (let s = 0; s < 6; s++) {
            const e = evaluate(q, r, rotated(hand, s));
            const sc = e.ok ? e.match * 3 + e.n - Math.hypot(...hexCenter(q, r)) * 0.2 : -1e9;
            if (!pick || sc > pick.sc) pick = { q, r, s, sc };
        }
        if (pick && pick.sc > -1e9) { handRot = pick.s; place(pick.q, pick.r); }
    }, 350);
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
