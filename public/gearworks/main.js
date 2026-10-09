// GEARWORKS — a steam-powered pinball machine, rendered with the projection3d library (Space).
//
// Flip with Z / ← and / / →, hold and release Space (or ↓) to pull the plunger. Gear bumpers build boiler
// pressure (full pressure = STEAM BLAST, double scoring). Roll over the three top lanes to raise the bonus
// multiplier, knock down the three valve targets to light the lock, then sink two balls in the furnace for
// OVERDRIVE multiball and furnace jackpots. Loop the left orbit for combos.
//
// Rendering: cabinet, playfield, rails, posts, slingshots and backboard live in Space's buffers (built once).
// Flippers, spinning gears, targets, inserts, balls, shadows, steam and sparks are rebuilt every frame into
// GameSpace's dynamic buffers.

import GameSpace from "./GameSpace.js";
import { createProgram } from "./shaders.js";
import { Audio } from "./audio.js";
import { buildTable, stepPhysics, flipperTip, BALL_R, PLUNGER, ARC } from "./table.js";

const params = new URLSearchParams(location.search);
const SPEED = Math.max(1, Math.min(8, +params.get("speed") || 1));    // test/demo fast-forward

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
// vertical cylinder / cone (axis z)
function tube(m, cx, cy, n, r0, z0, r1, z1, col, mat = 0, cap = true, rot = 0) {
    for (let i = 0; i < n; i++) {
        const a0 = rot + (i / n) * 6.2832, a1 = rot + ((i + 1) / n) * 6.2832;
        const p = (r, a, z) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r, z];
        if (r1 === 0) m.tri(p(r0, a0, z0), p(r0, a1, z0), [cx, cy, z1], col, mat);
        else m.quad(p(r0, a0, z0), p(r0, a1, z0), p(r1, a1, z1), p(r1, a0, z1), col, mat);
        if (cap && r1 > 0) m.tri([cx, cy, z1], p(r1, a0, z1), p(r1, a1, z1), col, mat);
    }
}
// a box between two points on the table (a wall / rail), thickness t, from z0 to z1
function wall(m, ax, ay, bx, by, t, z0, z1, col, mat = 0, topCol = null, topMat = mat) {
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1, nx = -dy / L * t / 2, ny = dx / L * t / 2;
    const P = [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]];
    for (let i = 0; i < 4; i++) { const a = P[i], b = P[(i + 1) % 4]; m.quad([...a, z0], [...b, z0], [...b, z1], [...a, z1], col, mat); }
    m.quad([...P[0], z1], [...P[1], z1], [...P[2], z1], [...P[3], z1], topCol || col, topMat);
}
// a gear: outline in its own (u, v) plane, extruded by `depth`; map(u, v, h) places it in the world
function gear(m, map, rIn, rOut, teeth, rot, depth, col, mat = 0, hole = 0, sideCol = col) {
    const pts = [];
    for (let i = 0; i < teeth; i++) {
        const a = rot + (i / teeth) * 6.2832, w = 6.2832 / teeth;
        pts.push([a, rIn], [a + w * 0.12, rOut], [a + w * 0.45, rOut], [a + w * 0.57, rIn]);
    }
    const P = pts.map(([a, r]) => [Math.cos(a) * r, Math.sin(a) * r]);
    const n = P.length;
    for (let i = 0; i < n; i++) {
        const a = P[i], b = P[(i + 1) % n];
        m.quad(map(a[0], a[1], 0), map(b[0], b[1], 0), map(b[0], b[1], depth), map(a[0], a[1], depth), sideCol, mat);
        if (hole > 0) {
            const ha = pts[i][0], hb = pts[(i + 1) % n][0];
            const A = [Math.cos(ha) * hole, Math.sin(ha) * hole], B = [Math.cos(hb) * hole, Math.sin(hb) * hole];
            m.quad(map(A[0], A[1], depth), map(B[0], B[1], depth), map(b[0], b[1], depth), map(a[0], a[1], depth), col, mat);
        } else m.tri(map(0, 0, depth), map(a[0], a[1], depth), map(b[0], b[1], depth), col, mat);
    }
    // spokes for the big ones
    if (hole > 0) for (let k = 0; k < 4; k++) {
        const a = rot + k * Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a), w = rIn * 0.09;
        const q = (r, s) => [ca * r - sa * s, sa * r + ca * s];
        const A = q(-hole, -w), B = q(hole, -w), C = q(hole, w), D = q(-hole, w);
        m.quad(map(...A, depth * 0.8), map(...B, depth * 0.8), map(...C, depth * 0.8), map(...D, depth * 0.8), col, mat);
    }
}
const flatMap = (cx, cy, z0) => (u, v, h) => [cx + u, cy + v, z0 + h];
const backMap = (cx, y0, cz) => (u, v, h) => [cx + u, y0 - h, cz + v];

// ------------------------------------------------------------------ colours

const BRASS = [0.95, 0.68, 0.32], COPPER = [0.95, 0.5, 0.32], CHROME = [0.8, 0.8, 0.85], DARKBRASS = [0.5, 0.34, 0.15];
const LACQUER = [0.2, 0.085, 0.04], RUBBER = [0.09, 0.07, 0.06], RED = [0.55, 0.07, 0.04], IVORY = [0.92, 0.86, 0.72];

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
const T = buildTable();
const LANE_X = T.lanes.map((l) => (l.x0 + l.x1) / 2);

// ------------------------------------------------------------------ static scene

