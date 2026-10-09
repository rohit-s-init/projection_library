// PRISM RUSH — a synthwave endless runner rendered with the projection3d library (Space).
//
// Fly down an endless neon highway: steer around crystal blocks, jump laser gates, grab orbs to build a
// combo multiplier, skim past obstacles for "close call" bonuses, and pick up shields, magnets and double
// points. Every 1500 m the world changes colour (a new zone) and it gets faster. Missions and unlockable
// ship skins keep going between runs; your best score and progress are saved in the browser.
//
// Rendering: the static scene (sky quad + landscape grid) sits in Space's buffers; everything that moves is
// rebuilt each frame into GameSpace's dynamic buffers: first solid geometry, then glow sprites (additive).

import GameSpace from "./GameSpace.js";
import { createProgram } from "./shaders.js";
import { Mesh, box, boxEdges, sprite, gem, ship, skyQuad, groundGrid } from "./geometry.js";
import { Audio } from "./audio.js";

// ------------------------------------------------------------------ tuning

const LANES = [-5.2, -2.6, 0, 2.6, 5.2];
const TRACK_HALF = 6.5;
const SHIP_W = 0.6, SHIP_L = 0.9, HOVER = 0.35;
const GRAVITY = 32, JUMP_V = 11;
const ZONE_LEN = 1500;
const VIEW_AHEAD = 430;

const PALETTES = [
    { name: "Sunset Drive", skyTop: [0.12, 0.02, 0.22], skyHorizon: [0.95, 0.25, 0.55], sun1: [1.0, 0.85, 0.25], sun2: [1.0, 0.2, 0.55], grid: [1.0, 0.2, 0.8], accent: [0.2, 0.9, 1.0], ground: [0.03, 0.0, 0.06], obst: [0.25, 0.05, 0.35], edge: [1.0, 0.3, 0.9] },
    { name: "Aurora", skyTop: [0.0, 0.04, 0.14], skyHorizon: [0.1, 0.75, 0.65], sun1: [0.75, 1.0, 0.85], sun2: [0.1, 0.55, 1.0], grid: [0.1, 1.0, 0.7], accent: [0.9, 0.4, 1.0], ground: [0.0, 0.03, 0.05], obst: [0.02, 0.2, 0.25], edge: [0.2, 1.0, 0.8] },
    { name: "Ember", skyTop: [0.14, 0.01, 0.02], skyHorizon: [1.0, 0.35, 0.1], sun1: [1.0, 0.92, 0.45], sun2: [1.0, 0.25, 0.05], grid: [1.0, 0.35, 0.1], accent: [1.0, 0.85, 0.2], ground: [0.05, 0.0, 0.0], obst: [0.3, 0.06, 0.02], edge: [1.0, 0.5, 0.1] },
    { name: "Deep Space", skyTop: [0.0, 0.0, 0.06], skyHorizon: [0.25, 0.2, 0.9], sun1: [0.8, 0.9, 1.0], sun2: [0.4, 0.3, 1.0], grid: [0.35, 0.45, 1.0], accent: [1.0, 0.3, 0.5], ground: [0.0, 0.0, 0.04], obst: [0.08, 0.08, 0.3], edge: [0.5, 0.6, 1.0] },
    { name: "Gold Rush", skyTop: [0.08, 0.02, 0.12], skyHorizon: [1.0, 0.6, 0.2], sun1: [1.0, 1.0, 0.6], sun2: [1.0, 0.45, 0.1], grid: [1.0, 0.75, 0.2], accent: [1.0, 0.3, 0.8], ground: [0.05, 0.02, 0.0], obst: [0.3, 0.2, 0.04], edge: [1.0, 0.8, 0.3] },
    { name: "Toxic Bloom", skyTop: [0.02, 0.07, 0.02], skyHorizon: [0.55, 1.0, 0.15], sun1: [0.95, 1.0, 0.55], sun2: [0.25, 1.0, 0.3], grid: [0.5, 1.0, 0.15], accent: [1.0, 0.25, 0.65], ground: [0.01, 0.04, 0.0], obst: [0.1, 0.25, 0.02], edge: [0.6, 1.0, 0.2] },
];
const PAL_KEYS = ["skyTop", "skyHorizon", "sun1", "sun2", "grid", "accent", "ground", "obst", "edge"];

const SKINS = [
    { name: "Neon", need: 0, base: [0.08, 0.1, 0.2], accent: [0.3, 0.9, 1.0], trail: [0.3, 0.9, 1.0] },
    { name: "Magenta", need: 150, base: [0.15, 0.03, 0.12], accent: [1.0, 0.3, 0.8], trail: [1.0, 0.3, 0.8] },
    { name: "Solar", need: 400, base: [0.2, 0.08, 0.02], accent: [1.0, 0.7, 0.2], trail: [1.0, 0.55, 0.1] },
    { name: "Venom", need: 900, base: [0.03, 0.12, 0.05], accent: [0.4, 1.0, 0.3], trail: [0.5, 1.0, 0.3] },
    { name: "Void", need: 1800, base: [0.02, 0.02, 0.03], accent: [0.7, 0.4, 1.0], trail: [0.8, 0.5, 1.0] },
    { name: "Prism", need: 3500, base: [0.1, 0.1, 0.12], accent: [1, 1, 1], trail: [1, 1, 1], rainbow: true },
];

const POWERS = {
    shield: { name: "SHIELD", color: [0.3, 0.95, 1.0], time: 0 },
    magnet: { name: "MAGNET", color: [0.75, 0.4, 1.0], time: 9 },
    double: { name: "2X SCORE", color: [1.0, 0.85, 0.2], time: 9 },
};

