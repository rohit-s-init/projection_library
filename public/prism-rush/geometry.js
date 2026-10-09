// Geometry builders for Prism Rush, writing straight into Space-format arrays:
// pos = (x, y, z, w), col = (r, g, b, material * 8). World: x right, y forward (the direction of travel), z up.

export const MAT = { SOLID: 0, GLOW: 1, GROUND: 2, SKY: 3, TRACK: 4, SPRITE: 6 };

export class Mesh {
    constructor(verts = 65536) {
        this.pos = new Float32Array(verts * 4);
        this.col = new Float32Array(verts * 4);
        this.n = 0;
    }
    reset() { this.n = 0; }
    grow() {
        const p = new Float32Array(this.pos.length * 2), c = new Float32Array(this.col.length * 2);
        p.set(this.pos); c.set(this.col);
        this.pos = p; this.col = c;
    }
    v(x, y, z, w, r, g, b, mat) {
        if ((this.n + 1) * 4 > this.pos.length) this.grow();
        const o = this.n * 4;
        this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z; this.pos[o + 3] = w;
        this.col[o] = r; this.col[o + 1] = g; this.col[o + 2] = b; this.col[o + 3] = mat * 8;
        this.n++;
    }
    tri(a, b, c, col, mat) {
        this.v(a[0], a[1], a[2], 1, col[0], col[1], col[2], mat);
        this.v(b[0], b[1], b[2], 1, col[0], col[1], col[2], mat);
        this.v(c[0], c[1], c[2], 1, col[0], col[1], col[2], mat);
    }
    quad(a, b, c, d, col, mat) { this.tri(a, b, c, col, mat); this.tri(a, c, d, col, mat); }
}

// ------------------------------------------------------------------ lighting done on the CPU (per face)

const L = norm([0.25, 0.55, 0.8]);                 // key light from the sun, ahead and above
function norm(v) { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; }
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// dark crystal body + coloured key light + a neon rim where the surface turns away from the camera
export function shade(n, base, accent, cam, p) {
    const d = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
    const V = norm(sub(cam, p));
    const nv = Math.abs(n[0] * V[0] + n[1] * V[1] + n[2] * V[2]);
    const rim = Math.pow(1 - nv, 2.5) * 1.3;
    const k = 0.25 + 0.75 * d;
    return [base[0] * k + accent[0] * rim, base[1] * k + accent[1] * rim, base[2] * k + accent[2] * rim];
}

// a shaded triangle; the normal is turned to point away from `center` (the middle of the object)
export function litTri(m, a, b, c, base, accent, cam, center) {
    let n = norm(cross(sub(b, a), sub(c, a)));
    const ctr = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const out = sub(ctr, center);
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) n = [-n[0], -n[1], -n[2]];
    m.tri(a, b, c, shade(n, base, accent, cam, ctr), MAT.SOLID);
}

// ------------------------------------------------------------------ shapes

// axis-aligned box, lit per face
export function box(m, x0, y0, z0, x1, y1, z1, base, accent, cam, mat = MAT.SOLID) {
    const faces = [
        [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
        [[-1, 0, 0], [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]]],
        [[0, 1, 0], [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]]],
        [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
        [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
    ];
    for (const [n, q] of faces) {
        if (mat === MAT.GLOW) { m.quad(q[0], q[1], q[2], q[3], base, MAT.GLOW); continue; }
        const ctr = [(x0 + x1) / 2 + n[0] * (x1 - x0) / 2, (y0 + y1) / 2 + n[1] * (y1 - y0) / 2, (z0 + z1) / 2 + n[2] * (z1 - z0) / 2];
        m.quad(q[0], q[1], q[2], q[3], shade(n, base, accent, cam, ctr), MAT.SOLID);
    }
}

// neon edges around a box: 4 vertical + 4 top edges
export function boxEdges(m, x0, y0, z0, x1, y1, z1, col, t = 0.07) {
    const bar = (a0, b0, c0, a1, b1, c1) => box(m, a0, b0, c0, a1, b1, c1, col, null, null, MAT.GLOW);
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) bar(x - t, y - t, z0, x + t, y + t, z1 + t);
    bar(x0 - t, y0 - t, z1 - t, x1 + t, y0 + t, z1 + t);
    bar(x0 - t, y1 - t, z1 - t, x1 + t, y1 + t, z1 + t);
    bar(x0 - t, y0 - t, z1 - t, x0 + t, y1 + t, z1 + t);
    bar(x1 - t, y0 - t, z1 - t, x1 + t, y1 + t, z1 + t);
}

// a camera-facing glow blob (drawn additively): 2 triangles, corners unpacked in the vertex shader
export function sprite(m, x, y, z, size, r, g, b) {
    for (const c of [0, 1, 2, 0, 2, 3]) m.v(x, y, z, size + c * 100, r, g, b, MAT.SPRITE);
}