const stat = new Mesh(120000);
function buildStatic() {
    const m = stat;
    m.quad([-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], [0, 0, 0], 3);
    // playfield, in strips (keeps the interpolation precise)
    for (let y = -1.5; y < 20; y += 1.5) m.quad([-4.3, y, 0], [5.0, y, 0], [5.0, Math.min(20, y + 1.5), 0], [-4.3, Math.min(20, y + 1.5), 0], [1, 1, 1], 1);
    // cabinet sides and the front, with brass trim
    wall(m, -4.75, -2.2, -4.75, 20.6, 0.9, 0, 1.1, LACQUER, 7);
    wall(m, 5.45, -2.2, 5.45, 20.6, 0.9, 0, 1.1, LACQUER, 7);
    wall(m, -5.2, -1.85, 5.9, -1.85, 0.7, 0, 1.1, LACQUER, 7);
    for (const x of [-4.36, 5.06]) wall(m, x, -1.5, x, 20.0, 0.1, 1.1, 1.16, BRASS, 0);         // brass trim along the glass edge
    wall(m, -4.36, -1.54, 5.06, -1.54, 0.1, 1.1, 1.16, BRASS, 0);
    // the apron: a brass plate over the drain
    m.quad([-4.3, -1.5, 0.32], [5.0, -1.5, 0.32], [5.0, 0.75, 0.32], [-4.3, 0.75, 0.32], DARKBRASS, 0);
    m.quad([-4.3, 0.75, 0.32], [4.3, 0.75, 0.32], [4.3, 1.05, 0.05], [-4.3, 1.05, 0.05], BRASS, 0);
    for (let i = 0; i < 9; i++) tube(m, -3.6 + i * 0.9, -0.55, 8, 0.12, 0.32, 0.1, 0.38, COPPER, 0);      // rivets
    // backboard
    wall(m, -5.2, 20.3, 5.9, 20.3, 0.6, 0, 6.5, LACQUER, 7, BRASS, 0);
    for (const x of [-5.0, 5.7]) wall(m, x, 19.95, x, 19.96, 0.25, 0, 6.5, BRASS, 0);
    wall(m, -5.0, 19.95, 5.7, 19.95, 0.14, 6.25, 6.45, BRASS, 0);
    wall(m, -5.0, 19.95, 5.7, 19.95, 0.14, 1.1, 1.25, BRASS, 0);
    // copper pipes along the backboard with valves
    for (const z of [1.6, 5.8]) {
        for (let i = 0; i < 12; i++) {
            const x0 = -4.9 + i * 0.88, x1 = x0 + 0.88;
            const r = 0.11, a = (k) => (k / 6) * 6.2832;
            for (let k = 0; k < 6; k++) m.quad([x0, 19.85 + Math.cos(a(k)) * r, z + Math.sin(a(k)) * r], [x1, 19.85 + Math.cos(a(k)) * r, z + Math.sin(a(k)) * r], [x1, 19.85 + Math.cos(a(k + 1)) * r, z + Math.sin(a(k + 1)) * r], [x0, 19.85 + Math.cos(a(k + 1)) * r, z + Math.sin(a(k + 1)) * r], COPPER, 0);
        }
    }
    // rails (every wall the ball can touch), slings, posts
    for (const w of T.walls) {
        if (w.kind === "rail") wall(m, w.ax, w.ay, w.bx, w.by, 0.1, 0, 0.5, BRASS, 0);
        else if (w.kind === "post") { tube(m, w.ax, w.ay, 10, 0.1, 0, 0.1, 0.55, COPPER, 0); tube(m, w.bx, w.by, 10, 0.1, 0, 0.1, 0.55, COPPER, 0); wall(m, w.ax, w.ay, w.bx, w.by, 0.12, 0.1, 0.35, RUBBER, 7); }
        else if (w.kind === "plunger" || w.kind === "gate") { }
        else if (w.kind === "rubber") wall(m, w.ax, w.ay, w.bx, w.by, 0.1, 0.05, 0.4, RUBBER, 7);
    }
    for (const s of T.slings) {
        const [A, B, C] = [s.A, s.B, s.C], cen = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3];
        const sh = (p, k) => [cen[0] + (p[0] - cen[0]) * k, cen[1] + (p[1] - cen[1]) * k];
        const a = sh(A, 0.8), b = sh(B, 0.8), c = sh(C, 0.8);
        m.tri([...a, 0.45], [...b, 0.45], [...c, 0.45], RED, 7);
        for (const [p, q] of [[a, b], [b, c], [c, a]]) m.quad([...p, 0], [...q, 0], [...q, 0.45], [...p, 0.45], RED, 7);
        for (const p of [A, B, C]) tube(m, p[0], p[1], 10, 0.09, 0, 0.09, 0.5, COPPER, 0);
        wall(m, ...A, ...B, 0.1, 0.05, 0.4, RUBBER, 7);
        wall(m, ...B, ...C, 0.1, 0.05, 0.4, RUBBER, 7);
    }
    // shooter-lane gate (a thin brass flap) and the plunger housing
    wall(m, 4.3, 13.2, 5.0, 13.95, 0.04, 0.3, 0.5, BRASS, 0);
    wall(m, 4.3, -1.5, 5.0, -1.5, 0.3, 0, 0.6, DARKBRASS, 0);
    // saucer (the furnace): a dark hole with a brass ring and a grate
    const S = T.saucer;
    tube(m, S.x, S.y, 20, 0.42, 0.001, 0.42, 0.002, [0.01, 0.005, 0.0], 7);
    tube(m, S.x, S.y, 20, 0.5, 0, 0.44, 0.08, BRASS, 0, false);
    for (let k = -2; k <= 2; k++) wall(m, S.x + k * 0.13, S.y - 0.3, S.x + k * 0.13, S.y + 0.3, 0.03, 0.002, 0.02, DARKBRASS, 0);
    wall(m, S.x - 0.5, S.y + 0.45, S.x + 0.5, S.y + 0.45, 0.08, 0, 0.6, BRASS, 0);                       // back hood
    // drop-target bank housing
    // lane guide caps glow tubes (decorative vacuum tubes on the backboard)
    for (let i = 0; i < 6; i++) {
        const x = -3.4 + i * 1.36;
        tube(m, x, 19.6, 10, 0.2, 1.25, 0.2, 1.4, DARKBRASS, 0);
    }
    space.setStatic(m.pos, m.col, m.n);
    stat.count = m.n;
}
buildStatic();

// ------------------------------------------------------------------ game state

const save = (() => { try { return Object.assign({ best: 0 }, JSON.parse(localStorage.getItem("gearworks.save")) || {}); } catch { return { best: 0 }; } })();
const persist = () => { try { localStorage.setItem("gearworks.save", JSON.stringify(save)); } catch { } };