const MISSIONS = {
    orbs: { text: (n) => `Collect ${n} orbs in one run`, tiers: [30, 60, 100, 150, 220, 320], stat: "orbs" },
    dist: { text: (n) => `Fly ${n} m in one run`, tiers: [800, 1500, 3000, 5000, 8000, 12000], stat: "dist" },
    near: { text: (n) => `Get ${n} close calls in one run`, tiers: [3, 8, 15, 25, 40, 60], stat: "near" },
    mult: { text: (n) => `Reach a x${n} multiplier`, tiers: [3, 4, 5, 6, 7, 8], stat: "maxMult" },
    jump: { text: (n) => `Jump ${n} laser gates in one run`, tiers: [3, 8, 15, 25, 40], stat: "jumps" },
    power: { text: (n) => `Grab ${n} power-ups in one run`, tiers: [1, 3, 5, 8, 12], stat: "powers" },
    score: { text: (n) => `Score ${n.toLocaleString()} in one run`, tiers: [2000, 6000, 15000, 30000, 60000, 100000], stat: "score" },
};

// ------------------------------------------------------------------ save data

const SAVE_KEY = "prism.save.v1";
const save = (() => {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { }
    s = Object.assign({ best: 0, lifetime: 0, skin: 0, runs: 0, missions: [] }, s || {});
    s.missions = s.missions.filter((m) => MISSIONS[m.id]);
    while (s.missions.length < 3) s.missions.push(newMission(s.missions));
    return s;
})();
function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { } }
function newMission(active, tier) {
    const free = Object.keys(MISSIONS).filter((id) => !active.some((m) => m.id === id));
    const id = free[Math.floor(Math.random() * free.length)];
    return { id, tier: Math.min(tier ?? 0, MISSIONS[id].tiers.length - 1) };
}
const missionTarget = (m) => MISSIONS[m.id].tiers[Math.min(m.tier, MISSIONS[m.id].tiers.length - 1)];
const missionReward = (m) => 40 + m.tier * 40;

// ------------------------------------------------------------------ canvas + library

const canvas = document.getElementById("view");
/** @type {WebGLRenderingContext} */
const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
if (!gl) document.getElementById("nowebgl").style.display = "grid";
function sizeCanvas() {
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
}
sizeCanvas();
addEventListener("resize", sizeCanvas);

const space = new GameSpace(gl);
const U = createProgram(gl, space);
const audio = new Audio();

// static scene: sky quad + landscape grid (uploaded once into Space's buffers)
{
    const m = new Mesh(90000);
    skyQuad(m);
    groundGrid(m);
    space.setStatic(m.pos, m.col, m.n);
}
const solid = new Mesh(60000), glow = new Mesh(20000);

// ------------------------------------------------------------------ game state

let state = "title";                   // title | play | dead | paused
let objects = [];
let nextRowY = 0, prevFree = 2;
const P = {};                          // player
const run = {};                        // per-run stats
let time = 0, slowmo = 1, shake = 0, flash = 0;
const bend = { x: 0, y: -0.0003, tx: 0, ty: -0.0003, timer: 0 };
const pal = {};                        // current (blended) palette
let palFrom = 0, palTo = 0, palMix = 1;
const cam = { x: 0, y: -8, z: 3, fov: 1.7 };

function resetRun(attract) {
    objects = [];
    Object.assign(P, { x: 0, vx: 0, jz: 0, vz: 0, y: 0, speed: 34, alive: true, roll: 0, invuln: 0, targetX: null, lastInput: "keys" });
    Object.assign(run, { score: 0, orbs: 0, near: 0, jumps: 0, powers: 0, combo: 0, comboTimer: 0, mult: 1, maxMult: 1, dist: 0, zone: 0, shield: false, magnet: 0, double: 0, attract, completed: [] });
    nextRowY = 60; prevFree = 2;
    palFrom = palTo = 0; palMix = 1;
    particles.count = 0;
    while (nextRowY < VIEW_AHEAD) spawnRow();
}

// ------------------------------------------------------------------ particles

const MAXP = 1200;
const particles = {
    count: 0,
    d: new Float32Array(MAXP * 13),   // x y z vx vy vz life max size r g b grav
};
function emit(x, y, z, n, spd, col, size, life, grav = 0, vyBias = 0) {
    for (let i = 0; i < n; i++) {
        if (particles.count >= MAXP) return;
        const o = particles.count++ * 13, d = particles.d;
        const a = Math.random() * Math.PI * 2, b = Math.acos(Math.random() * 2 - 1), s = spd * (0.4 + Math.random() * 0.6);
        d[o] = x; d[o + 1] = y; d[o + 2] = z;
        d[o + 3] = Math.cos(a) * Math.sin(b) * s; d[o + 4] = Math.sin(a) * Math.sin(b) * s + vyBias; d[o + 5] = Math.cos(b) * s;
        d[o + 7] = d[o + 6] = life * (0.6 + Math.random() * 0.4);
        d[o + 8] = size; d[o + 9] = col[0]; d[o + 10] = col[1]; d[o + 11] = col[2]; d[o + 12] = grav;
    }
}
function updateParticles(dt) {
    const d = particles.d;
    for (let i = 0; i < particles.count; i++) {
        const o = i * 13;
        d[o + 6] -= dt;
        if (d[o + 6] <= 0 || d[o + 1] < P.y - 12) {                  // dead: swap with the last one
            const l = --particles.count * 13;
            for (let k = 0; k < 13; k++) d[o + k] = d[l + k];
            i--; continue;
        }
        d[o] += d[o + 3] * dt; d[o + 1] += d[o + 4] * dt; d[o + 2] += d[o + 5] * dt;
        d[o + 5] -= d[o + 12] * dt;
        if (d[o + 2] < 0.02) { d[o + 2] = 0.02; d[o + 5] *= -0.4; }
        const drag = Math.exp(-dt * 1.5);
        d[o + 3] *= drag; d[o + 5] *= drag;
    }
}

// ------------------------------------------------------------------ world generation

const rnd = Math.random;
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const difficulty = () => Math.min(1, run.dist / 7000);

