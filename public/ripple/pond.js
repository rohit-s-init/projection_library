// Ripple: the pond. A 2D wave simulation on a height grid, plus the level generator.
//
// Water lives on a GW × GH grid (CELL units per cell) over the XY plane. Each step every water cell becomes
// (sum of its 4 neighbours) / 2 − its previous value, slightly damped — the classic ripple equation. Land and
// rocks are fixed at 0, so waves bounce off the shore. Floating things are pushed by "pulses": when a pebble
// drops, a ring travels outward at WAVE_SPEED and shoves whatever it passes, so the push matches the ripple
// you see.

export const GW = 128, GH = 86, CELL = 0.2;
export const X0 = -GW * CELL / 2, Y0 = -GH * CELL / 2;
export const WAVE_SPEED = 6.2;
export const BOAT_R = 0.38;

export function mulberry32(seed) {
    return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const cellOf = (x, y) => [Math.floor((x - X0) / CELL), Math.floor((y - Y0) / CELL)];
export const cellCenter = (i, j) => [X0 + (i + 0.5) * CELL, Y0 + (j + 0.5) * CELL];

export class Pond {
    constructor() {
        this.mask = new Uint8Array(GW * GH);       // 1 = water
        this.dist = new Float32Array(GW * GH);     // distance to land, in cells
        this.h0 = new Float32Array(GW * GH);
        this.h1 = new Float32Array(GW * GH);
        this.tex = new Uint8Array(GW * GH * 4);    // normals + shallowness + height, uploaded every frame
    }

    isWater(x, y) {
        const [i, j] = cellOf(x, y);
        return i >= 0 && j >= 0 && i < GW && j < GH && this.mask[j * GW + i] === 1;
    }
    clearance(x, y) {                               // distance to the nearest land (world units)
        const [i, j] = cellOf(x, y);
        if (i < 0 || j < 0 || i >= GW || j >= GH) return 0;
        return this.dist[j * GW + i] * CELL;
    }
    height(x, y) {
        const [i, j] = cellOf(x, y);
        if (i < 1 || j < 1 || i >= GW - 1 || j >= GH - 1) return 0;
        return this.h1[j * GW + i];
    }
    slope(x, y) {
        const [i, j] = cellOf(x, y);
        if (i < 1 || j < 1 || i >= GW - 1 || j >= GH - 1) return [0, 0];
        const k = j * GW + i, h = this.h1;
        return [(h[k + 1] - h[k - 1]) / (2 * CELL), (h[k + GW] - h[k - GW]) / (2 * CELL)];
    }

    // a pebble: push the surface down in a small disc
    drop(x, y, strength = 1.6, radius = 0.55) {
        const [ci, cj] = cellOf(x, y), rc = Math.ceil(radius / CELL);
        for (let j = cj - rc; j <= cj + rc; j++) for (let i = ci - rc; i <= ci + rc; i++) {
            if (i < 1 || j < 1 || i >= GW - 1 || j >= GH - 1) continue;
            const k = j * GW + i;
            if (!this.mask[k]) continue;
            const [px, py] = cellCenter(i, j), d = Math.hypot(px - x, py - y);
            if (d < radius) this.h1[k] -= strength * Math.cos((d / radius) * Math.PI / 2);
        }
    }

    step() {
        const a = this.h0, b = this.h1, m = this.mask;
        for (let j = 1; j < GH - 1; j++) for (let i = 1; i < GW - 1; i++) {
            const k = j * GW + i;
            if (!m[k]) { a[k] = 0; continue; }
            a[k] = ((b[k - 1] + b[k + 1] + b[k - GW] + b[k + GW]) * 0.5 - a[k]) * 0.986;
        }
        this.h0 = b; this.h1 = a;
    }

    // pack normals (R, G), shallowness (B) and height (A) into the texture the water shader reads
    pack() {
        const h = this.h1, t = this.tex;
        for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
            const k = j * GW + i, o = k * 4;
            const l = i > 0 ? h[k - 1] : 0, r = i < GW - 1 ? h[k + 1] : 0, d = j > 0 ? h[k - GW] : 0, u = j < GH - 1 ? h[k + GW] : 0;
            const nx = Math.max(-1, Math.min(1, -(r - l) * 1.6)), ny = Math.max(-1, Math.min(1, -(u - d) * 1.6));
            t[o] = (nx * 0.5 + 0.5) * 255; t[o + 1] = (ny * 0.5 + 0.5) * 255;
            t[o + 2] = Math.max(0, 1 - this.dist[k] / 9) * 255;
            t[o + 3] = Math.max(0, Math.min(1, h[k] * 0.6 + 0.5)) * 255;
        }
    }

    resetWater() { this.h0.fill(0); this.h1.fill(0); }

    computeDistances() {                            // BFS distance (in cells) from land into the water
        const D = this.dist, m = this.mask, q = [];
        for (let k = 0; k < GW * GH; k++) { if (!m[k]) { D[k] = 0; q.push(k); } else D[k] = 1e9; }
        for (let h = 0; h < q.length; h++) {
            const k = q[h], i = k % GW, j = (k / GW) | 0;
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ni = i + di, nj = j + dj;
                if (ni < 0 || nj < 0 || ni >= GW || nj >= GH) continue;
                const nk = nj * GW + ni;
                if (D[nk] > D[k] + 1) { D[nk] = D[k] + 1; q.push(nk); }
            }
        }
    }
}