let state = "title";
let G = null;
let balls = [];
let camY = 9, frameDt = 0.016;
let time = 0, shake = 0, gearSpin = 0, gearSpeed = 0.4;
let sparks = [], steam = [];
let plungerHeld = false, charge = 0;
const keys = { left: false, right: false };

function newGame() {
    G = {
        score: 0, ball: 1, mult: 1, lanes: [false, false, false], skillLane: -1, skillLive: false,
        lockLit: false, locks: 0, multiball: false, jackpot: 1, pressure: 0, blast: 0, ballSave: 0, saveArmed: true,
        combo: 0, comboT: 0, counts: { bump: 0, tgt: 0, lane: 0, orbit: 0 }, extraQueue: 0, extraT: 0, overT: 0,
    };
    T.targets.forEach((t) => (t.down = false));
    balls = [];
    serveBall();
}
function serveBall() {
    balls.push({ x: PLUNGER.x, y: PLUNGER.y, vx: 0, vy: 0, held: false, sOrbit: false });
    G.skillLane = Math.floor(Math.random() * 3); G.skillLive = true; G.saveArmed = true;
    G.mult = 1; G.lanes = [false, false, false];
    G.counts = { bump: 0, tgt: 0, lane: 0, orbit: 0 };
    ui.hud();
}
const inShooter = (b) => b.x > 4.3 && b.y < 13.2;
const plungerBall = () => balls.find((b) => inShooter(b) && b.y < 1.2 && Math.abs(b.vy) < 0.5);

function add(points, x, y) {
    const p = points * (G.blast > 0 ? 2 : 1);
    G.score += p;
    if (x !== undefined) popup(p, x, y);
    ui.hud();
}
function launch(b, power) {
    b.vy = 24.5 + 12 * power; b.vx = 0;
    audio.plunge(power);
    for (let i = 0; i < 14; i++) steam.push(puff(b.x, b.y - 0.5, 0.3, 1.5));
}
function autoLaunch(b) { b.x = PLUNGER.x; b.y = PLUNGER.y; b.vx = 0; b.vy = 0; setTimeout(() => { if (balls.includes(b)) launch(b, 0.75 + Math.random() * 0.25); }, 500 / SPEED); }

// ------------------------------------------------------------------ input

function setFlipper(side, on) {
    const f = T.flippers[side === "left" ? 0 : 1];
    if (on && !f.pressed && state === "play") {
        audio.flipper();
        if (!G.lanes.every(Boolean)) {                     // lane change: lit lanes rotate with the flippers
            const l = G.lanes;
            G.lanes = side === "left" ? [l[1], l[2], l[0]] : [l[2], l[0], l[1]];
        }
    }
    f.pressed = on && state === "play";
}
function plunger(on) {
    if (on) { plungerHeld = true; return; }
    if (plungerHeld) {
        plungerHeld = false;
        const b = plungerBall();
        if (b && state === "play") launch(b, charge);
        charge = 0;
    }
}
const LEFT_KEYS = ["KeyZ", "ShiftLeft", "ArrowLeft", "KeyA"], RIGHT_KEYS = ["Slash", "ShiftRight", "ArrowRight", "KeyL", "KeyD"], PLUNGE_KEYS = ["Space", "ArrowDown", "Enter", "KeyS"];
addEventListener("keydown", (e) => {
    audio.init();
    if (e.repeat) return;
    if (e.code === "KeyM") { ui.toast(audio.toggleMute() ? "Sound off" : "Sound on"); return; }
    if (state !== "play") { if (e.code === "Space" || e.code === "Enter") start(); return; }
    if (LEFT_KEYS.includes(e.code)) setFlipper("left", true);
    if (RIGHT_KEYS.includes(e.code)) setFlipper("right", true);
    if (PLUNGE_KEYS.includes(e.code)) { e.preventDefault(); plunger(true); }
});
addEventListener("keyup", (e) => {
    if (LEFT_KEYS.includes(e.code)) setFlipper("left", false);
    if (RIGHT_KEYS.includes(e.code)) setFlipper("right", false);
    if (PLUNGE_KEYS.includes(e.code)) plunger(false);
});
const touches = new Map();
canvas.addEventListener("pointerdown", (e) => {
    audio.init();
    if (state !== "play") { start(); return; }
    const right = e.clientX > innerWidth / 2;
    let role = right ? "right" : "left";
    if (right && plungerBall() && !balls.some((b) => !inShooter(b))) role = "plunger";
    touches.set(e.pointerId, role);
    if (role === "plunger") plunger(true); else setFlipper(role, true);
});
const release = (e) => {
    const role = touches.get(e.pointerId);
    if (!role) return;
    touches.delete(e.pointerId);
    if (role === "plunger") plunger(false); else setFlipper(role, false);
};
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);
addEventListener("blur", () => { setFlipper("left", false); setFlipper("right", false); });

function start() {
    if (state === "over" && G && G.overT < 1.2) return;
    T.flippers.forEach((f) => (f.pressed = false));
    state = "play"; newGame(); ui.show("hud");
}

// ------------------------------------------------------------------ effects

const puff = (x, y, z, s = 1) => ({ x, y, z, vx: (Math.random() - 0.5) * 0.6 * s, vy: (Math.random() - 0.5) * 0.6 * s, vz: 0.6 + Math.random() * 0.8 * s, life: 1, max: 0.9 + Math.random() * 0.8, size: 0.25 + Math.random() * 0.2 });
function burst(x, y, z, n, col, speed = 4) {
    for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.28, s = speed * (0.3 + Math.random());
        sparks.push({ x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: 1 + Math.random() * 4, life: 0.5 + Math.random() * 0.5, col });
    }
}
const popups = document.getElementById("popups");
function popup(points, x, y) {
    const [sx, sy] = toScreen(x, y, 0.8);
    const el = document.createElement("div");
    el.className = "pop"; el.textContent = points.toLocaleString();
    el.style.left = sx + "px"; el.style.top = sy + "px";
    popups.appendChild(el);
    setTimeout(() => el.remove(), 900);
}
function toScreen(x, y, z) {
    const v = [x - space.Xc, y - space.Yc, z - space.Zc], X = space.xUnitVec, Y = space.yUnitVec, Z = space.zUnitVec;
    const xp = -(v[0] * X[0] + v[1] * X[1] + v[2] * X[2]), yp = v[0] * Y[0] + v[1] * Y[1] + v[2] * Y[2], zp = v[0] * Z[0] + v[1] * Z[1] + v[2] * Z[2];
    const k = space.magnifier / 1.6, aspect = canvas.width / canvas.height;
    return [(xp * k / zp * 0.5 + 0.5) * innerWidth, (0.5 - yp * k * aspect / zp * 0.5) * innerHeight];
}

