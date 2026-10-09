// STARSLING — a gravity slingshot puzzle in space, rendered with the projection3d library (Space).
//
// Pull back anywhere and release to fling the comet. Planets bend its path; collect the 3 stars and reach the
// wormhole. Moons orbit, black holes swallow, asteroid belts smash — and every level is generated with a
// proven solution that collects all three stars. Your best star count per level is saved.
//
// Rendering: sky, planets, rings and the spacetime grid live in Space's buffers (rebuilt per level; the grid
// sinks into gravity wells in the vertex shader, so moving moons bend it live). Comet, trail, stars, portal,
// moons, asteroids and glows are rebuilt into GameSpace's dynamic buffers every frame.

import GameSpace from "./GameSpace.js";
import { createProgram } from "./shaders.js";
import { Audio } from "./audio.js";
import { generate, step, bodyPos, TYPES, MAX_SPEED, STAR_R, COMET_R, PORTAL_R } from "./level.js";

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
    sprite(x, y, z, size, r, g, b, mat = 5) { for (const k of [0, 1, 2, 0, 2, 3]) this.v(x, y, z, size + k * 100, r, g, b, mat); }
    append(o) {
        while ((this.n + o.n) * 4 > this.pos.length) this.grow();
        this.pos.set(o.pos.subarray(0, o.n * 4), this.n * 4); this.col.set(o.col.subarray(0, o.n * 4), this.n * 4);
        this.n += o.n;
    }
}

function icosphere(level) {
    const t = (1 + Math.sqrt(5)) / 2, nrm = (p) => { const l = Math.hypot(...p); return p.map((c) => c / l); };
    let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(nrm);
    let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (let l = 0; l < level; l++) {
        const cache = new Map(), nf = [];
        const mid = (a, b) => { const k = Math.min(a, b) * 1e5 + Math.max(a, b); if (!cache.has(k)) { cache.set(k, v.length); v.push(nrm(v[a].map((c, i) => (c + v[b][i]) / 2))); } return cache.get(k); };
        for (const [a, b, c] of f) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
        f = nf;
    }
    return { v, f };
}
const SPHERE = icosphere(4), SMALL = icosphere(2), ROCK = icosphere(0);

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

// ------------------------------------------------------------------ save + state

const save = (() => { try { return Object.assign({ level: 1, best: {} }, JSON.parse(localStorage.getItem("starsling.save")) || {}); } catch { return { level: 1, best: {} }; } })();
const persist = () => { try { localStorage.setItem("starsling.save", JSON.stringify(save)); } catch { } };
const totalStars = () => Object.values(save.best).reduce((a, b) => a + b, 0);

let state = "title";          // title | aim | fly | done
let L = null, levelNo = save.level;
let comet = null, got = 0, attempts = 0, flightAcc = 0;
let aim = null;               // { sx, sy (world press point), px, py (pull vector) }
let time = 0, flash = 0, demoTimer = 1.5, resultTimer = 0;
let particles = [], trail = [];
let ranges = { sky: 6, planets: [0, 0], rings: [0, 0], grid: [0, 0] };

function loadLevel(n) {
    levelNo = n;
    L = generate(n);
    L.stars.forEach((s) => (s.got = false));
    resetShot();
    buildStatic();
    attempts = 0;
    ui.hud();
}

function resetShot() {
    comet = { x: L.start.x, y: L.start.y, vx: 0, vy: 0, t: 0, alive: true, flying: false };
    L.stars.forEach((s) => (s.got = false));
    got = 0; trail = []; aim = null; flightAcc = 0;
}

function launch(vx, vy) {
    Object.assign(comet, { vx, vy, t: 0, flying: true });
    if (state !== "title") { state = "fly"; attempts++; }
    audio.launch(Math.hypot(vx, vy) / MAX_SPEED);
    ui.hud();
}

// ------------------------------------------------------------------ static scene (per level)

