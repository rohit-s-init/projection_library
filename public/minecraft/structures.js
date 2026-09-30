// Blueprints the companion can build. Each returns a list of [right, forward, up, blockId] relative to an origin
// on the ground in front of the player (right/forward follow the player's facing, snapped to N/E/S/W),
// plus an optional box to clear first.

import { B } from "./world.js";

const clampInt = (v, lo, hi, def) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(+v) ? +v : def)));

export const STRUCTURES = ["house", "tower", "wall", "bridge", "platform", "pyramid", "pillar", "stairs", "well", "hedge"];

export function structureOps(name, size, block) {
    const ops = [];
    const put = (r, f, u, id) => ops.push([r, f, u, id]);
    let clear = null;          // { r0, r1, f0, f1, u0, u1 } — solid blocks in here are removed first
    let foundation = false;    // fill air/water under the bottom layer down to the ground

    switch (name) {
        case "house": {
            const s = clampInt(size, 5, 11, 7), hw = Math.floor(s / 2), d = s, h = 4;
            const wall = block ?? B.PLANKS, roof = wall === B.PLANKS ? B.BRICK : B.PLANKS;
            clear = { r0: -hw - 1, r1: hw + 1, f0: -1, f1: d, u0: 0, u1: h + hw + 3 };
            foundation = true;
            for (let r = -hw; r <= hw; r++) for (let f = 0; f < d; f++) put(r, f, 0, B.PLANKS);        // floor
            for (let u = 1; u <= h; u++) {
                for (let r = -hw; r <= hw; r++) for (let f = 0; f < d; f++) {
                    const edgeR = Math.abs(r) === hw, edgeF = f === 0 || f === d - 1;
                    if (!edgeR && !edgeF) continue;
                    let id = edgeR && edgeF ? B.WOOD : wall;                                       // wooden corner posts
                    if (f === 0 && r === 0 && u <= 2) id = B.AIR;                                  // door
                    if (u === 2 && !(edgeR && edgeF)) {                                            // windows
                        if (edgeR && f === Math.floor(d / 2)) id = B.GLASS;
                        if (f === d - 1 && Math.abs(r) <= 1 && s >= 7) id = B.GLASS;
                        if (f === 0 && Math.abs(r) === 2 && s >= 7) id = B.GLASS;
                    }
                    put(r, f, u, id);
                }
            }
            for (let k = 0; ; k++) {                                                               // stepped roof
                const r0 = -hw - 1 + k, r1 = hw + 1 - k;
                if (r0 > r1) break;
                for (let r = r0; r <= r1; r++) for (let f = -1; f <= d; f++) put(r, f, h + 1 + k, roof);
            }
            break;
        }
        case "tower": {
            const s = clampInt(size, 3, 7, 5), hw = Math.floor(s / 2), h = s * 2 + 4;
            const mat = block ?? B.COBBLE;
            clear = { r0: -hw, r1: hw, f0: 0, f1: s - 1, u0: 0, u1: h + 2 };
            foundation = true;
            for (let r = -hw; r <= hw; r++) for (let f = 0; f < s; f++) put(r, f, 0, mat);
            for (let u = 1; u < h; u++) {
                for (let r = -hw; r <= hw; r++) for (let f = 0; f < s; f++) {
                    if (Math.abs(r) !== hw && f !== 0 && f !== s - 1) continue;
                    let id = mat;
                    if (f === 0 && r === 0 && u <= 2) id = B.AIR;
                    const mid = (Math.abs(r) === hw && f === hw) || ((f === 0 || f === s - 1) && r === 0);
                    if (mid && u % 4 === 3) id = B.GLASS;
                    put(r, f, u, id);
                }
            }
            for (let r = -hw; r <= hw; r++) for (let f = 0; f < s; f++) {
                put(r, f, h, B.PLANKS);                                                            // roof deck
                const edge = Math.abs(r) === hw || f === 0 || f === s - 1;
                if (edge && (r + f) % 2 === 0) put(r, f, h + 1, mat);                              // battlements
            }
            break;
        }
        case "wall": {
            const L = clampInt(size, 3, 24, 9), half = Math.floor(L / 2), mat = block ?? B.COBBLE;
            foundation = true;
            for (let r = -half; r <= half; r++) {
                for (let u = 0; u < 3; u++) put(r, 0, u, mat);
                if (r % 2 === 0) put(r, 0, 3, mat);
            }
            break;
        }
        case "bridge": {
            const L = clampInt(size, 3, 30, 10), mat = block ?? B.PLANKS;
            for (let f = 0; f < L; f++) {
                for (let r = -1; r <= 1; r++) put(r, f, -1, mat);
                if (f % 2 === 0) { put(-2, f, 0, B.WOOD); put(2, f, 0, B.WOOD); }
            }
            break;
        }
        case "platform": {
            const s = clampInt(size, 3, 15, 7), hw = Math.floor(s / 2), mat = block ?? B.PLANKS;
            foundation = true;
            for (let r = -hw; r <= hw; r++) for (let f = 0; f < s; f++) put(r, f, 0, mat);
            break;
        }
        case "pyramid": {
            const s = clampInt(size, 3, 13, 9) | 1, mat = block ?? B.SAND;
            foundation = true;
            for (let k = 0; 2 * k < s; k++) {
                const hw = Math.floor(s / 2) - k;
                for (let r = -hw; r <= hw; r++) for (let f = k; f < s - k; f++) put(r, f, k, mat);
            }
            break;
        }
        case "pillar": {
            const h = clampInt(size, 2, 20, 6), mat = block ?? B.COBBLE;
            for (let u = 0; u < h; u++) put(0, 0, u, mat);
            break;
        }
        case "stairs": {
            const n = clampInt(size, 2, 16, 6), mat = block ?? B.COBBLE;
            for (let f = 0; f < n; f++) for (let u = 0; u <= f; u++) for (let r = 0; r <= 1; r++) put(r, f, u, mat);
            break;
        }
        case "well": {
            const mat = block ?? B.COBBLE;
            clear = { r0: -1, r1: 1, f0: 0, f1: 2, u0: 0, u1: 4 };
            for (let r = -1; r <= 1; r++) for (let f = 0; f < 3; f++) {
                if (r === 0 && f === 1) { put(0, 1, -2, B.WATER); put(0, 1, -1, B.WATER); put(0, 1, 0, B.WATER); }
                else put(r, f, 0, mat);
                put(r, f, 4, B.PLANKS);
            }
            for (const [r, f] of [[-1, 0], [1, 0], [-1, 2], [1, 2]]) for (let u = 1; u <= 3; u++) put(r, f, u, B.WOOD);
            break;
        }
        case "hedge": {
            const s = clampInt(size, 3, 15, 7), hw = Math.floor(s / 2), mat = block ?? B.LEAVES;
            for (let r = -hw; r <= hw; r++) for (let f = 0; f < s; f++) {
                if (Math.abs(r) !== hw && f !== 0 && f !== s - 1) continue;
                if (f === 0 && r === 0) continue;                                                  // gap to walk in
                put(r, f, 0, mat); put(r, f, 1, mat);
            }
            break;
        }
        default:
            return null;
    }
    return { ops, clear, foundation };
}