// ------------------------------------------------------------------ rules

function handleEvents(events) {
    let railV = 0;
    for (const e of events) {
        switch (e.type) {
            case "bumper": {
                const c = e.c, i = T.bumpers.indexOf(c);
                if (c.flash < 0.6) { audio.bumper(i); add(1000, c.x, c.y); G.counts.bump++; pressure(3); }
                c.flash = 1; c.spin += 0.6; shake = Math.max(shake, 0.05);
                burst(c.x, c.y, 0.5, 10, [1.0, 0.6, 0.2]);
                for (let k = 0; k < 4; k++) steam.push(puff(c.x, c.y, 0.6, 1));
                break;
            }
            case "sling": {
                const s = T.slings.find((q) => q.seg === e.w);
                if (s.flash < 0.5) { audio.sling(); add(100); pressure(1); }
                s.flash = 1;
                break;
            }
            case "target": {
                if (!e.t.down) {
                    e.t.down = true; e.t.flash = 1; audio.target(); add(5000, 3.4, 8.7); G.counts.tgt++;
                    burst(3.45, (e.t.seg.ay + e.t.seg.by) / 2, 0.3, 12, [0.5, 1.0, 0.6]);
                    if (T.targets.every((t) => t.down)) {
                        if (!G.lockLit && !G.multiball) { G.lockLit = true; banner("LOCK IS LIT", "shoot the furnace"); audio.fanfare(false); }
                        else add(50000, 3.2, 8.7);
                        add(25000);
                        setTimeout(() => { if (!G.lockLit || G.multiball) T.targets.forEach((t) => (t.down = false)); }, 1500 / SPEED);
                    }
                }
                break;
            }
            case "rail": case "rubber": case "post": railV = Math.max(railV, e.v); break;
            case "clack": audio.rail(e.v * 2); break;
        }
    }
    if (railV) audio.rail(railV);
}
function pressure(n) {
    if (G.blast > 0) return;
    G.pressure = Math.min(100, G.pressure + n);
    if (G.pressure >= 100) {
        G.blast = 20; G.pressure = 0;
        banner("STEAM BLAST", "all scores doubled", "blast");
        audio.fanfare(true); shake = 0.25;
        for (const c of T.bumpers) for (let k = 0; k < 14; k++) steam.push(puff(c.x, c.y, 0.6, 2));
    }
    ui.hud();
}
function sensors(dt) {
    for (const b of balls) {
        if (b.held) continue;
        const py = b.py ?? b.y;
        // top lanes: crossing downward
        for (let i = 0; i < 3; i++) {
            const L = T.lanes[i];
            if (b.x > L.x0 && b.x < L.x1 && py >= L.y && b.y < L.y) {
                audio.lane(i);
                if (G.skillLive && i === G.skillLane) { add(100000, LANE_X[i], 17); banner("SKILL SHOT", "100,000"); audio.fanfare(false); }
                G.skillLive = false;
                if (!G.lanes[i]) { G.lanes[i] = true; add(2500, LANE_X[i], 17); G.counts.lane++; }
                else add(500);
                if (G.lanes.every(Boolean)) {
                    G.mult = Math.min(5, G.mult + 1); add(25000);
                    banner(`BONUS ×${G.mult}`, "lanes complete"); audio.fanfare(false);
                    setTimeout(() => { if (G) G.lanes = [false, false, false]; }, 900 / SPEED);
                }
            }
        }
        // orbit: shooting up the left lane
        const O = T.orbit;
        if (b.x > O.x0 && b.x < O.x1 && py < O.y && b.y >= O.y && b.vy > 4) {
            G.combo = G.comboT > 0 ? G.combo + 1 : 1; G.comboT = 5;
            add(15000 * G.combo, -3.9, 10); G.counts.orbit++; pressure(8);
            if (G.combo > 1) banner(`${G.combo}× COMBO`, "orbit"); else ui.toast("ORBIT");
            audio.lane(G.combo);
        }
        // anything leaving the shooter lane arms ball save and skill shot timing
        if (G.saveArmed && b.y > 13.5 && b.x > 3.5) { G.saveArmed = false; G.ballSave = Math.max(G.ballSave, 8); }
        // the furnace
        const S = T.saucer;
        if (!S.ball && Math.hypot(b.x - S.x, b.y - S.y) < S.r && Math.hypot(b.vx, b.vy) < 16) {
            S.ball = b; b.held = true; b.x = S.x; b.y = S.y; b.vx = b.vy = 0;
            audio.saucer(); shake = Math.max(shake, 0.1);
            for (let k = 0; k < 16; k++) steam.push(puff(S.x, S.y, 0.3, 1.5));
            if (G.multiball) {
                const j = 250000 * G.jackpot; add(j, S.x, S.y); banner("JACKPOT", j.toLocaleString(), "jackpot"); G.jackpot++; audio.fanfare(true);
                S.hold = 0.8;
            } else if (G.lockLit) {
                G.locks++; G.lockLit = false; T.targets.forEach((t) => (t.down = false));
                add(50000, S.x, S.y);
                if (G.locks >= 2) { startMultiball(); S.hold = 1.0; }
                else {
                    banner("BALL LOCKED", "knock down the valves again"); audio.fanfare(false);
                    balls.splice(balls.indexOf(b), 1); S.ball = null;               // the locked ball stays in the furnace
                    const nb = { x: PLUNGER.x, y: PLUNGER.y, vx: 0, vy: 0, held: false };
                    balls.push(nb); autoLaunch(nb);
                }
            } else { add(10000, S.x, S.y); pressure(12); S.hold = 1.2; }
        }
        b.py = b.y;
    }
    const S = T.saucer;
    if (S.ball) {
        S.hold -= dt;
        if (S.hold <= 0) {
            const b = S.ball; S.ball = null; b.held = false;
            b.x = S.x + 0.1; b.y = S.y - 0.45; b.vx = 4 + Math.random() * 2; b.vy = -5 - Math.random() * 2;
            for (let k = 0; k < 10; k++) steam.push(puff(S.x, S.y, 0.4, 2));
            audio.plunge(0.4);
        }
    }
}
function startMultiball() {
    G.multiball = true; G.locks = 0; G.jackpot = 1; G.ballSave = 10;
    banner("OVERDRIVE", "multiball!", "blast");
    audio.fanfare(true); audio.intensity = 1; shake = 0.35;
    for (let k = 0; k < 2; k++) setTimeout(() => {
        if (!G || !G.multiball) return;
        const nb = { x: PLUNGER.x, y: PLUNGER.y, vx: 0, vy: 0, held: false };
        balls.push(nb); autoLaunch(nb);
    }, (300 + k * 1300) / SPEED);
}
function drains() {
    for (const b of [...balls]) {
        if (b.y > -0.9) continue;
        balls.splice(balls.indexOf(b), 1);
        if (G.ballSave > 0) {
            const nb = { x: PLUNGER.x, y: PLUNGER.y, vx: 0, vy: 0, held: false };
            balls.push(nb); autoLaunch(nb);
            if (!G.multiball) banner("BALL SAVED", "", "save");
            continue;
        }
        if (G.multiball && balls.length <= 1) { G.multiball = false; audio.intensity = G.blast > 0 ? 1 : 0; ui.toast("Multiball over"); }
        if (balls.length === 0) endOfBall();
    }
}
function endOfBall() {
    const c = G.counts, bonus = (c.bump * 250 + c.tgt * 1000 + c.lane * 500 + c.orbit * 3000 + 5000) * G.mult;
    G.score += bonus;
    audio.drain();
    G.ballSave = 0; G.blast = 0; audio.intensity = 0;
    if (G.ball >= 3) {
        state = "over"; G.overT = 0;
        const best = G.score > save.best;
        if (best) { save.best = G.score; persist(); }
        ui.over(bonus, best);
        return;
    }
    G.ball++;
    banner(`BONUS ${bonus.toLocaleString()}`, G.mult > 1 ? `×${G.mult} multiplier` : `ball ${G.ball}`);
    setTimeout(() => { if (state === "play") serveBall(); }, 1400 / SPEED);
    ui.hud();
}

