// Turns one chunk of blocks into triangles in Space's format: posArr (x, y, z, ao) and colArr (r, g, b, info).
//
// Only faces that touch air or a see-through block are emitted, so the inside of the terrain costs nothing.
//   pos.w   = ambient occlusion of that corner (1 open … 0.42 tucked into a corner); lighting itself happens in
//             the shader, from the face normal, the sun, the sky and the shadow map
//   col.rgb = the block's own colour (albedo)
//   col.a   = blockId * 8 + faceIndex, so the shader knows the material and the face direction
//
// Water and glass go into a separate "translucent" list, drawn after everything else with blending.
//
// Redstone parts: dust, torches, levers and buttons are small models (see emitPart); for them, and for lamps
// and gates, col.rgb carries the block's state instead of a colour, and the shader draws the look from it.

import { CHUNK, HEIGHT, B, BLOCKS, ID_SKY, isRedstone, isGate, shapeOf, isPistonPart } from "./world.js";
import { dustMask } from "./redstone.js";

// faceIndex: 0 +x, 1 -x, 2 +y, 3 -y, 4 +z (top), 5 -z (bottom)
// a = axis of the normal, s = its sign, u/v = the two axes spanning the face
const FACES = [
    { n: [1, 0, 0], a: 0, s: 1, u: 1, v: 2 },
    { n: [-1, 0, 0], a: 0, s: -1, u: 1, v: 2 },
    { n: [0, 1, 0], a: 1, s: 1, u: 0, v: 2 },
    { n: [0, -1, 0], a: 1, s: -1, u: 0, v: 2 },
    { n: [0, 0, 1], a: 2, s: 1, u: 0, v: 1 },
    { n: [0, 0, -1], a: 2, s: -1, u: 0, v: 1 },
];
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];
const AO_LIGHT = [0.42, 0.62, 0.8, 1.0];

const occludes = (id) => id !== B.AIR && id !== B.WATER && id !== B.GLASS && !shapeOf(id);
const seeThrough = (id) => id === B.AIR || id === B.WATER || id === B.GLASS || id === B.LEAVES || !!shapeOf(id) || isPistonPart(id);
const translucent = (id) => id === B.WATER || id === B.GLASS;

function showFace(id, nb) {
    if (nb === B.AIR) return true;
    return seeThrough(nb) && nb !== id;
}

function faceColor(id, f) {
    const b = BLOCKS[id];
    return f === 4 ? b.top : f === 5 ? b.bottom : b.side;
}

// state → colour channels, for blocks the shader draws from their state
function stateColor(world, x, y, z, id) {
    const m = world.getMeta(x, y, z);
    if (id === B.LAMP) return [m & 1, 0, 0];
    if (isGate(id)) return [(m >> 2) & 1, (m & 3) / 3, ((m >> 3) & 3) / 3];      // output, facing, inputs
    return [m & 1, 0, 0];
}

// a box in block-relative sixteenths, all six faces
function box(out, x, y, z, x0, y0, z0, x1, y1, z1, id, rgb) {
    const a = [x + x0 / 16, y + y0 / 16, z + z0 / 16], b = [x + x1 / 16, y + y1 / 16, z + z1 / 16];
    const quads = [
        [[b[0], a[1], a[2]], [b[0], b[1], a[2]], [b[0], b[1], b[2]], [b[0], a[1], b[2]]],
        [[a[0], a[1], a[2]], [a[0], b[1], a[2]], [a[0], b[1], b[2]], [a[0], a[1], b[2]]],
        [[a[0], b[1], a[2]], [b[0], b[1], a[2]], [b[0], b[1], b[2]], [a[0], b[1], b[2]]],
        [[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], a[1], b[2]], [a[0], a[1], b[2]]],
        [[a[0], a[1], b[2]], [b[0], a[1], b[2]], [b[0], b[1], b[2]], [a[0], b[1], b[2]]],
        [[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], b[1], a[2]], [a[0], b[1], a[2]]],
    ];
    quads.forEach((q, f) => {
        for (const i of [0, 1, 2, 0, 2, 3]) {
            out.pos.push(q[i][0], q[i][1], q[i][2], 1);
            out.col.push(rgb[0], rgb[1], rgb[2], id * 8 + f);
        }
    });
}