const stat = new Mesh(120000);
function buildStatic() {
    const m = stat;
    m.reset();
    m.tri([-1, -1, 0], [1, -1, 0], [1, 1, 0], [0, 0, 0], 3);
    m.tri([-1, -1, 0], [1, 1, 0], [-1, 1, 0], [0, 0, 0], 3);
    const p0 = m.n;
    L.bodies.forEach((b, i) => {
        if (b.parent !== undefined) return;                             // moons move: drawn every frame
        for (const [a, bb, c] of SPHERE.f) {
            const P = (k) => [b.x + SPHERE.v[k][0] * b.r, b.y + SPHERE.v[k][1] * b.r, SPHERE.v[k][2] * b.r];
            m.v(...P(a), i, ...SPHERE.v[a], 1); m.v(...P(bb), i, ...SPHERE.v[bb], 1); m.v(...P(c), i, ...SPHERE.v[c], 1);
        }
    });
    const r0 = m.n;
    for (const b of L.bodies) {
        if (!b.ringed) continue;
        const inner = b.r * 1.35, outer = b.r * 2.25, N = 96, ct = Math.cos(0.35 + b.tilt * 0.4), st = Math.sin(0.35 + b.tilt * 0.4);
        const P = (r, a) => { const x = Math.cos(a) * r, y = Math.sin(a) * r; return [b.x + x, b.y + y * ct, y * st]; };
        for (let k = 0; k < N; k++) {
            const a0 = (k / N) * 6.2832, a1 = ((k + 1) / N) * 6.2832;
            for (let j = 0; j < 4; j++) {
                const f0 = j / 4, f1 = (j + 1) / 4, ra = inner + (outer - inner) * f0, rb = inner + (outer - inner) * f1;
                const col = b.a.map((c, i) => (c + b.b[i]) * 0.55);
                m.v(...P(ra, a0), f0, ...col, 6); m.v(...P(rb, a0), f1, ...col, 6); m.v(...P(rb, a1), f1, ...col, 6);
                m.v(...P(ra, a0), f0, ...col, 6); m.v(...P(rb, a1), f1, ...col, 6); m.v(...P(ra, a1), f0, ...col, 6);
            }
        }
    }
    const g0 = m.n, S = 0.5;
    for (let y = -13; y < 13; y += S) for (let x = -21; x < 21; x += S) {
        m.v(x, y, 0, 1, 0, 0, 0, 4); m.v(x + S, y, 0, 1, 0, 0, 0, 4); m.v(x + S, y + S, 0, 1, 0, 0, 0, 4);
        m.v(x, y, 0, 1, 0, 0, 0, 4); m.v(x + S, y + S, 0, 1, 0, 0, 0, 4); m.v(x, y + S, 0, 1, 0, 0, 0, 4);
    }
    ranges = { sky: 6, planets: [p0, r0 - p0], rings: [r0, g0 - r0], grid: [g0, m.n - g0] };
    space.setStatic(m.pos, m.col, m.n);
}

// ------------------------------------------------------------------ input (slingshot)

const toWorld = (sx, sy) => {                   // screen → the z = 0 play plane
    const nx = (sx / innerWidth) * 2 - 1, ny = 1 - (sy / innerHeight) * 2, aspect = canvas.width / canvas.height, k = 1.6 / space.magnifier;
    const X = space.xUnitVec, Y = space.yUnitVec, Z = space.zUnitVec;
    const d = [0, 1, 2].map((i) => Z[i] - X[i] * nx * k + Y[i] * ny * k / aspect);
    const t = -space.Zc / d[2];
    return [space.Xc + d[0] * t, space.Yc + d[1] * t];
};
const PULL_K = 2.1, PULL_MAX = MAX_SPEED / PULL_K;
let mouse = [0, 0];
canvas.addEventListener("pointerdown", (e) => {
    audio.init();
    canvas.setPointerCapture(e.pointerId);
    if (state === "title") { start(); return; }
    if (state === "done") return;
    if (state === "fly") return;
    const [x, y] = toWorld(e.clientX, e.clientY);
    aim = { sx: x, sy: y, px: 0, py: 0 };
});
canvas.addEventListener("pointermove", (e) => {
    mouse = [e.clientX / innerWidth - 0.5, e.clientY / innerHeight - 0.5];
    if (!aim) return;
    const [x, y] = toWorld(e.clientX, e.clientY);
    let px = aim.sx - x, py = aim.sy - y;
    const l = Math.hypot(px, py);
    if (l > PULL_MAX) { px *= PULL_MAX / l; py *= PULL_MAX / l; }
    aim.px = px; aim.py = py;
    audio.pull(Math.min(1, l / PULL_MAX));
});
addEventListener("pointerup", () => {
    if (!aim) return;
    const a = aim; aim = null;
    audio.pull(-1);
    if (Math.hypot(a.px, a.py) < 0.35) return;          // a tap, not a pull
    launch(a.px * PULL_K, a.py * PULL_K);
});
addEventListener("keydown", (e) => {
    audio.init();
    if (e.code === "KeyM") { ui.toast(audio.toggleMute() ? "Sound off" : "Sound on"); return; }
    if (state === "title" && (e.code === "Space" || e.code === "Enter")) start();
    else if (e.code === "KeyR" && state !== "title") { state = "aim"; resetShot(); ui.show("hud"); }
    else if (state === "done" && (e.code === "Space" || e.code === "Enter")) next();
});