// a spinning faceted gem (octahedron), faces alternately bright and dim
export function gem(m, x, y, z, s, spin, col, glow = 1) {
    const c = Math.cos(spin) * s, sn = Math.sin(spin) * s;
    const eq = [[x + c, y + sn, z], [x - sn, y + c, z], [x - c, y - sn, z], [x + sn, y - c, z]];
    const top = [x, y, z + s * 1.35], bot = [x, y, z - s * 1.35];
    for (let i = 0; i < 4; i++) {
        const a = eq[i], b = eq[(i + 1) % 4], k = (i % 2 ? 0.75 : 1.25) * glow;
        m.tri(top, a, b, [col[0] * k, col[1] * k, col[2] * k], MAT.GLOW);
        m.tri(bot, b, a, [col[0] * k * 0.6, col[1] * k * 0.6, col[2] * k * 0.6], MAT.GLOW);
    }
}

// the player's ship: a low-poly delta wing. Model space x right, y forward, z up; then banked, pitched, placed.
const SHIP = {
    nose: [0, 1.7, 0.22], top: [0, -0.2, 0.58], tail: [0, -1.05, 0.32], belly: [0, -0.3, 0.02],
    lw: [-1.25, -0.85, 0.1], rw: [1.25, -0.85, 0.1], lf: [-0.5, -1.0, 0.36], rf: [0.5, -1.0, 0.36],
    cock1: [0, 0.75, 0.42], cockL: [-0.2, 0.2, 0.5], cockR: [0.2, 0.2, 0.5],
};
export function ship(m, glow, x, y, z, roll, pitch, skin, cam, t) {
    const cr = Math.cos(roll), sr = Math.sin(roll), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const P = (v) => {
        // pitch about x, then roll about y
        let [a, b, c] = v;
        [b, c] = [b * cp - c * sp, b * sp + c * cp];
        [a, c] = [a * cr + c * sr, -a * sr + c * cr];
        return [x + a, y + b, z + c];
    };
    const S = Object.fromEntries(Object.entries(SHIP).map(([k, v]) => [k, P(v)]));
    const hull = skin.base, acc = skin.accent, mid = P([0, -0.2, 0.3]);
    for (const [a, b, c] of [["nose", "lw", "top"], ["nose", "top", "rw"], ["top", "lw", "lf"], ["top", "rf", "rw"],
        ["top", "lf", "tail"], ["top", "tail", "rf"], ["nose", "belly", "lw"], ["nose", "rw", "belly"],
        ["belly", "tail", "lw"], ["belly", "rw", "tail"], ["lw", "tail", "lf"], ["rw", "rf", "tail"]])
        litTri(m, S[a], S[b], S[c], hull, acc, cam, mid);
    // glowing cockpit and wing stripes
    m.tri(S.cock1, S.cockL, S.cockR, [acc[0] * 1.6, acc[1] * 1.6, acc[2] * 1.6], MAT.GLOW);
    const stripe = (a, b) => {
        const mid = (u, v, f) => [u[0] + (v[0] - u[0]) * f, u[1] + (v[1] - u[1]) * f, u[2] + (v[2] - u[2]) * f + 0.01];
        m.quad(mid(S.nose, a, 0.55), mid(S.nose, a, 0.62), mid(S.top, a, 0.62), mid(S.top, a, 0.55), skin.trail, MAT.GLOW);
    };
    stripe(S.lw, true); stripe(S.rw, false);
    // engines
    const pulse = 0.85 + 0.15 * Math.sin(t * 40);
    const e = skin.trail;
    for (const ex of [-0.32, 0.32]) {
        const p = P([ex, -1.08, 0.3]);
        sprite(glow, p[0], p[1], p[2], 0.55 * pulse, e[0] * 1.4, e[1] * 1.4, e[2] * 1.4);
        sprite(glow, p[0], p[1] - 0.2, p[2], 0.25, 1.5, 1.5, 1.5);
    }
}

// ------------------------------------------------------------------ static scene

// full-screen quad for the sky
export function skyQuad(m) {
    m.quad([-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], [0, 0, 0], MAT.SKY);
}

// the landscape grid: fixed local mesh, x ±w, y from -back to +ahead; the shader shifts it with the camera
// and raises the hills
export function groundGrid(m, w = 190, back = 40, ahead = 460, cell = 4) {
    for (let y = -back; y < ahead; y += cell)
        for (let x = -w; x < w; x += cell)
            m.quad([x, y, 0], [x + cell, y, 0], [x + cell, y + cell, 0], [x, y + cell, 0], [0, 0, 0], MAT.GROUND);
}