// a box given along a direction: `a0..a1` along the facing (in sixteenths, 16 = the front of the cell),
// `c0..c1` across it (same both ways)
const AXIS = [0, 1, 0, 1, 2, 2], SIGN = [1, 1, -1, -1, 1, -1];
function facedBox(out, x, y, z, facing, a0, a1, c0, c1, id, rgb) {
    const lo = [c0, c0, c0], hi = [c1, c1, c1], ax = AXIS[facing];
    if (SIGN[facing] > 0) { lo[ax] = a0; hi[ax] = a1; } else { lo[ax] = 16 - a1; hi[ax] = 16 - a0; }
    box(out, x, y, z, lo[0], lo[1], lo[2], hi[0], hi[1], hi[2], id, rgb);
}

// pistons: a full block, or when extended a shorter base; the head is a plate plus an arm reaching back into the base
// rgb = (extended, facing / 5, sticky) for the shader
function emitPiston(out, world, x, y, z, id) {
    const m = world.getMeta(x, y, z), f = m & 7;
    if (id === B.PISTON_HEAD) {
        const rgb = [1, f / 5, (m >> 3) & 1];
        facedBox(out, x, y, z, f, 12, 16, 0, 16, id, rgb);
        facedBox(out, x, y, z, f, -4, 12, 6, 10, id, rgb);
        return;
    }
    const ext = (m >> 3) & 1, rgb = [ext, f / 5, id === B.STICKY_PISTON ? 1 : 0];
    facedBox(out, x, y, z, f, 0, ext ? 12 : 16, 0, 16, id, rgb);
}

// small redstone models
function emitPart(out, world, x, y, z, id) {
    const m = world.getMeta(x, y, z);
    switch (shapeOf(id)) {
        case "dust": {                 // a flat sheet just above the floor; the shader cuts out the wire shape
            const rgb = [(m & 15) / 15, dustMask(world, x, y, z) / 15, 0], zz = z + 0.02;
            for (const [px, py] of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]) {
                out.pos.push(x + px, y + py, zz, 1);
                out.col.push(rgb[0], rgb[1], rgb[2], id * 8 + 4);
            }
            break;
        }
        case "torch":
            box(out, x, y, z, 7, 7, 0, 9, 9, 10, id, [id === B.TORCH ? 1 : m & 1, 0, 0]);
            break;
        case "lever":
            box(out, x, y, z, 5, 4, 0, 11, 12, 3, id, [m & 1, 0, 0]);                          // base
            if (m & 1) box(out, x, y, z, 7, 9, 3, 9, 11, 11, id, [1, 0, 0]);                  // handle: on
            else box(out, x, y, z, 7, 5, 3, 9, 7, 11, id, [0, 0, 0]);                         // handle: off
            break;
        case "button":
            box(out, x, y, z, 5, 5, 0, 11, 11, m & 1 ? 1 : 2, id, [m & 1, 0, 0]);
            break;
    }
}