function addOrbLine(lane, y0, n, gap = 3.2) {
    for (let i = 0; i < n; i++) objects.push({ t: "orb", x: LANES[lane], y: y0 + i * gap, z: 0.95 });
}

function spawnRow() {
    const y = nextRowY, d = difficulty();
    const maxStep = P.speed > 62 ? 1 : 2;
    const free = Math.max(0, Math.min(4, prevFree + rint(-maxStep, maxStep)));
    const r = rnd();
    let gap = 34 - 12 * d + P.speed * 0.12;

    if (y < 110) {                                                  // a gentle start
        addOrbLine(free, y, 5);
    } else if (r < 0.12) {                                          // orb rush: a snake of orbs, no danger
        const ph = rnd() * 6;
        for (let i = 0; i < 14; i++) objects.push({ t: "orb", x: 4.6 * Math.sin(i * 0.45 + ph), y: y + i * 3, z: 0.95 });
        gap += 20;
    } else if (r < 0.44) {                                          // scattered crystal blocks
        const density = 0.45 + 0.35 * d;
        let placed = 0;
        LANES.forEach((x, i) => {
            if (i === free) return;
            if (rnd() < density || (placed === 0 && i === (free + 2) % 5)) {
                objects.push({ t: "block", x, y: y + rnd() * 2, w: 2.3, d: 1.4 + rnd() * 1.4, h: 2.2 + rnd() * 1.8 });
                placed++;
            }
        });
        addOrbLine(free, y - 6, 4);
    } else if (r < 0.62 + d * 0.06) {                               // a wall with one gap
        LANES.forEach((x, i) => { if (i !== free) objects.push({ t: "block", x, y, w: 2.55, d: 1.2, h: 3.3, wall: true }); });
        addOrbLine(free, y - 8, 3, 3.5);
        gap += 4;
    } else if (r < 0.8) {                                           // laser gate: jump it, orbs arc over
        objects.push({ t: "laser", x: 0, y });
        const lane = rint(0, 4);
        for (let i = -2; i <= 2; i++) objects.push({ t: "orb", x: LANES[lane], y: y + i * 2.4, z: 0.95 + (2.2 - i * i * 0.45) });
        if (d > 0.35 && rnd() < 0.5) {                              // …with blocks right after it
            LANES.forEach((x, i) => { if (Math.abs(i - lane) > 1 && rnd() < 0.7) objects.push({ t: "block", x, y: y + 14, w: 2.3, d: 1.6, h: 2.6 }); });
            gap += 10;
        }
    } else if (d > 0.12) {                                          // sliding blocks
        const n = d > 0.5 && rnd() < 0.5 ? 2 : 1;
        for (let k = 0; k < n; k++)
            objects.push({ t: "slider", x: 0, base: 0, y: y + k * 12, w: 2.4, d: 1.6, h: 2.8, amp: 4.3, freq: 1.1 + rnd() * 0.9 + d * 0.6, ph: rnd() * 6 });
        for (let i = 0; i < 6; i++) objects.push({ t: "orb", x: 4 * Math.sin(i * 0.9), y: y - 10 + i * 4 + n * 6, z: 0.95 });
        gap += (n - 1) * 12;
    } else {
        addOrbLine(free, y, 6);
    }
    // power-ups now and then, in the free lane
    if (y > 250 && rnd() < 0.075) {
        const kinds = ["shield", "magnet", "double"].filter((k) => !(k === "shield" && run.shield));
        objects.push({ t: "power", kind: kinds[rint(0, kinds.length - 1)], x: LANES[free], y: y - 12, z: 1.2 });
    }
    prevFree = free;
    nextRowY += gap;
}

// ------------------------------------------------------------------ input

const keys = new Set();
addEventListener("keydown", (e) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "Space"].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    audio.init();
    if (e.code === "KeyM") { toast(audio.toggleMute() ? "Sound off" : "Sound on"); return; }
    if (state === "title" || state === "dead") { if (e.code === "Space" || e.code === "Enter") startGame(); return; }
    if (state === "paused") { if (["Space", "Enter", "KeyP", "Escape"].includes(e.code)) resume(); return; }
    if (e.code === "KeyP" || e.code === "Escape") { pause(); return; }
    if (["Space", "ArrowUp", "KeyW"].includes(e.code)) jump();
    if (["ArrowLeft", "ArrowRight", "KeyA", "KeyD"].includes(e.code)) P.lastInput = "keys";
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => { keys.clear(); if (state === "play") pause(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && state === "play") pause(); });

// mouse / touch: the ship follows the pointer's horizontal position; tap or swipe up to jump
let touchStart = null;
canvas.addEventListener("pointermove", (e) => {
    if (state !== "play") return;
    if (e.pointerType === "mouse" || touchStart) {
        P.targetX = ((e.clientX / innerWidth) * 2 - 1) * TRACK_HALF * 1.15;
        P.lastInput = "pointer";
    }
});
canvas.addEventListener("pointerdown", (e) => {
    audio.init();
    if (state !== "play") return;
    if (e.pointerType === "mouse") { if (e.button === 0) jump(); return; }
    touchStart = { x: e.clientX, y: e.clientY, t: performance.now() };
    P.targetX = ((e.clientX / innerWidth) * 2 - 1) * TRACK_HALF * 1.15;
    P.lastInput = "pointer";
});
canvas.addEventListener("pointerup", (e) => {
    if (!touchStart) return;
    const dy = e.clientY - touchStart.y, dtm = performance.now() - touchStart.t;
    if (dy < -40 || (dtm < 180 && Math.abs(e.clientX - touchStart.x) < 12)) jump();
    touchStart = null;
});

function jump() {
    if (state !== "play" || !P.alive || P.jz > 0.01) return;
    P.vz = JUMP_V;
    audio.jump();
    emit(P.x, P.y - 0.6, HOVER, 14, 5, pal.accent, 0.25, 0.4, 6, -P.speed * 0.3);
}