function start() { state = "aim"; loadLevel(save.level); ui.show("hud"); }
function next() { state = "aim"; loadLevel(levelNo + 1); ui.show("hud"); }

// ------------------------------------------------------------------ simulation

function emit(x, y, z, vx, vy, vz, life, size, col) { if (particles.length < 1500) particles.push({ x, y, z, vx, vy, vz, life, max: life, size, col }); }
function burst(x, y, n, col, spd, size = 0.12) {
    for (let i = 0; i < n; i++) { const a = Math.random() * 6.28, s = spd * (0.2 + Math.random() * 0.8); emit(x, y, 0, Math.cos(a) * s, Math.sin(a) * s, (Math.random() - 0.5) * spd, 0.6 + Math.random() * 0.8, size, col); }
}

function outcome(r) {
    comet.flying = false;
    if (r.win) {
        comet.alive = false;
        burst(L.portal.x, L.portal.y, 90, [0.6, 0.8, 1.4], 7, 0.14);
        flash = 0.35;
        audio.warp();
        if (state === "title") { demoTimer = 2.5; return; }
        state = "done";
        const prev = save.best[levelNo] || 0;
        save.best[levelNo] = Math.max(prev, got);
        save.level = Math.max(save.level, levelNo + 1);
        persist();
        setTimeout(() => ui.result(got, prev), 700);
        return;
    }
    comet.alive = false;
    if (r.hit || r.hitRock) { burst(comet.x, comet.y, 70, [1.4, 0.6, 0.25], 6); flash = 0.2; audio.crash(); }
    else audio.lost();
    if (state === "title") { demoTimer = 1.5; return; }
    ui.toast(r.hit ? (r.hit.type === TYPES.HOLE ? "Swallowed by the black hole" : "Crashed!") : r.hitRock ? "Hit an asteroid" : "Lost in space");
    setTimeout(() => { if (state === "fly") { state = "aim"; resetShot(); ui.hud(); } }, 1100);
}

