// Starsling levels: bodies, gravity simulation and a level generator that proves every level can be solved.
//
// The play field is the XY plane (Z up). Bodies pull the comet with G·m/d². Moons orbit their planet, but only
// while the comet is flying (flight time t), so aiming is calm and every launch is deterministic.
// The generator places planets (plus moons, black holes and asteroid belts on later levels), then test-fires a
// few hundred shots. Only layouts with a working shot are kept, and the 3 stars are placed along that path —
// so every level is solvable with all three stars.

export const G = 9;
export const BOUNDS = { x: 22, y: 14 };
export const MAX_FLIGHT = 14;
export const MAX_SPEED = 14;
export const PORTAL_R = 0.95, STAR_R = 0.6, COMET_R = 0.18;
export const TYPES = { GAS: 0, ROCK: 1, ICE: 2, LAVA: 3, OCEAN: 4, MOON: 5, HOLE: 6 };

export function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// where a body is at flight time t (moons orbit a parent)
export function bodyPos(level, b, t) {
    if (b.parent === undefined) return [b.x, b.y];
    const p = level.bodies[b.parent];
    const a = b.phase + b.omega * t;
    return [p.x + Math.cos(a) * b.orbit, p.y + Math.sin(a) * b.orbit];
}

// one integration step for the comet state s = {x, y, vx, vy, t}; returns null or an outcome
export function step(level, s, dt) {
    let ax = 0, ay = 0;
    for (const b of level.bodies) {
        const [bx, by] = bodyPos(level, b, s.t);
        const dx = bx - s.x, dy = by - s.y, d2 = dx * dx + dy * dy;
        const d = Math.sqrt(d2);
        if (d < b.r + COMET_R * (b.type === TYPES.HOLE ? 0 : 1)) return { hit: b };
        const a = (G * b.m) / (d2 + 0.05);
        ax += (a * dx) / d; ay += (a * dy) / d;
    }
    for (const rock of level.rocks) {                       // asteroid belts: many small rocks on a ring
        const p = level.bodies[rock.parent];
        const ang = rock.phase + rock.omega * s.t;
        const rx = p.x + Math.cos(ang) * rock.orbit, ry = p.y + Math.sin(ang) * rock.orbit;
        if ((rx - s.x) ** 2 + (ry - s.y) ** 2 < (rock.r + COMET_R) ** 2) return { hitRock: rock };
    }
    s.vx += ax * dt; s.vy += ay * dt;
    s.x += s.vx * dt; s.y += s.vy * dt;
    s.t += dt;
    if ((s.x - level.portal.x) ** 2 + (s.y - level.portal.y) ** 2 < PORTAL_R * PORTAL_R) return { win: true };
    if (Math.abs(s.x) > BOUNDS.x || Math.abs(s.y) > BOUNDS.y || s.t > MAX_FLIGHT) return { lost: true };
    return null;
}

// fly a whole shot; returns { outcome, path } (path sampled every few steps)
export function simulate(level, vx, vy, record = false) {
    const s = { x: level.start.x, y: level.start.y, vx, vy, t: 0 };
    const path = record ? [[s.x, s.y]] : null;
    const dt = 1 / 120;
    for (let i = 0; i < MAX_FLIGHT * 120 + 5; i++) {
        const r = step(level, s, dt);
        if (record && i % 3 === 0) path.push([s.x, s.y]);
        if (r) return { outcome: r, path, t: s.t };
    }
    return { outcome: { lost: true }, path, t: s.t };
}

// ------------------------------------------------------------------ generator

const PLANET_LOOKS = [
    { type: TYPES.GAS, a: [0.95, 0.72, 0.45], b: [0.7, 0.35, 0.2], atmo: [1.0, 0.7, 0.4] },
    { type: TYPES.GAS, a: [0.55, 0.75, 1.0], b: [0.25, 0.35, 0.75], atmo: [0.5, 0.75, 1.0] },
    { type: TYPES.OCEAN, a: [0.12, 0.35, 0.8], b: [0.3, 0.62, 0.3], atmo: [0.45, 0.75, 1.0] },
    { type: TYPES.LAVA, a: [0.16, 0.1, 0.1], b: [1.0, 0.45, 0.08], atmo: [1.0, 0.4, 0.15] },
    { type: TYPES.ICE, a: [0.85, 0.93, 1.0], b: [0.5, 0.7, 0.9], atmo: [0.7, 0.9, 1.0] },
    { type: TYPES.ROCK, a: [0.62, 0.5, 0.42], b: [0.38, 0.3, 0.26], atmo: [0.9, 0.75, 0.6] },
    { type: TYPES.GAS, a: [0.85, 0.55, 0.9], b: [0.45, 0.25, 0.6], atmo: [0.85, 0.55, 1.0] },
];

export function generate(levelNo) {
    for (let attempt = 0; attempt < 60; attempt++) {
        const rng = mulberry32(levelNo * 104729 + attempt * 7919 + 17);
        const L = makeLayout(levelNo, rng);
        const sol = solve(L, rng);
        if (!sol) continue;
        // stars along the found path, a little away from the ends
        const p = sol.path, n = p.length;
        L.stars = [0.3, 0.55, 0.78].map((f) => { const q = p[Math.floor(f * (n - 1))]; return { x: q[0], y: q[1], got: false }; });
        L.solution = sol;
        return L;
    }
    // (practically never reached) an empty, trivially solvable level
    const L = { bodies: [], rocks: [], start: { x: -12, y: 0 }, portal: { x: 12, y: 0 } };
    L.stars = [-4, 0, 4].map((x) => ({ x, y: 0, got: false }));
    return L;
}