// ------------------------------------------------------------------ gameplay

function startGame() {
    audio.init();
    resetRun(false);
    state = "play";
    audio.intensity = 1;
    ui.show("hud");
    setBanner(`ZONE 1 · ${PALETTES[0].name.toUpperCase()}`, "Collect orbs · dodge crystals · jump lasers");
}

function pause() { state = "paused"; ui.show("pause"); }
function resume() { state = "play"; ui.show("hud"); }

function comboUp(n) {
    run.combo += n;
    run.comboTimer = 3.2;
    const m = Math.min(8, 1 + Math.floor(run.combo / 6));
    if (m > run.mult) {
        run.mult = m;
        run.maxMult = Math.max(run.maxMult, m);
        popupAt(P.x, P.y + 4, 2.4, `x${m}!`, "mult");
        ui.pulse("mult");
    }
}
const points = (n) => n * run.mult * (run.double > 0 ? 2 : 1);

function collectOrb(o) {
    o.dead = true;
    run.orbs++;
    comboUp(1);
    const pts = points(10);
    run.score += pts;
    audio.orb(run.combo);
    emit(o.x, o.y, o.z, 12, 6, pal.accent, 0.3, 0.45, 0, P.speed * 0.5);
    if (run.combo % 5 === 0) popupAt(o.x, o.y, o.z + 1, `+${pts}`, "orb");
}

function nearMiss(o, label) {
    run.near++;
    comboUp(2);
    const pts = points(25);
    run.score += pts;
    audio.whoosh();
    popupAt(o.x, o.y, 2, `${label} +${pts}`, "near");
    emit(P.x + Math.sign(o.x - P.x) * 0.7, P.y, HOVER + P.jz + 0.2, 16, 7, pal.edge, 0.22, 0.35, 0, P.speed * 0.4);
    shake = Math.max(shake, 0.12);
}

function takePower(o) {
    o.dead = true;
    run.powers++;
    const def = POWERS[o.kind];
    if (o.kind === "shield") run.shield = true;
    if (o.kind === "magnet") run.magnet = def.time;
    if (o.kind === "double") run.double = def.time;
    audio.powerup();
    emit(o.x, o.y, o.z, 40, 9, def.color, 0.35, 0.7, 0, P.speed * 0.5);
    popupAt(o.x, o.y, o.z + 1.5, def.name, "power");
    flash = 0.12;
}

function hit(o) {
    if (P.invuln > 0) return;
    if (run.shield) {
        run.shield = false;
        P.invuln = 1.2;
        o.dead = true;
        audio.shieldBreak();
        emit(o.x, o.y, 1.5, 70, 12, pal.edge, 0.4, 0.8, 8, P.speed * 0.4);
        popupAt(P.x, P.y + 3, 2.5, "SHIELD SAVED YOU!", "power");
        shake = 0.5; flash = 0.25;
        return;
    }
    crash();
}

function crash() {
    P.alive = false;
    audio.crash();
    emit(P.x, P.y, HOVER + P.jz + 0.3, 160, 16, skin().accent, 0.45, 1.3, 14, P.speed * 0.3);
    emit(P.x, P.y, HOVER + P.jz + 0.3, 90, 10, pal.sun1, 0.6, 1.0, 4, P.speed * 0.2);
    shake = 1; flash = 0.6; slowmo = 0.2;
    if (run.attract) { setTimeout(() => { if (state === "title") resetRun(true); }, 1400); return; }
    audio.intensity = 0;
    setTimeout(gameOver, 1100);
}

function gameOver() {
    state = "dead";
    const score = Math.floor(run.score);
    const newBest = score > save.best;
    const before = save.lifetime;
    save.best = Math.max(save.best, score);
    save.lifetime += run.orbs;
    save.runs++;
    const unlocked = SKINS.filter((s) => s.need > before && s.need <= save.lifetime).map((s) => s.name);
    persist();
    ui.gameOver({ score, newBest, unlocked });
}

// missions complete the moment you hit the target, mid-run
function checkMissions() {
    const stats = { orbs: run.orbs, dist: Math.floor(run.dist), near: run.near, maxMult: run.maxMult, jumps: run.jumps, powers: run.powers, score: Math.floor(run.score) };
    save.missions.forEach((m, i) => {
        if (stats[MISSIONS[m.id].stat] < missionTarget(m)) return;
        const reward = missionReward(m);
        save.lifetime += reward;
        run.completed.push(`${MISSIONS[m.id].text(missionTarget(m))} (+${reward} orbs)`);
        setBanner("MISSION COMPLETE", `${MISSIONS[m.id].text(missionTarget(m))} · +${reward} orbs`);
        audio.chime();
        const others = save.missions.filter((_, k) => k !== i);
        save.missions[i] = newMission(others, m.tier + 1);
        persist();
    });
}

// the title screen's demo pilot: steer for the safest lane (and orbs), jump lasers
function autopilot() {
    const look = P.speed * 0.9;
    const danger = LANES.map(() => 0), bonus = LANES.map(() => 0);
    let laser = Infinity;
    for (const o of objects) {
        const dy = o.y - P.y;
        if (dy < -1 || dy > look || o.dead) continue;
        if (o.t === "laser") { laser = Math.min(laser, dy); continue; }
        if (o.t === "orb" || o.t === "power") { LANES.forEach((x, i) => { if (Math.abs(x - o.x) < 1.3) bonus[i] += 1 / (1 + dy * 0.1); }); continue; }
        LANES.forEach((x, i) => { if (Math.abs(x - o.x) < o.w / 2 + 1.1) danger[i] += 10 / (1 + dy * 0.05); });
    }
    let best = 0, bestScore = -Infinity;
    LANES.forEach((x, i) => {
        const s = -danger[i] + bonus[i] * 0.8 - Math.abs(x - P.x) * 0.08;
        if (s > bestScore) { bestScore = s; best = i; }
    });
    if (laser < P.speed * 0.2 && P.jz < 0.01) { P.vz = JUMP_V; }
    return LANES[best];
}

