// Hex tiles: coordinates, random tile generation, the tile mesh (with decorations) and region flood fill.
//
// Pointy-top hexes of circumradius 1 on the XY plane (Z up). Axial coordinates (q, r).
// Edge i faces direction 60°·i and touches neighbour DIRS[i]; the opposite edge is (i + 3) % 6.
// A tile = 6 edge terrains + a centre "hub". Geometry: hub hexagon + 6 trapezoid sectors (one per edge).

export const T = { MEADOW: 0, FOREST: 1, FIELD: 2, VILLAGE: 3, WATER: 4 };
export const TYPE_NAMES = ["Meadow", "Forest", "Wheat", "Village", "River"];
export const TYPE_COLORS = ["#7ed957", "#2f8a3a", "#f2c14e", "#d9a07a", "#3cc6e0"];
export const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const SQ3 = Math.sqrt(3);
export const HUB = 0.3;                 // hub size (fraction of the tile radius)
export const LAND_Z = 0.32, WATER_Z = 0.2, BASE_Z = -0.45;

export const hexKey = (q, r) => `${q},${r}`;
export const hexCenter = (q, r) => [SQ3 * (q + r / 2), 1.5 * r];
export function pixelToHex(x, y) {
    const q = (SQ3 / 3 * x - y / 3), r = (2 / 3) * y;
    // cube rounding
    let cx = q, cz = r, cy = -cx - cz;
    let rx = Math.round(cx), ry = Math.round(cy), rz = Math.round(cz);
    const dx = Math.abs(rx - cx), dy = Math.abs(ry - cy), dz = Math.abs(rz - cz);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;
    return [rx, rz];
}
// corner i sits at angle 60°·i − 30°, so edge i (between corners i and i+1) faces 60°·i
export const corner = (i, s = 1) => { const a = (Math.PI / 3) * i - Math.PI / 6; return [Math.cos(a) * s, Math.sin(a) * s]; };

export function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ------------------------------------------------------------------ tile generation

export function hubType(edges) {
    const counts = [0, 0, 0, 0, 0];
    edges.forEach((e) => counts[e]++);
    if (counts[T.WATER] >= 2) return T.WATER;
    let best = T.MEADOW;
    counts.forEach((c, t) => { if (t !== T.WATER && c > counts[best]) best = t; });
    return best;
}

export function randomTile(rng) {
    const pickLand = () => { const r = rng(); return r < 0.3 ? T.MEADOW : r < 0.6 ? T.FOREST : r < 0.82 ? T.FIELD : T.VILLAGE; };
    let edges;
    const r = rng();
    if (r < 0.14) {                                                 // a river through the tile
        const a = Math.floor(rng() * 6), b = (a + (rng() < 0.55 ? 3 : rng() < 0.5 ? 2 : 4)) % 6;
        const l1 = pickLand(), l2 = rng() < 0.5 ? l1 : pickLand();
        edges = Array.from({ length: 6 }, (_, i) => i === a || i === b ? T.WATER : ((i - a + 6) % 6 < (b - a + 6) % 6 ? l1 : l2));
    } else if (r < 0.2) {                                           // a little lake coast
        const a = Math.floor(rng() * 6), n = 2 + Math.floor(rng() * 2), land = pickLand();
        edges = Array.from({ length: 6 }, (_, i) => ((i - a + 6) % 6 < n ? T.WATER : land));
    } else {                                                        // 1 to 3 contiguous land runs
        const k = rng() < 0.3 ? 1 : rng() < 0.65 ? 2 : 3;
        const types = [];
        while (types.length < k) { const t = pickLand(); if (!types.includes(t) || types.length >= 3) types.push(t); }
        const lens = k === 1 ? [6] : k === 2 ? (() => { const a = 1 + Math.floor(rng() * 5); return [a, 6 - a]; })()
            : (() => { const a = 1 + Math.floor(rng() * 4), b = 1 + Math.floor(rng() * (5 - a)); return [a, b, 6 - a - b]; })();
        edges = [];
        lens.forEach((l, i) => { for (let j = 0; j < l; j++) edges.push(types[i]); });
        const off = Math.floor(rng() * 6);
        edges = edges.map((_, i) => edges[(i + off) % 6]);
    }
    return { edges, seed: Math.floor(rng() * 1e9) };
}

export const rotated = (tile, steps) => ({ ...tile, edges: tile.edges.map((_, i) => tile.edges[(i - steps + 60) % 6]) });

// ------------------------------------------------------------------ geometry