// ------------------------------------------------------------------ update

function update(dt) {
    time += dt;
    if (state === "title") {                                // attract mode: flippers twitch, gears turn
        T.flippers[0].pressed = Math.sin(time * 1.7) > 0.93;
        T.flippers[1].pressed = Math.sin(time * 1.3 + 2) > 0.93;
        for (const b of balls) if (b.y < -0.9) Object.assign(b, { x: -1 + Math.random() * 2, y: 18.4, vx: (Math.random() - 0.5) * 6, vy: 0 });
    }
    if (plungerHeld) charge = Math.min(1, charge + dt * 1.3);
    const events = [];
    if (state === "play" || state === "title") stepPhysics(T, balls, dt, events);
    if (state === "play") {
        handleEvents(events);
        sensors(dt);
        drains();
        if (G.ballSave > 0) G.ballSave -= dt;
        if (G.comboT > 0) G.comboT -= dt;
        if (G.blast > 0) { G.blast -= dt; audio.intensity = 1; if (G.blast <= 0) { audio.intensity = G.multiball ? 1 : 0; ui.toast("Pressure released"); ui.hud(); } }
    }
    if (state === "over") G.overT += dt;
    for (const c of T.bumpers) { c.flash = Math.max(0, c.flash - dt * 3); c.spin += dt * (0.4 + c.flash * 6); }
    for (const s of T.slings) s.flash = Math.max(0, s.flash - dt * 5);
    // the machine's gears run faster when things are busy
    const busy = balls.reduce((a, b) => a + Math.hypot(b.vx, b.vy), 0);
    gearSpeed += (0.3 + Math.min(2.5, busy * 0.05) + (G && G.blast > 0 ? 2 : 0) - gearSpeed) * Math.min(1, dt * 2);
    gearSpin += gearSpeed * dt;
    shake = Math.max(0, shake - dt * 1.5);
    for (const s of sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt; s.vz -= 12 * dt; s.life -= dt; if (s.z < 0) { s.z = 0; s.vz *= -0.4; } }
    sparks = sparks.filter((s) => s.life > 0);
    for (const p of steam) { p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.life -= dt / p.max; p.size += dt * 0.5; }
    steam = steam.filter((p) => p.life > 0);
    if (Math.random() < dt * 3) steam.push({ ...puff(Math.random() < 0.5 ? -4.75 : 5.45, 19.6, 1.6, 0.5), size: 0.3 });   // the pipes leak a little
    if (steam.length > 400) steam.splice(0, steam.length - 400);
}

// ------------------------------------------------------------------ per-frame geometry