function update(dt) {
    time += dt;
    // palette: blend towards the current zone's colours
    palMix = Math.min(1, palMix + dt * 0.5);
    for (const k of PAL_KEYS) pal[k] = PALETTES[palFrom][k].map((v, i) => v + (PALETTES[palTo][k][i] - v) * palMix);
    const playing = state === "play" || state === "title";
    if (!playing && state !== "dead") return;
    const gdt = dt * slowmo;
    slowmo += (1 - slowmo) * Math.min(1, dt * 1.5);

    if (P.alive && (state === "play" || state === "title")) {
        // speed ramps up with distance, a bump per zone
        P.speed = 34 + 52 * (1 - Math.exp(-run.dist / 5200)) + run.zone * 1.5;
        P.y += P.speed * gdt;
        run.dist = P.y;
        run.score += gdt * P.speed * 0.5 * (run.double > 0 ? 2 : 1);

        // steering
        let target;
        if (run.attract) target = autopilot();
        else if (P.lastInput === "pointer" && P.targetX !== null) target = P.targetX;
        if (target !== undefined) {
            const want = Math.max(-1, Math.min(1, (target - P.x) * 1.4)) * (15 + P.speed * 0.06);
            P.vx += (want - P.vx) * Math.min(1, gdt * 12);
        } else {
            const dir = (keys.has("ArrowRight") || keys.has("KeyD") ? 1 : 0) - (keys.has("ArrowLeft") || keys.has("KeyA") ? 1 : 0);
            P.vx += (dir * (15 + P.speed * 0.06) - P.vx) * Math.min(1, gdt * (dir ? 10 : 7));
        }
        P.x += P.vx * gdt;
        if (Math.abs(P.x) > TRACK_HALF - SHIP_W) { P.x = Math.sign(P.x) * (TRACK_HALF - SHIP_W); P.vx *= -0.2; }
        P.roll += (-P.vx * 0.045 - P.roll) * Math.min(1, gdt * 10);

        // jumping
        P.vz -= GRAVITY * gdt;
        P.jz += P.vz * gdt;
        if (P.jz <= 0) { P.jz = 0; P.vz = 0; }
        P.invuln = Math.max(0, P.invuln - gdt);

        // timers
        run.comboTimer -= gdt;
        if (run.comboTimer <= 0 && run.combo > 0) { run.combo = 0; run.mult = 1; }
        run.magnet = Math.max(0, run.magnet - gdt);
        run.double = Math.max(0, run.double - gdt);

        // zones
        const zone = Math.floor(run.dist / ZONE_LEN);
        if (zone !== run.zone) {
            run.zone = zone;
            palFrom = palTo; palTo = zone % PALETTES.length; palMix = 0;
            if (!run.attract) {
                setBanner(`ZONE ${zone + 1} · ${PALETTES[palTo].name.toUpperCase()}`, "Faster!");
                audio.zone();
                flash = 0.35;
            }
        }

        // engine trail
        const sk = skin();
        for (const ex of [-0.32, 0.32]) {
            const cz = HOVER + P.jz + 0.3;
            emit(P.x + ex, P.y - 1.1, cz, 1, 0.6, sk.trail, 0.22, 0.32, 0, P.speed * 0.72);
        }
    }

    // world upkeep
    while (nextRowY < P.y + VIEW_AHEAD) spawnRow();
    const zShip = HOVER + P.jz;
    for (const o of objects) {
        if (o.dead) continue;
        if (o.t === "slider") o.x = o.base + o.amp * Math.sin(time * o.freq + o.ph);
        if (!P.alive || (state !== "play" && state !== "title")) continue;
        const dy = o.y - P.y;
        if (o.t === "orb" || o.t === "power") {
            if (run.magnet > 0 && o.t === "orb" && dy < 26 && dy > -2) {           // magnet pulls orbs in
                const k = Math.min(1, gdt * 9);
                o.x += (P.x - o.x) * k; o.z += (zShip + 0.3 - o.z) * k; o.y += (P.y - o.y) * k * 0.6;
            }
            if (Math.abs(dy) < 1.4 && Math.abs(o.x - P.x) < 1.3 && Math.abs(o.z - (zShip + 0.25)) < 1.4) (o.t === "orb" ? collectOrb : takePower)(o);
            continue;
        }
        if (o.t === "laser") {
            if (Math.abs(dy) < SHIP_L + 0.15 && zShip < 0.78) { hit(o); continue; }
            if (!o.passed && dy < -SHIP_L) {
                o.passed = true; run.jumps++;
                if (zShip < 1.25) nearMiss(o, "CLOSE JUMP");
            }
            continue;
        }
        // blocks & sliders
        const hw = o.w / 2 + SHIP_W, hd = o.d / 2 + SHIP_L;
        if (Math.abs(o.x - P.x) < hw && Math.abs(dy) < hd && zShip < o.h) { hit(o); continue; }
        if (!o.passed && dy < -hd) {
            o.passed = true;
            const gapX = Math.abs(o.x - P.x) - hw;
            if (gapX < 0.75 && zShip < o.h) nearMiss(o, "CLOSE CALL");
        }
    }
    objects = objects.filter((o) => !o.dead && o.y > P.y - 20);

    // ambient speed dust
    if (P.alive) for (let i = 0; i < 3; i++) emit((rnd() * 2 - 1) * 14, P.y + 80 + rnd() * 60, 0.2 + rnd() * 4, 1, 0.2, pal.grid, 0.12, 2.2, 0, 0);
    updateParticles(gdt);

    // curves come and go
    bend.timer -= dt;
    if (bend.timer <= 0) {
        bend.timer = 3 + rnd() * 4;
        bend.tx = (rnd() * 2 - 1) * 0.0016 * Math.min(1, 0.4 + difficulty());
        bend.ty = -0.00012 - rnd() * 0.00045;
    }
    bend.x += (bend.tx - bend.x) * Math.min(1, dt * 0.6);
    bend.y += (bend.ty - bend.y) * Math.min(1, dt * 0.6);

    shake = Math.max(0, shake - dt * 2.2);
    flash = Math.max(0, flash - dt * 1.8);
    if (state === "play" && P.alive) checkMissions();
}