function makeLayout(lv, rng) {
    const L = { no: lv, bodies: [], rocks: [] };
    L.start = { x: -13, y: (rng() - 0.5) * 9 };
    L.portal = { x: 13, y: (rng() - 0.5) * 9 };
    const nPlanets = Math.min(5, 1 + Math.floor((lv + 1) / 2)) + (rng() < 0.3 ? 1 : 0);
    const clear = (x, y, r) =>
        Math.hypot(x - L.start.x, y - L.start.y) > r + 3.2 && Math.hypot(x - L.portal.x, y - L.portal.y) > r + 3 &&
        L.bodies.every((b) => Math.hypot(x - b.x, y - b.y) > r + b.r + (b.orbitSpace || 0) + 1.6);
    // the first planet sits near the straight line, so the easy shot is blocked
    for (let i = 0, tries = 0; i < nPlanets && tries < 200; tries++) {
        const r = 0.8 + rng() * (i === 0 ? 1.6 : 1.3);
        let x, y;
        if (i === 0) { const f = 0.35 + rng() * 0.3; x = L.start.x + (L.portal.x - L.start.x) * f; y = L.start.y + (L.portal.y - L.start.y) * f + (rng() - 0.5) * 1.5; }
        else { x = (rng() - 0.5) * 20; y = (rng() - 0.5) * 18; }
        if (!clear(x, y, r)) continue;
        const look = PLANET_LOOKS[Math.floor(rng() * PLANET_LOOKS.length)];
        const b = { x, y, r, m: r * r * r * (0.8 + rng() * 0.5), ...look, spin: (rng() - 0.5) * 0.6, tilt: (rng() - 0.5) * 0.8, seed: rng() * 100, ringed: look.type === TYPES.GAS && rng() < 0.55 };
        L.bodies.push(b);
        i++;
    }
    // a black hole (level 5+)
    if (lv >= 5 && rng() < 0.75) {
        for (let tries = 0; tries < 120; tries++) {
            const x = (rng() - 0.5) * 20, y = (rng() - 0.5) * 18;
            if (clear(x, y, 1.1)) { L.bodies.push({ type: TYPES.HOLE, x, y, r: 0.42, m: 9 + lv * 0.25, a: [0, 0, 0], b: [0, 0, 0], atmo: [1, 0.6, 0.3], spin: 0, tilt: 0, seed: 0 }); break; }
        }
    }
    // moons (level 3+)
    if (lv >= 3) {
        const hosts = L.bodies.filter((b) => b.r > 1.1);
        const nm = Math.min(hosts.length, 1 + Math.floor((lv - 3) / 4));
        for (let k = 0; k < nm; k++) {
            const host = hosts[k], idx = L.bodies.indexOf(host);
            const orbit = host.r + 1.3 + rng() * 1.2;
            host.orbitSpace = orbit - host.r + 0.5;
            L.bodies.push({ type: TYPES.MOON, parent: idx, orbit, omega: (0.6 + rng() * 0.7) * (rng() < 0.5 ? -1 : 1), phase: rng() * 6.28, r: 0.32 + rng() * 0.15, m: 0.25, a: [0.75, 0.74, 0.72], b: [0.45, 0.44, 0.43], atmo: [0.8, 0.8, 0.85], spin: 0.3, tilt: 0, seed: rng() * 100 });
        }
    }
    // an asteroid belt around one planet (level 7+)
    if (lv >= 7) {
        const host = L.bodies.find((b) => b.type !== TYPES.HOLE && b.parent === undefined && !b.orbitSpace);
        if (host) {
            const idx = L.bodies.indexOf(host), orbit = host.r + 1.1, n = 14 + Math.floor(rng() * 8);
            const omega = 0.35 * (rng() < 0.5 ? -1 : 1);
            for (let k = 0; k < n; k++) if (rng() < 0.8) L.rocks.push({ parent: idx, orbit: orbit + (rng() - 0.5) * 0.35, phase: (k / n) * 6.28, omega, r: 0.13 + rng() * 0.1, seed: rng() * 100 });
            host.orbitSpace = 1.8;
        }
    }
    return L;
}

// test-fire shots; prefer ones that really use gravity (not nearly straight)
function solve(L, rng) {
    let best = null;
    const base = Math.atan2(L.portal.y - L.start.y, L.portal.x - L.start.x);
    for (let i = 0; i < 520; i++) {
        const ang = base + (rng() - 0.5) * 2.6, spd = 4 + rng() * (MAX_SPEED - 4);
        const r = simulate(L, Math.cos(ang) * spd, Math.sin(ang) * spd, true);
        if (!r.outcome.win) continue;
        // how much does it bend? (path length vs straight distance)
        let len = 0;
        for (let k = 1; k < r.path.length; k++) len += Math.hypot(r.path[k][0] - r.path[k - 1][0], r.path[k][1] - r.path[k - 1][1]);
        const bend = len / Math.hypot(L.portal.x - L.start.x, L.portal.y - L.start.y);
        const score = bend + rng() * 0.05;
        if (!best || score > best.score) best = { ang, spd, path: r.path, score };
        if (best.score > 1.35 && i > 200) break;
    }
    return best;
}