const solid = new Mesh(40000), glow = new Mesh(20000);
function disc(m, x, y, z, r, col, mat = 2, n = 16) { for (let i = 0; i < n; i++) { const a0 = (i / n) * 6.2832, a1 = ((i + 1) / n) * 6.2832; m.tri([x, y, z], [x + Math.cos(a0) * r, y + Math.sin(a0) * r, z], [x + Math.cos(a1) * r, y + Math.sin(a1) * r, z], col, mat); } }
function arrow(m, x, y, z, s, ang, col) {
    const c = Math.cos(ang), d = Math.sin(ang), P = (u, v) => [x + u * c - v * d, y + u * d + v * c, z];
    m.tri(P(s, 0), P(-s * 0.6, s * 0.7), P(-s * 0.3, 0), col, 2); m.tri(P(s, 0), P(-s * 0.3, 0), P(-s * 0.6, -s * 0.7), col, 2);
}
function insert(x, y, lit, col, shape = "disc", ang = 0, r = 0.22) {
    const k = lit ? 1.5 : 0.1, c = [col[0] * k, col[1] * k, col[2] * k];
    if (shape === "disc") { disc(solid, x, y, 0.004, r + 0.05, BRASS, 0, 14); disc(solid, x, y, 0.006, r, c, 2, 14); }
    else arrow(solid, x, y, 0.006, r * 1.6, ang, c);
    if (lit) glow.sprite(x, y, 0.15, r * 3, col[0] * 0.35, col[1] * 0.35, col[2] * 0.35);
}
function flipperMesh(f) {
    const [tx, ty] = flipperTip(f), a = f.angle, n = 8, pts = [];
    for (let i = 0; i <= n; i++) { const t = a + Math.PI / 2 + (i / n) * Math.PI; pts.push([f.px + Math.cos(t) * 0.22, f.py + Math.sin(t) * 0.22]); }
    for (let i = 0; i <= n; i++) { const t = a - Math.PI / 2 + (i / n) * Math.PI; pts.push([tx + Math.cos(t) * 0.12, ty + Math.sin(t) * 0.12]); }
    const cx = (f.px + tx) / 2, cy = (f.py + ty) / 2;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        solid.tri([cx, cy, 0.42], [...p, 0.42], [...q, 0.42], IVORY, 7);
        solid.quad([...p, 0.03], [...q, 0.03], [...q, 0.42], [...p, 0.42], i % 2 ? RED : [0.62, 0.09, 0.05], 7);
    }
    tube(solid, f.px, f.py, 10, 0.08, 0.42, 0.08, 0.5, BRASS, 0);
}
function buildDynamic() {
    solid.reset(); glow.reset();
    const blastK = G && G.blast > 0 ? 1 : 0;
    // inlaid clockwork under the lower playfield
    gear(solid, flatMap(0, 4.75, 0.003), 0.95, 1.1, 16, gearSpin * 0.35, 0.002, DARKBRASS, 0, 0.6);
    gear(solid, flatMap(1.47, 5.75), 0.42, 0.55, 8, -gearSpin * 0.7 + 0.2, 0.002, DARKBRASS, 0, 0.25);
    gear(solid, flatMap(-1.5, 5.6), 0.42, 0.55, 8, -gearSpin * 0.7, 0.002, DARKBRASS, 0, 0.25);
    // gear bumpers
    T.bumpers.forEach((c, i) => {
        tube(solid, c.x, c.y, 14, c.r, 0, c.r * 0.95, 0.28, [0.12, 0.06, 0.03], 7, false);
        gear(solid, flatMap(c.x, c.y, 0.28), c.r * 0.92, c.r * 1.12, 12, c.spin, 0.16, BRASS, 0, 0, DARKBRASS);
        const f = c.flash, warm = [1.0 + f * 1.5, 0.55 + f, 0.18 + f * 0.6];
        tube(solid, c.x, c.y, 12, c.r * 0.5, 0.44, 0, 0.72, warm, 2);
        glow.sprite(c.x, c.y, 0.6, 0.9 + f * 0.8, 0.25 + f * 0.6, 0.12 + f * 0.35, 0.03 + f * 0.1);
    });
    // slingshot flashes
    for (const s of T.slings) if (s.flash > 0) {
        const k = s.flash;
        wall(solid, ...s.A, ...s.C, 0.12, 0.05, 0.42, [1.5 * k + 0.1, 1.0 * k + 0.05, 0.4 * k], 2);
        glow.sprite((s.A[0] + s.C[0]) / 2, (s.A[1] + s.C[1]) / 2, 0.3, 1.0, 0.5 * k, 0.35 * k, 0.15 * k);
    }
    // drop targets (brass valve plates)
    for (const t of T.targets) {
        const s = t.seg, z = t.down ? -0.4 : 0;
        if (!t.down) wall(solid, s.ax + 0.05, s.ay + 0.04, s.bx + 0.05, s.by - 0.04, 0.1, z, z + 0.55, BRASS, 0, [0.35, 0.9, 0.5], 2);
    }
    for (const f of T.flippers) flipperMesh(f);
    // plunger rod
    const pull = charge * 0.9;
    wall(solid, PLUNGER.x, -1.4 - pull, PLUNGER.x, 0.3 - pull, 0.12, 0.12, 0.24, CHROME, 0);
    tube(solid, PLUNGER.x, -1.5 - pull, 10, 0.22, 0.05, 0.22, 0.32, RED, 7);

    if (G) {
        // inserts
        T.lanes.forEach((L, i) => insert(LANE_X[i], 17.75, G.lanes[i] || (state === "play" && G.skillLive && i === G.skillLane && Math.sin(time * 14) > 0), [1.0, 0.7, 0.25]));
        for (let i = 0; i < 4; i++) insert(-1.2 + i * 0.8, 6.7, G.mult >= i + 2, [1.0, 0.82, 0.35], "disc", 0, 0.2);
        T.targets.forEach((t, i) => insert(2.95, (t.seg.ay + t.seg.by) / 2, t.down, [0.4, 1.0, 0.55], "disc", 0, 0.15));
        insert(-2.05, 9.25, G.lockLit && Math.sin(time * 9) > -0.2, [1.0, 0.45, 0.1], "arrow", 2.2, 0.24);
        insert(-2.45, 11.05, G.multiball && Math.sin(time * 12) > 0, [1.0, 0.3, 0.8], "disc", 0, 0.16);
        insert(-3.87, 8.1, G.comboT > 0 ? Math.sin(time * 12) > 0 : Math.sin(time * 2) > 0.7, [0.35, 0.7, 1.0], "arrow", Math.PI / 2, 0.22);
        insert(0, 3.35, G.ballSave > 0 && (G.ballSave > 2 || Math.sin(time * 16) > 0), [1.0, 0.25, 0.15], "arrow", Math.PI / 2, 0.24);
        // pressure dial
        const segs = 24, lit = Math.round((G.blast > 0 ? 100 : G.pressure) / 100 * segs);
        for (let i = 0; i < segs; i++) {
            const a0 = Math.PI * 1.25 - (i / segs) * Math.PI * 1.5, a1 = a0 - Math.PI * 1.5 / segs * 0.75, on = i < lit;
            const col = i < segs * 0.6 ? [0.3, 1.0, 0.5] : i < segs * 0.85 ? [1.0, 0.8, 0.2] : [1.0, 0.25, 0.1];
            const k = on ? (G.blast > 0 ? 1 + Math.sin(time * 10 + i) * 0.5 : 1.4) : 0.08;
            const P = (a, r) => [0.1 + Math.cos(a) * r, 8.0 + Math.sin(a) * r, 0.006];
            solid.quad(P(a0, 0.95), P(a1, 0.95), P(a1, 1.18), P(a0, 1.18), [col[0] * k, col[1] * k, col[2] * k], 2);
        }
        const needle = Math.PI * 1.25 - ((G.blast > 0 ? 100 : G.pressure) / 100) * Math.PI * 1.5;
        const nc = Math.cos(needle), ns = Math.sin(needle);
        solid.tri([0.1 - ns * 0.05, 8.0 + nc * 0.05, 0.02], [0.1 + ns * 0.05, 8.0 - nc * 0.05, 0.02], [0.1 + nc * 0.9, 8.0 + ns * 0.9, 0.02], [1.6, 0.4, 0.15], 2);
        disc(solid, 0.1, 8.0, 0.025, 0.1, BRASS, 0, 10);
        // furnace glow
        const S = T.saucer, fk = 0.4 + (S.ball ? 1.2 : 0) + (G.lockLit ? 0.4 + Math.sin(time * 6) * 0.3 : 0);
        disc(solid, S.x, S.y, 0.003, 0.38, [1.2 * fk, 0.4 * fk, 0.05 * fk], 2, 16);
        glow.sprite(S.x, S.y, 0.2, 0.9, 0.35 * fk, 0.12 * fk, 0.02);
    }
    // backboard: big gears and glowing tubes
    gear(solid, backMap(-2.9, 19.98, 3.7), 1.5, 1.75, 18, gearSpin * 0.5, 0.18, BRASS, 0, 1.0, DARKBRASS);
    gear(solid, backMap(-0.1, 19.98, 4.35), 0.8, 0.98, 10, -gearSpin * 0.9 + 0.15, 0.2, COPPER, 0, 0.5, DARKBRASS);
    gear(solid, backMap(2.7, 19.98, 3.4), 1.25, 1.48, 15, gearSpin * 0.6, 0.18, BRASS, 0, 0.8, DARKBRASS);
    for (const [x, z, r] of [[-2.9, 3.7, 0.4], [-0.1, 4.35, 0.25], [2.7, 3.4, 0.35]]) {
        const k = 0.8 + blastK * 0.8 + Math.sin(time * 3 + x) * 0.1;
        for (let i = 0; i < 12; i++) {
            const a0 = (i / 12) * 6.2832, a1 = ((i + 1) / 12) * 6.2832;
            solid.tri([x, 19.75, z], [x + Math.cos(a0) * r, 19.75, z + Math.sin(a0) * r], [x + Math.cos(a1) * r, 19.75, z + Math.sin(a1) * r], [1.4 * k, 0.6 * k, 0.15 * k], 2);
        }
        glow.sprite(x, 19.6, z, r * 3, 0.3 * k, 0.12 * k, 0.03 * k);
    }
    for (let i = 0; i < 6; i++) {                                  // vacuum tubes; they flicker with the music
        const x = -3.4 + i * 1.36, k = 0.6 + 0.4 * Math.sin(time * 7 + i * 1.7) * Math.sin(time * 2.3 + i);
        tube(solid, x, 19.6, 8, 0.15, 1.4, 0.13, 2.1, [0.9 * k + 0.3, 0.45 * k + 0.1, 0.12], 2);
        glow.sprite(x, 19.5, 1.8, 0.7, 0.3 * k, 0.13 * k, 0.03);
    }
    // balls + shadows
    for (const b of balls) {
        if (b.y < -0.9) continue;
        const z = b.held ? -0.15 : BALL_R;
        solid.sprite(b.x, b.y, z, BALL_R, 1, 1, 1, 6);
        for (const [r, d] of [[BALL_R * 1.25, 0.78], [BALL_R * 0.85, 0.6]]) {
            const sx = b.x + 0.12, sy = b.y + 0.16, n = 12;
            for (let i = 0; i < n; i++) {
                const a0 = (i / n) * 6.2832, a1 = ((i + 1) / n) * 6.2832;
                solid.tri([sx, sy, 0.002 + (1 - d) * 0.002], [sx + Math.cos(a0) * r, sy + Math.sin(a0) * r, 0.002 + (1 - d) * 0.002], [sx + Math.cos(a1) * r, sy + Math.sin(a1) * r, 0.002 + (1 - d) * 0.002], [0, 0, 0], 4, d);
            }
        }
    }
    for (const s of sparks) { const k = s.life; glow.sprite(s.x, s.y, s.z, 0.06, s.col[0] * k, s.col[1] * k, s.col[2] * k); }
    for (const p of steam) { const k = Math.min(1, p.life * 1.5) * 0.09; glow.sprite(p.x, p.y, p.z, p.size, k, k * 0.95, k * 0.9); }
    const n = solid.n;
    solid.append(glow);
    space.setDynamic(solid.pos, solid.col, solid.n);
    return { sN: n, gN: glow.n };
}