function skin() {
    const s = SKINS[save.skin] || SKINS[0];
    if (!s.rainbow) return s;
    const h = time * 0.35, c = (o) => 0.5 + 0.5 * Math.cos((h + o) * Math.PI * 2);
    const col = [c(0), c(0.33), c(0.66)];
    return { ...s, accent: col, trail: col };
}

// ------------------------------------------------------------------ rendering

function buildDynamic() {
    solid.reset(); glow.reset();
    const camPos = [cam.x, cam.y, cam.z];
    const y0 = Math.floor((cam.y - 6) / 20) * 20, y1 = cam.y + VIEW_AHEAD;
    const beat = audio.beat();
    const acc = pal.accent, grid = pal.grid, edge = pal.edge;

    // road + rails
    for (let y = y0; y < y1; y += 20) {
        solid.quad([-TRACK_HALF - 0.15, y, 0], [TRACK_HALF + 0.15, y, 0], [TRACK_HALF + 0.15, y + 20, 0], [-TRACK_HALF - 0.15, y + 20, 0], [0, 0, 0], 4);
        for (const s of [-1, 1]) box(solid, s * 6.62 - 0.1, y, 0, s * 6.62 + 0.1, y + 20, 0.22, [acc[0] * 1.3, acc[1] * 1.3, acc[2] * 1.3], null, null, 1);
    }
    for (let y = Math.floor(cam.y / 10) * 10; y < y1; y += 10)
        for (const s of [-1, 1]) sprite(glow, s * 6.62, y, 0.3, 0.8 + beat * 0.5, acc[0] * 0.6, acc[1] * 0.6, acc[2] * 0.6);

    // neon arches over the road
    for (let y = Math.ceil(cam.y / 90) * 90; y < y1; y += 90) {
        const c = [grid[0] * 1.3, grid[1] * 1.3, grid[2] * 1.3];
        box(solid, -8.4, y - 0.25, 0, -8.0, y + 0.25, 6.6, c, null, null, 1);
        box(solid, 8.0, y - 0.25, 0, 8.4, y + 0.25, 6.6, c, null, null, 1);
        box(solid, -8.4, y - 0.25, 6.3, 8.4, y + 0.25, 6.7, c, null, null, 1);
        for (const x of [-8.2, 0, 8.2]) sprite(glow, x, y, 6.5, 2.2 + beat * 1.5, grid[0] * 0.5, grid[1] * 0.5, grid[2] * 0.5);
    }

    // obstacles and pickups
    for (const o of objects) {
        if (o.y > y1 || o.y < cam.y - 4) continue;
        if (o.t === "block" || o.t === "slider") {
            const x0 = o.x - o.w / 2, x1 = o.x + o.w / 2, yy0 = o.y - o.d / 2, yy1 = o.y + o.d / 2;
            const base = o.t === "slider" ? pal.obst.map((v) => v * 0.7) : pal.obst;
            const rim = o.t === "slider" ? acc : edge;
            box(solid, x0, yy0, 0, x1, yy1, o.h, base, rim, camPos);
            const ec = rim.map((v) => v * (1.35 + beat * 0.35));
            boxEdges(solid, x0, yy0, 0, x1, yy1, o.h, ec, 0.06);
            sprite(glow, o.x, o.y, o.h + 0.1, 1.6, rim[0] * 0.35, rim[1] * 0.35, rim[2] * 0.35);
        } else if (o.t === "laser") {
            const f = 0.8 + 0.2 * Math.sin(time * 50 + o.y);
            for (const s of [-1, 1]) {
                box(solid, s * 6.95 - 0.2, o.y - 0.2, 0, s * 6.95 + 0.2, o.y + 0.2, 1.3, [0.12, 0.12, 0.16], edge, camPos);
                sprite(glow, s * 6.95, o.y, 1.35, 0.9, 1.0, 0.3, 0.3);
            }
            box(solid, -6.8, o.y - 0.06, 0.5, 6.8, o.y + 0.06, 0.62, [1.6 * f, 0.25 * f, 0.3 * f], null, null, 1);
            for (let x = -6.2; x <= 6.2; x += 1.25) sprite(glow, x, o.y, 0.56, 0.75, 0.9 * f, 0.1, 0.15);
        } else if (o.t === "orb") {
            const bob = Math.sin(time * 4 + o.y) * 0.12;
            gem(solid, o.x, o.y, o.z + bob, 0.3, time * 3 + o.y, [acc[0] * 1.2 + 0.3, acc[1] * 1.2 + 0.3, acc[2] * 1.2 + 0.3]);
            sprite(glow, o.x, o.y, o.z + bob, 1.0, acc[0] * 0.55, acc[1] * 0.55, acc[2] * 0.55);
        } else if (o.t === "power") {
            const c = POWERS[o.kind].color, bob = Math.sin(time * 3) * 0.2;
            gem(solid, o.x, o.y, o.z + bob, 0.55, time * 2, c, 1.3);
            sprite(glow, o.x, o.y, o.z + bob, 2.2, c[0] * 0.6, c[1] * 0.6, c[2] * 0.6);
            for (let k = 0; k < 3; k++) {
                const a = time * 3 + k * 2.094;
                sprite(glow, o.x + Math.cos(a) * 1.1, o.y + Math.sin(a) * 1.1, o.z + bob, 0.4, c[0], c[1], c[2]);
            }
            for (let z = 0; z < 6; z += 0.8) sprite(glow, o.x, o.y, z, 0.5, c[0] * 0.25, c[1] * 0.25, c[2] * 0.25);
        }
    }

    // the ship
    if (P.alive) {
        const sk = skin(), z = HOVER + P.jz + Math.sin(time * 6) * 0.04;
        const blink = P.invuln > 0 && Math.floor(time * 16) % 2 === 0;
        if (!blink) ship(solid, glow, P.x, P.y, z, P.roll, -P.vz * 0.02, sk, camPos, time);
        sprite(glow, P.x, P.y, 0.05, 1.8, sk.trail[0] * 0.25, sk.trail[1] * 0.25, sk.trail[2] * 0.25);    // light on the road
        if (run.shield) {
            const c = POWERS.shield.color, p = 0.8 + 0.2 * Math.sin(time * 6);
            sprite(glow, P.x, P.y, z + 0.3, 2.2 * p, c[0] * 0.35, c[1] * 0.35, c[2] * 0.35);
        }
        if (run.magnet > 0) {
            const c = POWERS.magnet.color;
            for (let k = 0; k < 4; k++) { const a = time * 5 + k * 1.57; sprite(glow, P.x + Math.cos(a) * 1.5, P.y + Math.sin(a) * 1.5, z + 0.3, 0.35, c[0], c[1], c[2]); }
        }
    }

    // particles
    const d = particles.d;
    for (let i = 0; i < particles.count; i++) {
        const o = i * 13, k = d[o + 6] / d[o + 7];
        sprite(glow, d[o], d[o + 1], d[o + 2], d[o + 8] * (0.4 + 0.6 * k), d[o + 9] * k, d[o + 10] * k, d[o + 11] * k);
    }

    // one upload: solid first, glow after
    const n = solid.n;
    while ((n + glow.n) * 4 > solid.pos.length) solid.grow();
    solid.pos.set(glow.pos.subarray(0, glow.n * 4), n * 4);
    solid.col.set(glow.col.subarray(0, glow.n * 4), n * 4);
    space.setDynamic(solid.pos, solid.col, n + glow.n);
    return { solidCount: n, glowCount: glow.n };
}