// ------------------------------------------------------------------ levels

// pond outline: a soft superellipse with a wobbly edge
function insidePond(x, y, rng, wob) {
    const a = Math.atan2(y, x);
    const w = 1 + 0.06 * Math.sin(a * 3 + wob[0]) + 0.04 * Math.sin(a * 5 + wob[1]) + 0.03 * Math.sin(a * 9 + wob[2]);
    return Math.pow(Math.abs(x) / (11.6 * w), 2.6) + Math.pow(Math.abs(y) / (7.5 * w), 2.6) < 1;
}

export function generateLevel(pond, n) {
    for (let attempt = 0; attempt < 40; attempt++) {
        const rng = mulberry32(n * 9973 + attempt * 131 + 7);
        const wob = [rng() * 6.28, rng() * 6.28, rng() * 6.28];
        const rocks = [];
        const start = { x: -9.2, y: (rng() - 0.5) * 7 }, goal = { x: 9.2, y: (rng() - 0.5) * 7 };
        const nRocks = 2 + Math.min(7, Math.floor(n * 0.8)) + Math.floor(rng() * 2);
        for (let t = 0, tries = 0; t < nRocks && tries < 200; tries++) {
            const r = 0.55 + rng() * (0.6 + Math.min(0.8, n * 0.06));
            const x = (rng() - 0.5) * 15, y = (rng() - 0.5) * 11;
            if (Math.hypot(x - start.x, y - start.y) < r + 2.6 || Math.hypot(x - goal.x, y - goal.y) < r + 2.6) continue;
            if (rocks.some((o) => Math.hypot(x - o.x, y - o.y) < r + o.r + 1.4)) continue;
            rocks.push({ x, y, r, seed: rng() * 100 });
            t++;
        }
        // mask
        for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
            const [x, y] = cellCenter(i, j);
            let w = insidePond(x, y, rng, wob) && i > 1 && j > 1 && i < GW - 2 && j < GH - 2;
            if (w) for (const o of rocks) if (Math.hypot(x - o.x, y - o.y) < o.r) { w = false; break; }
            pond.mask[j * GW + i] = w ? 1 : 0;
        }
        pond.computeDistances();
        if (!pond.isWater(start.x, start.y) || !pond.isWater(goal.x, goal.y)) continue;
        // a channel wide enough for the boat must join start and goal
        const path = channel(pond, start, goal);
        if (!path) continue;
        // lotus flowers along the way, a little off the path
        const lotus = [0.3, 0.55, 0.78].map((f) => {
            const [x, y] = path[Math.floor(f * (path.length - 1))];
            return { x: x + (rng() - 0.5) * 1.2, y: y + (rng() - 0.5) * 1.2, got: false, open: 0 };
        }).map((l) => (pond.clearance(l.x, l.y) > 0.5 ? l : { ...l, x: l.x, y: l.y }));
        const lilies = [];
        for (let t = 0, tries = 0; t < 2 + Math.floor(n / 3) && tries < 100; tries++) {
            const x = (rng() - 0.5) * 16, y = (rng() - 0.5) * 11;
            if (pond.clearance(x, y) < 1.0 || Math.hypot(x - start.x, y - start.y) < 2.5 || Math.hypot(x - goal.x, y - goal.y) < 2) continue;
            lilies.push({ x, y, vx: 0, vy: 0, r: 0.55 + rng() * 0.3, a: rng() * 6.28, hits: new Set() });
            t++;
        }
        let len = 0;
        for (let k = 1; k < path.length; k++) len += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
        const stones = Math.max(4, Math.round(len / 3.6) + 3 - Math.floor(n / 4));
        return { n, rocks, start, goal, lotus, lilies, stones, path };
    }
    throw new Error("could not build a pond");
}

// BFS over water cells with enough clearance for the boat; returns a list of world points or null
function channel(pond, a, b) {
    const need = Math.ceil(BOAT_R / CELL) + 1;
    const [si, sj] = cellOf(a.x, a.y), [gi, gj] = cellOf(b.x, b.y);
    const prev = new Int32Array(GW * GH).fill(-1), seen = new Uint8Array(GW * GH);
    const q = [sj * GW + si];
    seen[q[0]] = 1;
    for (let h = 0; h < q.length; h++) {
        const k = q[h];
        if (k === gj * GW + gi) {
            const out = [];
            for (let c = k; c !== -1; c = prev[c]) out.push(cellCenter(c % GW, (c / GW) | 0));
            return out.reverse();
        }
        const i = k % GW, j = (k / GW) | 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nk = (j + dj) * GW + (i + di);
            if (seen[nk] || pond.dist[nk] < need) continue;
            seen[nk] = 1; prev[nk] = k; q.push(nk);
        }
    }
    return null;
}