const lightBuf = new Float32Array(32), lightCol = new Float32Array(24);
function render() {
    const aspect = canvas.width / canvas.height;
    space.magnifier = aspect < 0.62 ? 1.3 : aspect < 1 ? 1.6 : 2.0;
    // the camera drifts with the action: it leans towards the lowest live ball (that's the one to save)
    const live = balls.filter((b) => !b.held && b.y > -0.5);
    const focus = state === "play" && live.length ? Math.min(...live.map((b) => b.y)) : 9;
    camY += (Math.max(4.4, Math.min(12.5, focus + 1.5)) - camY) * Math.min(1, frameDt * 2.2);
    const sx = (Math.random() - 0.5) * shake, sy = (Math.random() - 0.5) * shake;
    const attract = state === "title" ? Math.sin(time * 0.25) * 1.2 : 0;
    space.lookAt(0.35 + sx + attract, camY - 15.5 + sy, 16.5, 0.35 + attract * 0.3, camY + 0.5, 0);
    const { sN, gN } = buildDynamic();
    // lights: three bumpers, two slings, the furnace, the pressure dial, the backboard
    const L = [];
    T.bumpers.forEach((c) => L.push([c.x, c.y, 1.0, 0.25 + c.flash * 2.2, 1.0, 0.6, 0.25]));
    T.slings.forEach((s) => L.push([(s.A[0] + s.C[0]) / 2, (s.A[1] + s.C[1]) / 2, 0.8, s.flash * 1.6, 1.0, 0.8, 0.5]));
    const S = T.saucer;
    L.push([S.x, S.y, 0.6, 0.3 + (S.ball ? 1.4 : 0) + (G && G.lockLit ? 0.5 : 0), 1.0, 0.4, 0.08]);
    const bl = G && G.blast > 0;
    L.push([0.1, 8.0, 1.2, bl ? 1.2 + Math.sin(time * 10) * 0.4 : G ? G.pressure / 120 : 0.1, bl ? 1.0 : 0.4, bl ? 0.5 : 1.0, bl ? 0.2 : 0.5]);
    L.push([0.3, 19.0, 3.0, 1.2 + (bl ? 1 : 0), 1.0, 0.55, 0.2]);
    L.forEach((l, i) => { lightBuf.set([l[0], l[1], l[2], l[3]], i * 4); lightCol.set([l[4], l[5], l[6]], i * 3); });

    gl.uniform1f(U.aspect, aspect);
    gl.uniform3f(U.veriables, space.zShifter, space.magnifier, 0);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, time);
    gl.uniform4fv(U.uLights, lightBuf);
    gl.uniform3fv(U.uLightCol, lightCol);
    gl.uniform1f(U.uBlast, bl ? Math.min(1, G.blast) : 0);
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
    show(which) { for (const id of ["title", "hud", "over"]) $(id).classList.toggle("hidden", id !== which); if (which === "hud") this.hud(); },
    hud() {
        if (!G) return;
        $("score").textContent = G.score.toLocaleString();
        $("ballno").textContent = G.ball;
        $("mult").textContent = "×" + G.mult;
        $("locks").innerHTML = [0, 1].map((i) => `<i class="${i < G.locks ? "on" : G.lockLit && i === G.locks ? "lit" : ""}"></i>`).join("");
        $("needle").style.transform = `rotate(${-135 + (G.blast > 0 ? 100 : G.pressure) * 2.7}deg)`;
        $("gauge").classList.toggle("blast", G.blast > 0);
        $("best").textContent = save.best.toLocaleString();
    },
    over(bonus, best) {
        this.show("over");
        $("o-score").textContent = G.score.toLocaleString();
        $("o-info").textContent = `Last ball bonus ${bonus.toLocaleString()}`;
        $("o-best").textContent = best ? "A NEW HIGH SCORE" : `High score ${save.best.toLocaleString()}`;
        $("o-best").classList.toggle("new", best);
    },
    toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(this._t); this._t = setTimeout(() => el.classList.remove("show"), 1300); },
};
function banner(title, sub = "", kind = "") {
    const el = $("banner");
    el.className = "show " + kind;
    $("b-title").textContent = title; $("b-sub").textContent = sub;
    void el.offsetWidth;
    el.classList.add("anim");
    clearTimeout(banner._t); banner._t = setTimeout(() => (el.className = ""), 2000);
}
$("t-best").textContent = save.best.toLocaleString();
for (const id of ["title", "over"]) $(id).addEventListener("pointerdown", () => { audio.init(); if (state !== "play") start(); });