// world point (with the world bend applied) → CSS pixels; also used for the horizon and popups
function bent(x, y, z) {
    const d = Math.max(0, y - cam.y);
    return [x + bend.x * d * d, y, z + bend.y * d * d];
}
function project(x, y, z) {
    const [bx, by, bz] = bent(x, y, z);
    const X = space.xUnitVec, Y = space.yUnitVec, Z = space.zUnitVec;
    const dx = bx - space.Xc, dy = by - space.Yc, dz = bz - space.Zc;
    const zp = dx * Z[0] + dy * Z[1] + dz * Z[2];
    if (zp < 0.1) return null;
    const k = cam.fov / 1.6 / zp;
    return [-(dx * X[0] + dy * X[1] + dz * X[2]) * k, (dx * Y[0] + dy * Y[1] + dz * Y[2]) * k * (canvas.width / canvas.height)];
}

function render() {
    // chase camera
    const sp = Math.min(1, (P.speed - 34) / 50);
    const tx = P.x * 0.55, tz = 3.0 + P.jz * 0.35;
    cam.x += (tx - cam.x) * 0.12;
    cam.z += (tz - cam.z) * 0.1;
    cam.y = P.y - 7.6 - sp * 1.2;
    cam.fov += ((1.72 - sp * 0.38 - (run.double > 0 ? 0.05 : 0)) - cam.fov) * 0.05;
    const sx = (rnd() - 0.5) * shake * 0.6, sz = (rnd() - 0.5) * shake * 0.6;
    space.magnifier = cam.fov;
    space.lookAt(cam.x + sx, cam.y, cam.z + sz, P.x * 0.8 + sx, P.y + 14, 0.8 + P.jz * 0.2 + sz);

    const { solidCount, glowCount } = buildDynamic();

    // horizon & sun position from the far edge of the landscape
    const far = project(cam.x, cam.y + 440, 0) || [0, 0];
    gl.uniform1f(U.aspect, canvas.width / canvas.height);
    gl.uniform3f(U.veriables, space.zShifter, space.magnifier, 0);
    gl.uniform2f(U.uBend, bend.x, bend.y);
    gl.uniform1f(U.uGroundSnap, Math.floor(cam.y / 4) * 4);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, time);
    gl.uniform1f(U.uBeat, audio.beat());
    gl.uniform1f(U.uHorizon, Math.max(0.05, Math.min(0.95, (far[1] + 1) / 2)));
    gl.uniform1f(U.uSunX, Math.max(-0.4, Math.min(0.4, far[0] / 2)));
    gl.uniform1f(U.uFlash, flash * flash);
    gl.uniform3fv(U.uSkyTop, pal.skyTop);
    gl.uniform3fv(U.uSkyHorizon, pal.skyHorizon);
    gl.uniform3fv(U.uSun1, pal.sun1);
    gl.uniform3fv(U.uSun2, pal.sun2);
    gl.uniform3fv(U.uGrid, pal.grid);
    gl.uniform3fv(U.uAccent, pal.accent);
    gl.uniform3fv(U.uGround, pal.ground);
    space.applyCamera();

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    space.bind(false);
    space.draw(0, space.staticCount);                 // sky + landscape
    space.bind(true);
    space.draw(0, solidCount);                        // road, crystals, ship
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    space.draw(solidCount, glowCount);                // glow
    gl.depthMask(true);
    gl.disable(gl.BLEND);
}

// ------------------------------------------------------------------ UI

const $ = (id) => document.getElementById(id);
const popLayer = $("popups");