function update(dt) {
    time += dt;
    // title: the demo fires the level's known solution
    if (state === "title" && !comet.flying) {
        demoTimer -= dt;
        if (demoTimer <= 0 && L.solution) { resetShot(); launch(Math.cos(L.solution.ang) * L.solution.spd, Math.sin(L.solution.ang) * L.solution.spd); }
    }
    if (comet.flying) {
        flightAcc += dt;
        const h = 1 / 120;
        while (flightAcc >= h && comet.flying) {
            flightAcc -= h;
            const r = step(L, comet, h);
            for (const s of L.stars) {
                if (s.got || (s.x - comet.x) ** 2 + (s.y - comet.y) ** 2 > (STAR_R + COMET_R) ** 2) continue;
                s.got = true; got++;
                audio.star(got);
                burst(s.x, s.y, 30, [1.4, 1.1, 0.4], 4, 0.1);
                if (state !== "title") ui.hud();
            }
            if (r) { outcome(r); break; }
        }
        const spd = Math.hypot(comet.vx, comet.vy);
        trail.unshift([comet.x, comet.y]);
        if (trail.length > 40) trail.pop();
        for (let i = 0; i < 3; i++) {
            const c = spd > 9 ? [0.6, 0.85, 1.3] : [0.4, 0.9, 1.1];
            emit(comet.x, comet.y, 0, -comet.vx * 0.15 + (Math.random() - 0.5) * 0.8, -comet.vy * 0.15 + (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.5, 0.7, 0.12, c);
        }
    }
    for (const p of particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; const d = Math.exp(-dt * 1.2); p.vx *= d; p.vy *= d; p.vz *= d; p.life -= dt; }
    particles = particles.filter((p) => p.life > 0);
    flash = Math.max(0, flash - dt * 2);
}

// ------------------------------------------------------------------ per-frame geometry

const solid = new Mesh(40000), glow = new Mesh(40000);
const STAR_SHAPE = Array.from({ length: 10 }, (_, i) => { const a = (i / 10) * 6.2832 + Math.PI / 2, r = i % 2 ? 0.2 : 0.5; return [Math.cos(a) * r, Math.sin(a) * r]; });

function buildDynamic() {
    solid.reset(); glow.reset();
    const t = comet.flying ? comet.t : 0;

    // moons (orbiting) and asteroid belts
    L.bodies.forEach((b, i) => {
        if (b.parent === undefined) return;
        const [x, y] = bodyPos(L, b, t);
        for (const [a, bb, c] of SMALL.f) {
            const P = (k) => [x + SMALL.v[k][0] * b.r, y + SMALL.v[k][1] * b.r, SMALL.v[k][2] * b.r];
            solid.v(...P(a), i, ...SMALL.v[a], 1); solid.v(...P(bb), i, ...SMALL.v[bb], 1); solid.v(...P(c), i, ...SMALL.v[c], 1);
        }
    });
    for (const rock of L.rocks) {
        const p = L.bodies[rock.parent], ang = rock.phase + rock.omega * t;
        const x = p.x + Math.cos(ang) * rock.orbit, y = p.y + Math.sin(ang) * rock.orbit, s = rock.r, sp = time + rock.seed;
        const cs = Math.cos(sp), sn = Math.sin(sp);
        for (const [a, bb, c] of ROCK.f) {
            const P = (k) => { const v = ROCK.v[k], j = 0.8 + ((k * 37 + Math.floor(rock.seed)) % 7) / 14; return [x + (v[0] * cs - v[1] * sn) * s * j, y + (v[0] * sn + v[1] * cs) * s * j, v[2] * s * j]; };
            solid.tri(P(a), P(bb), P(c), [0.45, 0.4, 0.37], 0);
        }
    }

    // atmospheres
    for (const b of L.bodies) {
        if (b.type === TYPES.HOLE) continue;
        const k = b.parent !== undefined ? 0.35 : 0.55;
        glow.sprite(b.x !== undefined ? b.x : bodyPos(L, b, t)[0], b.y !== undefined ? b.y : bodyPos(L, b, t)[1], 0, b.r * 1.5, b.atmo[0] * k, b.atmo[1] * k, b.atmo[2] * k, 7);
    }

    // black holes: a spinning accretion disk of glowing specks + photon ring
    for (const b of L.bodies) {
        if (b.type !== TYPES.HOLE) continue;
        for (let arm = 0; arm < 3; arm++) for (let k = 0; k < 26; k++) {
            const f = k / 26, r = 0.55 + f * 1.6, a = arm * 2.094 + f * 3.2 - time * (2.6 - f * 1.4);
            const c = [1.3 - f * 0.4, 0.75 - f * 0.45, 0.35 - f * 0.25];
            glow.sprite(b.x + Math.cos(a) * r, b.y + Math.sin(a) * r * 0.55, Math.sin(a) * r * 0.2, 0.28 * (1 - f * 0.5), c[0] * 0.5, c[1] * 0.5, c[2] * 0.5);
        }
        glow.sprite(b.x, b.y, 0, 0.9, 1.0, 0.7, 0.4);
    }

    // wormhole: spiral arms + a bright ring
    const P0 = L.portal;
    for (let arm = 0; arm < 4; arm++) for (let k = 0; k < 16; k++) {
        const f = k / 16, r = 0.15 + f * 1.4, a = arm * 1.571 + f * 4 + time * 3;
        glow.sprite(P0.x + Math.cos(a) * r, P0.y + Math.sin(a) * r, 0.05, 0.22 * (1.2 - f), 0.35 * (1 - f) + 0.1, 0.35 + 0.2 * f, 0.9 - f * 0.3);
    }
    for (let k = 0; k < 24; k++) { const a = (k / 24) * 6.2832 + time; glow.sprite(P0.x + Math.cos(a) * PORTAL_R, P0.y + Math.sin(a) * PORTAL_R, 0.05, 0.16, 0.5, 0.7, 1.2); }
    glow.sprite(P0.x, P0.y, 0.1, 0.8, 0.5, 0.6, 1.2);

    // launcher pad
    for (let k = 0; k < 18; k++) { const a = (k / 18) * 6.2832 - time * 0.8; glow.sprite(L.start.x + Math.cos(a) * 0.7, L.start.y + Math.sin(a) * 0.7, 0, 0.1, 0.4, 0.9, 0.7); }

    // stars to collect
    for (const s of L.stars) {
        if (s.got) continue;
        const sp = time * 1.8 + s.x, bob = Math.sin(time * 3 + s.y) * 0.08;
        const cs = Math.cos(sp), sn = Math.sin(sp);
        const P = ([x, y]) => [s.x + x * cs, s.y + x * sn, 0.45 + y + bob];                      // stands upright, turning
        for (let i = 0; i < 10; i++) {
            const a = STAR_SHAPE[i], b = STAR_SHAPE[(i + 1) % 10];
            solid.tri(P([0, 0]), P(a), P(b), [1.4, 1.05, 0.35], 2);
        }
        glow.sprite(s.x, s.y, 0.45, 0.9, 0.6, 0.45, 0.12);
    }

    // comet: resting on the pad, pulled back, or flying with a tail
    let cx = comet.x, cy = comet.y;
    if (aim) { const l = Math.hypot(aim.px, aim.py) || 1, k = Math.min(1.4, l * 0.35); cx -= (aim.px / l) * k; cy -= (aim.py / l) * k; }
    if (comet.alive) {
        glow.sprite(cx, cy, 0, 0.5, 0.6, 0.9, 1.3);
        glow.sprite(cx, cy, 0, 0.22, 1.5, 1.5, 1.5);
    }
    trail.forEach(([x, y], i) => { const f = 1 - i / trail.length; glow.sprite(x, y, 0, 0.2 * f + 0.04, 0.2 * f, 0.4 * f, 0.6 * f); });

    // aiming: slingshot band and a short trajectory preview
    if (aim && Math.hypot(aim.px, aim.py) > 0.2) {
        for (let k = 0; k <= 8; k++) { const f = k / 8; glow.sprite(L.start.x + (cx - L.start.x) * f, L.start.y + (cy - L.start.y) * f, 0, 0.06, 0.8, 0.5, 0.9); }
        const s = { x: L.start.x, y: L.start.y, vx: aim.px * PULL_K, vy: aim.py * PULL_K, t: 0 };
        for (let i = 0; i < 132; i++) {                  // about 1.1 seconds of the path
            if (step(L, s, 1 / 120)) break;
            if (i % 6 === 0) { const f = 1 - i / 132; glow.sprite(s.x, s.y, 0, 0.09 * f + 0.03, 0.9 * f, 0.9 * f, 1.0 * f); }
        }
    }

    for (const p of particles) { const f = p.life / p.max; glow.sprite(p.x, p.y, p.z, p.size * (0.5 + f), p.col[0] * f, p.col[1] * f, p.col[2] * f); }

    const n = solid.n;
    solid.append(glow);
    space.setDynamic(solid.pos, solid.col, solid.n);
    return { sN: n, gN: glow.n };
}

// ------------------------------------------------------------------ render

const uB = new Float32Array(U.MAXB * 4), uBM = new Float32Array(U.MAXB * 4), uBA = new Float32Array(U.MAXB * 3), uBB = new Float32Array(U.MAXB * 3), uSeed = new Float32Array(U.MAXB);
function render() {
    const aspect = canvas.width / canvas.height;
    space.magnifier = aspect < 1 ? 1.25 : aspect < 1.5 ? 1.85 : 2.25;
    const sway = state === "title" ? [Math.sin(time * 0.2) * 3, Math.cos(time * 0.15) * 1.5] : [mouse[0] * 1.2, mouse[1] * -0.8];
    space.lookAt(sway[0], -15.5 + sway[1], 23, 0, 0.4, 0);

    const t = comet.flying ? comet.t : 0;
    const n = Math.min(U.MAXB, L.bodies.length);
    for (let i = 0; i < n; i++) {
        const b = L.bodies[i], [x, y] = bodyPos(L, b, t);
        uB.set([x, y, 0, b.r], i * 4);
        uBM.set([b.m, b.type, time * (b.spin || 0.2) + b.seed, b.tilt || 0], i * 4);
        uBA.set(b.a, i * 3); uBB.set(b.b, i * 3); uSeed[i] = b.seed || 0;
    }
    const { sN, gN } = buildDynamic();
    gl.uniform1f(U.aspect, aspect);
    gl.uniform3f(U.veriables, space.zShifter, space.magnifier, 0);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, time);
    gl.uniform4fv(U.uB, uB); gl.uniform4fv(U.uBM, uBM); gl.uniform3fv(U.uBA, uBA); gl.uniform3fv(U.uBB, uBB); gl.uniform1fv(U.uBSeed, uSeed);
    gl.uniform1f(U.uBCount, n);
    gl.uniform1f(U.uFlash, flash * flash * 0.6);
    space.applyCamera();

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    space.bind(false);
    space.draw(0, ranges.sky);
    space.draw(...ranges.planets);
    space.bind(true);
    space.draw(0, sN);
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    space.bind(false);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    space.draw(...ranges.rings);
    gl.blendFunc(gl.ONE, gl.ONE);
    space.draw(...ranges.grid);
    space.bind(true);
    space.draw(sN, gN);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
}