// ------------------------------------------------------------------ loop

// attract mode: one ball wandering the table
balls = [{ x: 0.5, y: 15, vx: 3, vy: 0, held: false }];
ui.show("title");
if (params.has("autoplay")) {                 // demo / testing: a simple robot flips when a ball comes near
    start();
    window.__gear = () => ({ state, score: G.score, ball: G.ball, balls: balls.length, pressure: G.pressure, locks: G.locks, lockLit: G.lockLit, mb: G.multiball, mult: G.mult, pos: balls.map((b) => [b.x.toFixed(2), b.y.toFixed(2), b.vx.toFixed(1), b.vy.toFixed(1)].join(" ")) });
    setInterval(() => {
        if (state !== "play") return;
        const pb = plungerBall();
        if (pb && !plungerHeld && balls.every((b) => b === pb || !inShooter(b))) { plungerHeld = true; setTimeout(() => plunger(false), (500 + Math.random() * 700) / SPEED); }
        for (const [i, f] of T.flippers.entries()) {
            const mid = f.px + Math.cos(f.rest) * f.len * 0.55;
            const near = balls.some((b) => !b.held && Math.abs(b.x - mid) < 0.95 && b.y > 1.3 && b.y < 3.3 && b.vy < 1.5);
            f.robot = near && (f.robot || 0) < 18 ? (f.robot || 0) + 1 : near ? (f.robot || 0) + 1 : 0;
            setFlipper(i ? "right" : "left", near && f.robot < 18);
            if (f.robot > 30) f.robot = 0;
        }
    }, 30 / SPEED);
}
let last = performance.now();
function frame(now) {
    const dt = Math.max(0, Math.min(0.033, (now - last) / 1000));
    last = now; frameDt = dt;
    for (let s = 0; s < SPEED; s++) update(dt);
    render();
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