function popupAt(x, y, z, text, kind) {
    const p = project(x, y, z);
    if (!p || popLayer.childElementCount > 14) return;
    const el = document.createElement("div");
    el.className = `pop ${kind}`;
    el.textContent = text;
    el.style.left = `${(p[0] + 1) / 2 * innerWidth}px`;
    el.style.top = `${(1 - p[1]) / 2 * innerHeight}px`;
    popLayer.appendChild(el);
    setTimeout(() => el.remove(), 950);
}

let bannerTimer = 0;
function setBanner(title, sub) {
    const b = $("banner");
    b.querySelector("h2").textContent = title;
    b.querySelector("p").textContent = sub || "";
    b.classList.remove("show"); void b.offsetWidth; b.classList.add("show");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => b.classList.remove("show"), 2600);
}

let toastTimer = 0;
function toast(t) {
    const el = $("toast");
    el.textContent = t; el.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 1200);
}

const ui = {
    show(which) {
        for (const id of ["title", "hud", "over", "pause"]) $(id).classList.toggle("hidden", id !== which && !(id === "hud" && which === "pause"));
        if (which === "title") this.title();
    },
    pulse(id) { const el = $(id); el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse"); },

    missionsHTML(live) {
        return save.missions.map((m) => {
            const target = missionTarget(m), def = MISSIONS[m.id];
            const cur = live ? Math.min(target, ({ orbs: run.orbs, dist: Math.floor(run.dist), near: run.near, maxMult: run.maxMult, jumps: run.jumps, powers: run.powers, score: Math.floor(run.score) })[def.stat] || 0) : 0;
            return `<div class="mission"><div class="mt">${def.text(target)}</div><div class="mr">+${missionReward(m)} ◆</div>` +
                (live ? `<div class="mbar"><i style="width:${(cur / target * 100).toFixed(0)}%"></i></div>` : "") + `</div>`;
        }).join("");
    },

    title() {
        $("t-best").textContent = save.best.toLocaleString();
        $("t-orbs").textContent = save.lifetime.toLocaleString();
        $("t-missions").innerHTML = this.missionsHTML(false);
        const box = $("t-skins");
        box.innerHTML = "";
        SKINS.forEach((s, i) => {
            const open = save.lifetime >= s.need;
            const b = document.createElement("button");
            b.className = "skin" + (i === save.skin ? " sel" : "") + (open ? "" : " locked");
            const c = s.rainbow ? "conic-gradient(#f0f,#0ff,#ff0,#f0f)" : `rgb(${s.accent.map((v) => Math.round(v * 255))})`;
            b.innerHTML = `<i style="background:${c}"></i><span>${s.name}</span><small>${open ? (i === save.skin ? "selected" : "select") : `◆ ${s.need}`}</small>`;
            b.onclick = (e) => { e.stopPropagation(); if (!open) { toast(`Collect ${s.need.toLocaleString()} orbs in total to unlock`); return; } save.skin = i; persist(); this.title(); };
            box.appendChild(b);
        });
    },

    hud() {
        $("score").textContent = Math.floor(run.score).toLocaleString();
        $("mult").textContent = `x${run.mult}`;
        $("mult").style.opacity = run.mult > 1 ? 1 : 0.45;
        $("combo").style.width = `${Math.max(0, run.comboTimer / 3.2) * 100}%`;
        $("dist").textContent = `${Math.floor(run.dist).toLocaleString()} m`;
        $("orbs").textContent = run.orbs;
        $("zone").textContent = `ZONE ${run.zone + 1} · ${PALETTES[palTo].name}`;
        $("best").textContent = `BEST ${Math.max(save.best, Math.floor(run.score)).toLocaleString()}`;
        const pw = [];
        if (run.shield) pw.push(`<span class="pw" style="--c:#4ff">SHIELD</span>`);
        if (run.magnet > 0) pw.push(`<span class="pw" style="--c:#b6f">MAGNET ${run.magnet.toFixed(0)}s</span>`);
        if (run.double > 0) pw.push(`<span class="pw" style="--c:#fd4">2X ${run.double.toFixed(0)}s</span>`);
        $("powers").innerHTML = pw.join("");
    },

    gameOver({ score, newBest, unlocked }) {
        this.show("over");
        $("o-score").textContent = score.toLocaleString();
        $("o-best").textContent = newBest ? "NEW BEST!" : `Best ${save.best.toLocaleString()}`;
        $("o-best").classList.toggle("newbest", newBest);
        $("o-stats").innerHTML =
            `<div><b>${Math.floor(run.dist).toLocaleString()} m</b><span>distance</span></div>` +
            `<div><b>${run.orbs}</b><span>orbs</span></div>` +
            `<div><b>${run.near}</b><span>close calls</span></div>` +
            `<div><b>x${run.maxMult}</b><span>best multiplier</span></div>`;
        const extra = [];
        run.completed.forEach((t) => extra.push(`<div class="done">✓ ${t}</div>`));
        unlocked.forEach((n) => extra.push(`<div class="unlock">New ship unlocked: ${n}!</div>`));
        const nextSkin = SKINS.find((s) => s.need > save.lifetime);
        if (nextSkin) extra.push(`<div class="next">◆ ${save.lifetime.toLocaleString()} / ${nextSkin.need.toLocaleString()} orbs to unlock <b>${nextSkin.name}</b></div>`);
        $("o-extra").innerHTML = extra.join("");
        $("o-missions").innerHTML = this.missionsHTML(true);
    },
};

$("title").addEventListener("click", () => startGame());
$("o-retry").addEventListener("click", (e) => { e.stopPropagation(); startGame(); });
$("o-menu").addEventListener("click", (e) => { e.stopPropagation(); state = "title"; audio.intensity = 0; resetRun(true); ui.show("title"); });
$("p-resume").addEventListener("click", (e) => { e.stopPropagation(); resume(); });

// ------------------------------------------------------------------ loop

resetRun(true);
update(0);
ui.show("title");

let last = performance.now();
function frame(now) {
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    if (state !== "paused") update(dt);
    render();
    if (state === "play" || state === "paused") ui.hud();
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