// ------------------------------------------------------------------ UI

const $ = (id) => document.getElementById(id);
const starIcons = (n, of = 3) => Array.from({ length: of }, (_, i) => `<i class="${i < n ? "on" : ""}">★</i>`).join("");
const ui = {
    show(which) { for (const id of ["title", "hud", "result"]) $(id).classList.toggle("hidden", id !== which); this.hud(); },
    hud() {
        if (!L) return;
        $("lv").textContent = levelNo;
        $("got").innerHTML = starIcons(got);
        $("tries").textContent = attempts;
        $("total").textContent = totalStars();
        $("hint").style.opacity = state === "aim" && attempts === 0 ? 1 : 0;
    },
    result(n, prev) {
        this.show("result");
        $("r-level").textContent = `Level ${levelNo} complete`;
        $("r-stars").innerHTML = starIcons(n).replace(/<i class="on">/g, (m, i) => m);
        [...$("r-stars").children].forEach((el, i) => { el.style.animationDelay = `${0.15 + i * 0.25}s`; });
        $("r-msg").textContent = n === 3 ? (attempts === 1 ? "Perfect — first try!" : "All three stars!") : n > prev ? "New best for this level!" : `Collect all 3 stars for a perfect run (${3 - n} missed)`;
        $("r-total").textContent = totalStars();
    },
    toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(this._t); this._t = setTimeout(() => el.classList.remove("show"), 1400); },
};
$("r-next").addEventListener("click", (e) => { e.stopPropagation(); next(); });
$("r-retry").addEventListener("click", (e) => { e.stopPropagation(); state = "aim"; resetShot(); attempts = 0; ui.show("hud"); });
$("t-level").textContent = save.level;
$("t-stars").textContent = totalStars();

// ------------------------------------------------------------------ loop

loadLevel(save.level);
ui.show("title");

// ?autoplay: plays levels by itself with their known solutions (for demos and testing)
if (new URLSearchParams(location.search).has("autoplay")) {
    start();
    setInterval(() => {
        if (state === "aim" && L.solution) launch(Math.cos(L.solution.ang) * L.solution.spd, Math.sin(L.solution.ang) * L.solution.spd);
        else if (state === "done") next();
    }, 1800);
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