const FLOOR = [[0.5, 0.76, 0.32], [0.27, 0.5, 0.22], [0.9, 0.74, 0.32], [0.72, 0.67, 0.56], [0, 0, 0]];
const SIDE_TOP = [0.38, 0.55, 0.26], SIDE_SOIL = [0.52, 0.38, 0.26], SIDE_ROCK = [0.42, 0.36, 0.32];
const ROOFS = [[0.78, 0.3, 0.24], [0.3, 0.45, 0.72], [0.36, 0.56, 0.32], [0.62, 0.4, 0.62]];

// writes a tile. mesh: Mesh from main; opts: { ghost, spin (extra rotation, radians), lift (z offset) }
// Returns chimney tops (for smoke) in world coordinates.
export function buildTile(mesh, tile, q, r, opts = {}) {
    const [cx, cy] = hexCenter(q, r);
    const spin = opts.spin || 0, lift = opts.lift || 0, ghost = !!opts.ghost;
    const cs = Math.cos(spin), sn = Math.sin(spin);
    const W = (x, y, z) => [cx + x * cs - y * sn, cy + x * sn + y * cs, z + lift];     // local → world
    const SOLID = ghost ? 6 : 0, FOL = ghost ? 6 : 1, WATER = ghost ? 6 : 2;
    const hub = hubType(tile.edges);
    const hz = (t) => (t === T.WATER ? WATER_Z : LAND_Z);
    const chimneys = [];

    const tri = (a, b, c, col, mat, w = 1) => mesh.tri(W(...a), W(...b), W(...c), col, mat, w);
    const quad = (a, b, c, d, col, mat, w = 1) => { tri(a, b, c, col, mat, w); tri(a, c, d, col, mat, w); };
    const tint = mulberry32(tile.seed ^ 0x5bd1e995);
    const top = (t, pts) => {                         // a flat polygon (fan) of terrain t, slightly varied in colour
        const k = 0.93 + tint() * 0.14;
        const z = hz(t), col = t === T.WATER ? [0.3, 0.8, 0.8] : FLOOR[t].map((c) => c * k), mat = t === T.WATER ? WATER : SOLID;
        for (let i = 1; i + 1 < pts.length; i++) tri([...pts[0], z], [...pts[i], z], [...pts[i + 1], z], col, mat, t === T.WATER ? 1.2 : 1);
    };
    const wall = (p0, p1, zLow, zHigh, col) => quad([...p0, zLow], [...p1, zLow], [...p1, zHigh], [...p0, zHigh], col, SOLID);

    const O = (i) => corner(i % 6, 1), H = (i) => corner(i % 6, HUB);

    // hub + sectors
    top(hub, [0, 1, 2, 3, 4, 5].map(H));
    for (let i = 0; i < 6; i++) top(tile.edges[i], [H(i), O(i), O(i + 1), H(i + 1)]);

    // little cliffs where land meets water inside the tile
    for (let i = 0; i < 6; i++) {
        const a = tile.edges[i], b = tile.edges[(i + 1) % 6];
        if ((a === T.WATER) !== (b === T.WATER)) wall(H(i + 1), O(i + 1), WATER_Z - 0.02, LAND_Z, SIDE_TOP);
        if ((a === T.WATER) !== (hub === T.WATER)) wall(H(i), H(i + 1), WATER_Z - 0.02, LAND_Z, SIDE_TOP);
    }
    // outer sides: a grassy lip over soil and rock, down into the sea
    for (let i = 0; i < 6; i++) {
        const zt = hz(tile.edges[i]);
        wall(O(i), O(i + 1), zt - 0.1, zt, SIDE_TOP);
        wall(O(i), O(i + 1), 0.0, zt - 0.1, SIDE_SOIL);
        wall(O(i), O(i + 1), BASE_Z, 0.0, SIDE_ROCK);
    }

    // decorations, deterministic per tile and sector
    const rng = mulberry32(tile.seed);
    const inSector = (i, m = 0.12) => {                   // a random point inside sector i (away from its edges)
        let u = rng(), v = rng();
        const h0 = H(i), h1 = H(i + 1), o0 = O(i), o1 = O(i + 1);
        u = m + u * (1 - 2 * m); v = m + v * (1 - 2 * m);
        const a = [h0[0] + (h1[0] - h0[0]) * u, h0[1] + (h1[1] - h0[1]) * u];
        const b = [o0[0] + (o1[0] - o0[0]) * u, o0[1] + (o1[1] - o0[1]) * u];
        return [a[0] + (b[0] - a[0]) * v, a[1] + (b[1] - a[1]) * v];
    };
    const deco = (t, pt) => {
        const [x, y] = pt, z = LAND_Z;
        if (t === T.FOREST) {
            const s = 0.75 + rng() * 0.5, g = 0.85 + rng() * 0.3;
            if (rng() < 0.65) pine(x, y, z, s, g); else round(x, y, z, s, g);
        } else if (t === T.FIELD) {
            wheat(x, y, z, 0.8 + rng() * 0.4);
        } else if (t === T.VILLAGE) {
            chimneys.push(house(x, y, z, rng() * Math.PI, Math.floor(rng() * 4)));
        } else if (t === T.MEADOW) {
            const k = rng();
            if (k < 0.06) sheep(x, y, z, rng() * 6.28);
            else if (k < 0.4) flower(x, y, z, [[1, 0.4, 0.45], [1, 0.92, 0.4], [1, 1, 1], [0.75, 0.55, 1]][Math.floor(rng() * 4)]);
            else if (k < 0.55) bush(x, y, z);
            else tuft(x, y, z);
        }
    };
    const counts = [9, 7, 9, 1, 3];
    for (let i = 0; i < 6; i++) {
        const t = tile.edges[i];
        if (t === T.WATER) continue;
        const n = t === T.VILLAGE ? (rng() < 0.6 ? 1 : 2) : counts[t];
        for (let k = 0; k < n; k++) deco(t, inSector(i, t === T.VILLAGE ? 0.25 : 0.12));
    }
    if (hub !== T.WATER && hub !== T.VILLAGE) for (let k = 0; k < (hub === T.MEADOW ? 1 : 2); k++) deco(hub, [(rng() - 0.5) * HUB, (rng() - 0.5) * HUB]);
    if (hub === T.VILLAGE) chimneys.push(house(0, 0, LAND_Z, rng() * Math.PI, Math.floor(rng() * 4), 1.25));

    // --- decoration models (local coordinates; W() places and spins them with the tile)
    function cone(x, y, z0, r, h, col, sides, mat, w0 = 0, w1 = 1) {
        for (let i = 0; i < sides; i++) {
            const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
            mesh.v(...W(x + Math.cos(a0) * r, y + Math.sin(a0) * r, z0), w0, col[0], col[1], col[2], mat);
            mesh.v(...W(x + Math.cos(a1) * r, y + Math.sin(a1) * r, z0), w0, col[0], col[1], col[2], mat);
            mesh.v(...W(x, y, z0 + h), w1, col[0] * 1.08, col[1] * 1.08, col[2] * 1.08, mat);
        }
    }
    function pine(x, y, z, s, g) {
        cone(x, y, z, 0.035 * s, 0.1 * s, [0.36, 0.23, 0.13], 4, SOLID);
        cone(x, y, z + 0.07 * s, 0.13 * s, 0.26 * s, [0.12 * g, 0.4 * g, 0.2 * g], 6, FOL, 0.2, 0.8);
        cone(x, y, z + 0.18 * s, 0.1 * s, 0.24 * s, [0.15 * g, 0.47 * g, 0.24 * g], 6, FOL, 0.6, 1.2);
    }
    function round(x, y, z, s, g) {
        cone(x, y, z, 0.03 * s, 0.14 * s, [0.4, 0.26, 0.14], 4, SOLID);
        const col = [0.28 * g, 0.58 * g, 0.2 * g], cz = z + 0.2 * s, rr = 0.12 * s;
        // a low-poly ball: two stacked 6-sided cones
        cone(x, y, cz, rr, rr * 1.1, col, 6, FOL, 0.7, 1.2);
        cone(x, y, cz, rr, -rr * 0.9, [col[0] * 0.85, col[1] * 0.85, col[2] * 0.85], 6, FOL, 0.7, 0.3);
    }
    function wheat(x, y, z, s) {
        for (let k = 0; k < 3; k++) {
            const ox = x + (rng() - 0.5) * 0.08, oy = y + (rng() - 0.5) * 0.08;
            cone(ox, oy, z, 0.028 * s, 0.17 * s, [0.95, 0.78 + rng() * 0.08, 0.35], 3, FOL, 0, 1);
        }
    }
    function flower(x, y, z, col) {
        cone(x, y, z, 0.012, 0.07, [0.3, 0.6, 0.25], 3, FOL, 0, 0.6);
        cone(x, y, z + 0.07, 0.03, 0.025, col, 5, FOL, 0.6, 0.7);
    }
    function bush(x, y, z) { cone(x, y, z, 0.06, 0.07, [0.35, 0.62, 0.26], 5, FOL, 0, 0.5); }
    function tuft(x, y, z) {                           // three blades of tall grass
        for (let k = 0; k < 3; k++) cone(x + (rng() - 0.5) * 0.05, y + (rng() - 0.5) * 0.05, z, 0.012, 0.06 + rng() * 0.05, [0.42, 0.7, 0.28], 3, FOL, 0, 1);
    }
    function sheep(x, y, z, a) {
        const c = Math.cos(a), s = Math.sin(a);
        const P = (dx, dy, dz) => [x + dx * c - dy * s, y + dx * s + dy * c, z + dz];
        boxL(P, -0.05, -0.03, 0.03, 0.05, 0.03, 0.08, [0.96, 0.95, 0.92]);
        boxL(P, 0.05, -0.02, 0.05, 0.09, 0.02, 0.09, [0.2, 0.18, 0.18]);
    }
    function house(x, y, z, a, hue, scale = 1) {
        const c = Math.cos(a), s = Math.sin(a), k = scale;
        const P = (dx, dy, dz) => [x + (dx * c - dy * s) * k, y + (dx * s + dy * c) * k, z + dz * k];
        const wallC = [[0.96, 0.9, 0.78], [0.9, 0.92, 0.95], [0.95, 0.84, 0.74], [0.92, 0.88, 0.8]][hue];
        boxL(P, -0.1, -0.075, 0, 0.1, 0.075, 0.13, wallC);
        const roof = ROOFS[hue];
        const a0 = P(-0.12, -0.095, 0.13), b0 = P(0.12, -0.095, 0.13), c0 = P(0.12, 0.095, 0.13), d0 = P(-0.12, 0.095, 0.13);
        const r0 = P(-0.12, 0, 0.23), r1 = P(0.12, 0, 0.23);
        mesh.tri(W(...a0), W(...b0), W(...r1), roof, SOLID); mesh.tri(W(...a0), W(...r1), W(...r0), roof, SOLID);
        mesh.tri(W(...c0), W(...d0), W(...r0), roof, SOLID); mesh.tri(W(...c0), W(...r0), W(...r1), roof, SOLID);
        mesh.tri(W(...b0), W(...c0), W(...r1), wallC, SOLID); mesh.tri(W(...d0), W(...a0), W(...r0), wallC, SOLID);
        // glowing window on each long side, a chimney
        const win = ghost ? 6 : 4, wc = [1.3, 0.95, 0.55];
        for (const sy of [-0.0765, 0.0765]) {
            const q0 = P(-0.03, sy, 0.05), q1 = P(0.03, sy, 0.05), q2 = P(0.03, sy, 0.1), q3 = P(-0.03, sy, 0.1);
            mesh.tri(W(...q0), W(...q1), W(...q2), wc, win); mesh.tri(W(...q0), W(...q2), W(...q3), wc, win);
        }
        boxL(P, 0.05, 0.02, 0.15, 0.08, 0.05, 0.27, [0.55, 0.48, 0.45]);
        return W(...P(0.065, 0.035, 0.29));
    }
    function boxL(P, x0, y0, z0, x1, y1, z1, col) {
        const v = (a, b, c) => W(...P(a, b, c));
        const q = (a, b, c, d) => { mesh.tri(a, b, c, col, SOLID); mesh.tri(a, c, d, col, SOLID); };
        q(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1));
        q(v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1));
        q(v(x1, y1, z0), v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1));
        q(v(x0, y1, z0), v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1));
        q(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1));
    }
    return chimneys;
}

// ------------------------------------------------------------------ regions (for quests)

// size (in sectors) of the connected region of `type` that contains sector `start` of the tile at key k.
// Sectors of the same type connect inside a tile when they are neighbours or share a hub of that type,
// and across tiles when the facing edges match.
export function regionSize(board, k, start) {
    const t0 = board.get(k);
    if (!t0) return 0;
    const type = t0.tile.edges[start];
    const seen = new Set(), stack = [[k, start]];
    while (stack.length) {
        const [key, i] = stack.pop();
        const id = key + "#" + i;
        if (seen.has(id)) continue;
        const cell = board.get(key);
        if (!cell || cell.tile.edges[i] !== type) continue;
        seen.add(id);
        const e = cell.tile.edges;
        if (e[(i + 1) % 6] === type) stack.push([key, (i + 1) % 6]);
        if (e[(i + 5) % 6] === type) stack.push([key, (i + 5) % 6]);
        if (hubType(e) === type) for (let j = 0; j < 6; j++) if (e[j] === type) stack.push([key, j]);
        const [q, r] = key.split(",").map(Number), nk = hexKey(q + DIRS[i][0], r + DIRS[i][1]);
        stack.push([nk, (i + 3) % 6]);
    }
    return seen.size;
}