export function buildChunkMesh(world, cx, cy) {
    const data = world.getChunk(cx, cy);
    const x0 = cx * CHUNK, y0 = cy * CHUNK;
    const get = (x, y, z) => {
        const lx = x - x0, ly = y - y0;
        if (lx >= 0 && ly >= 0 && lx < CHUNK && ly < CHUNK && z >= 0 && z < HEIGHT)
            return data[(z * CHUNK + ly) * CHUNK + lx];
        return world.getBlock(x, y, z);
    };

    const opaque = { pos: [], col: [] }, trans = { pos: [], col: [] };
    const p = [0, 0, 0], q = [0, 0, 0];
    const corner = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const ao = [0, 0, 0, 0];

    for (let z = 0; z < HEIGHT; z++) {
        for (let ly = 0; ly < CHUNK; ly++) {
            for (let lx = 0; lx < CHUNK; lx++) {
                const id = data[(z * CHUNK + ly) * CHUNK + lx];
                if (id === B.AIR) continue;
                const x = x0 + lx, y = y0 + ly;
                const out = translucent(id) ? trans : opaque;
                if (shapeOf(id)) { emitPart(out, world, x, y, z, id); continue; }
                if (isPistonPart(id)) { emitPiston(out, world, x, y, z, id); continue; }
                const state = isRedstone(id) ? stateColor(world, x, y, z, id) : null;

                for (let f = 0; f < 6; f++) {
                    const F = FACES[f];
                    const nx = x + F.n[0], ny = y + F.n[1], nz = z + F.n[2];
                    if (!showFace(id, get(nx, ny, nz))) continue;

                    // water surface sits a little lower than a full block
                    const lowerTop = id === B.WATER && f === 4 ? 0.12 : 0;

                    for (let c = 0; c < 4; c++) {
                        const [du, dv] = CORNERS[c];
                        p[0] = x; p[1] = y; p[2] = z;
                        if (F.s > 0) p[F.a] += 1;
                        p[F.u] += du; p[F.v] += dv;
                        corner[c][0] = p[0]; corner[c][1] = p[1]; corner[c][2] = p[2] - lowerTop;

                        // ambient occlusion from the two side neighbours and the diagonal one, in front of the face
                        q[0] = nx; q[1] = ny; q[2] = nz;
                        const su = du ? 1 : -1, sv = dv ? 1 : -1;
                        q[F.u] += su;
                        const s1 = occludes(get(q[0], q[1], q[2])) ? 1 : 0;
                        q[F.v] += sv;
                        const sc = occludes(get(q[0], q[1], q[2])) ? 1 : 0;
                        q[F.u] -= su;
                        const s2 = occludes(get(q[0], q[1], q[2])) ? 1 : 0;
                        ao[c] = s1 && s2 ? 0 : 3 - (s1 + s2 + sc);
                    }

                    const base = state || faceColor(id, f);
                    const info = id * 8 + f;
                    const vert = (c) => {
                        const k = corner[c];
                        out.pos.push(k[0], k[1], k[2], AO_LIGHT[ao[c]]);
                        out.col.push(base[0], base[1], base[2], info);
                    };
                    // split the quad along the diagonal that keeps the AO gradient smooth
                    if (ao[0] + ao[2] >= ao[1] + ao[3]) {
                        vert(0); vert(1); vert(2); vert(0); vert(2); vert(3);
                    } else {
                        vert(1); vert(2); vert(3); vert(1); vert(3); vert(0);
                    }
                }
            }
        }
    }
    return {
        cx, cy,
        pos: new Float32Array(opaque.pos), col: new Float32Array(opaque.col), count: opaque.pos.length / 4,
        tpos: new Float32Array(trans.pos), tcol: new Float32Array(trans.col), tcount: trans.pos.length / 4,
    };
}

// Sky dome: a unit sphere tagged as material ID_SKY. The vertex shader keeps it centred on the camera and pushes it
// to the far plane, and the fragment shader paints the sky, sun and clouds on it.
export function buildSkyDome(nLon = 24, nLat = 12) {
    const pos = [], col = [];
    const pt = (i, j) => {
        const th = (Math.PI * i) / nLat, ph = (2 * Math.PI * j) / nLon;
        return [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
    };
    const put = (v) => { pos.push(v[0], v[1], v[2], 1); col.push(0, 0, 0, ID_SKY * 8); };
    for (let i = 0; i < nLat; i++) {
        for (let j = 0; j < nLon; j++) {
            const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
            put(a); put(b); put(c); put(a); put(c); put(d);
        }
    }
    return { pos: new Float32Array(pos), col: new Float32Array(col), count: pos.length / 4 };
}
