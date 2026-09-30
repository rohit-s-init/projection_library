// Voxel world: block types, chunk storage and terrain generation.
// Z is up (same convention as Space.js). A chunk is CHUNK × CHUNK columns, HEIGHT blocks tall.

import { makeNoise, hash2 } from "./noise.js";

export const CHUNK = 16;
export const HEIGHT = 64;
export const WATER_LEVEL = 22;

export const B = {
    AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, WATER: 5, WOOD: 6, LEAVES: 7,
    PLANKS: 8, GLASS: 9, COBBLE: 10, BRICK: 11,
    // redstone
    REDSTONE: 12, RS_TORCH: 13, TORCH: 14, LEVER: 15, BUTTON: 16, LAMP: 17,
    AND: 18, OR: 19, XOR: 20, NOT: 21, NAND: 22, NOR: 23,
    PISTON: 24, STICKY_PISTON: 25, PISTON_HEAD: 26,
};
// ids reserved for things that aren't blocks (used by the shaders)
export const ID_BOT = 62, ID_SKY = 63;

// top / side / bottom colours (the shader adds the pixel texture on top of these)
export const BLOCKS = [];
const def = (id, name, top, side = top, bottom = side, opts = {}) =>
    (BLOCKS[id] = { id, name, top, side, bottom, solid: true, transparent: false, ...opts });
def(B.AIR, "Air", [0, 0, 0], undefined, undefined, { solid: false, transparent: true });
def(B.GRASS, "Grass", [0.36, 0.62, 0.22], [0.52, 0.38, 0.26], [0.52, 0.38, 0.26]);
def(B.DIRT, "Dirt", [0.52, 0.38, 0.26]);
def(B.STONE, "Stone", [0.5, 0.5, 0.52]);
def(B.SAND, "Sand", [0.86, 0.8, 0.56]);
def(B.WATER, "Water", [0.2, 0.42, 0.82], undefined, undefined, { solid: false });
def(B.WOOD, "Wood", [0.64, 0.52, 0.33], [0.42, 0.31, 0.19]);
def(B.LEAVES, "Leaves", [0.22, 0.5, 0.18], undefined, undefined, { transparent: true });
def(B.PLANKS, "Planks", [0.72, 0.56, 0.34]);
def(B.GLASS, "Glass", [0.78, 0.9, 0.95], undefined, undefined, { transparent: true });
def(B.COBBLE, "Cobblestone", [0.46, 0.46, 0.47]);
def(B.BRICK, "Bricks", [0.62, 0.3, 0.23]);

// Redstone. Small parts (dust, torches, lever, button) are not solid: you walk through them, and they sit on the
// block below. `shape` tells the mesher to draw them as small models instead of full cubes.
const part = (shape) => ({ solid: false, transparent: true, shape });
def(B.REDSTONE, "Redstone Dust", [0.72, 0.06, 0.05], undefined, undefined, part("dust"));
def(B.RS_TORCH, "Redstone Torch", [0.85, 0.12, 0.06], [0.45, 0.3, 0.15], undefined, part("torch"));
def(B.TORCH, "Torch", [1.0, 0.78, 0.35], [0.45, 0.3, 0.15], undefined, part("torch"));
def(B.LEVER, "Lever", [0.5, 0.5, 0.52], [0.45, 0.33, 0.2], undefined, part("lever"));
def(B.BUTTON, "Button", [0.55, 0.55, 0.57], undefined, undefined, part("button"));
def(B.LAMP, "Redstone Lamp", [0.78, 0.58, 0.32], [0.5, 0.33, 0.2]);
// Logic gates: full blocks with a direction. The output comes out of the front (the way you faced when placing
// it); two-input gates read their left and right sides, NOT reads its back.
export const GATE_COLORS = {
    [B.AND]: [0.2, 0.45, 0.95], [B.OR]: [0.25, 0.8, 0.35], [B.XOR]: [0.7, 0.35, 0.95],
    [B.NOT]: [0.95, 0.55, 0.15], [B.NAND]: [0.15, 0.75, 0.8], [B.NOR]: [0.95, 0.35, 0.6],
};
for (const [name, id] of [["AND Gate", B.AND], ["OR Gate", B.OR], ["XOR Gate", B.XOR], ["NOT Gate", B.NOT], ["NAND Gate", B.NAND], ["NOR Gate", B.NOR]])
    def(id, name, GATE_COLORS[id], [0.26, 0.27, 0.31], undefined, { gate: true });
// Pistons face one of 6 directions (towards the player who placed them). Powered, they push up to 12 blocks one
// step forward and put their head in front; unpowered, they pull the head back (sticky ones bring the block
// in front of the head back with it). The head is its own block while extended.
def(B.PISTON, "Piston", [0.72, 0.56, 0.34], [0.5, 0.5, 0.52], undefined, { piston: true });
def(B.STICKY_PISTON, "Sticky Piston", [0.45, 0.8, 0.35], [0.5, 0.5, 0.52], undefined, { piston: true });
def(B.PISTON_HEAD, "Piston Head", [0.72, 0.56, 0.34], undefined, undefined, { piston: true, hidden: true });

export const isSolid = (id) => BLOCKS[id].solid;
export const isTransparent = (id) => BLOCKS[id].transparent;
export const isRedstone = (id) => id >= B.REDSTONE && id <= B.STICKY_PISTON;
export const isPiston = (id) => id === B.PISTON || id === B.STICKY_PISTON;
export const isPistonPart = (id) => id === B.PISTON || id === B.STICKY_PISTON || id === B.PISTON_HEAD;
export const isGate = (id) => id >= B.AND && id <= B.NOR;
export const shapeOf = (id) => BLOCKS[id].shape;

// horizontal directions, indexed by "facing": 0 east (+x), 1 north (+y), 2 west, 3 south
export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
// all 6 directions (pistons): 0 east, 1 north, 2 west, 3 south, 4 up, 5 down
export const DIRS6 = [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const chunkKey = (cx, cy) => (cx + 32768) * 65536 + (cy + 32768);
const idx = (lx, ly, z) => (z * CHUNK + ly) * CHUNK + lx;

export class World {
    constructor(seed = 1234) {
        this.seed = seed;
        this.noise = makeNoise(seed);
        this.chunks = new Map();          // key → Uint8Array block data
        this.meta = new Map();            // "x,y,z" → small integer state (redstone power, facing, on/off...)
        this.components = new Set();      // "x,y,z" of every redstone block, for the circuit simulation
    }

    getMeta(x, y, z) { return this.meta.get(`${x},${y},${z}`) || 0; }
    setMeta(x, y, z, v) { const k = `${x},${y},${z}`; if (v) this.meta.set(k, v); else this.meta.delete(k); }

    hasChunk(cx, cy) { return this.chunks.has(chunkKey(cx, cy)); }

    getChunk(cx, cy) {
        const k = chunkKey(cx, cy);
        let c = this.chunks.get(k);
        if (!c) { c = this.generate(cx, cy); this.chunks.set(k, c); }
        return c;
    }

    getBlock(x, y, z) {
        if (z < 0) return B.STONE;        // solid floor below the world, so no bottom faces are drawn
        if (z >= HEIGHT) return B.AIR;
        const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
        return this.getChunk(cx, cy)[idx(x - cx * CHUNK, y - cy * CHUNK, z)];
    }

    setBlock(x, y, z, id) {
        if (z < 0 || z >= HEIGHT) return false;
        const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
        this.getChunk(cx, cy)[idx(x - cx * CHUNK, y - cy * CHUNK, z)] = id;
        const k = `${x},${y},${z}`;
        this.meta.delete(k);
        if (isRedstone(id)) this.components.add(k); else this.components.delete(k);
        return true;
    }

    // terrain surface height of a column: rolling plains, with mountains in some regions
    heightAt(x, y) {
        const { fbm } = this.noise;
        const base = fbm(x / 90, y / 90, 4);
        const mountainMask = Math.max(0, fbm(x / 260 + 100, y / 260 - 50, 2) * 1.6);
        const detail = 0.5 + 0.5 * fbm(x / 35 + 7, y / 35, 3);
        const h = 24 + base * 9 + mountainMask * mountainMask * 26 * detail;
        return Math.max(3, Math.min(HEIGHT - 12, Math.floor(h)));
    }

    generate(cx, cy) {
        const data = new Uint8Array(CHUNK * CHUNK * HEIGHT);
        const x0 = cx * CHUNK, y0 = cy * CHUNK;

        for (let ly = 0; ly < CHUNK; ly++) {
            for (let lx = 0; lx < CHUNK; lx++) {
                const h = this.heightAt(x0 + lx, y0 + ly);
                const beach = h <= WATER_LEVEL + 1;
                for (let z = 0; z <= Math.max(h, WATER_LEVEL); z++) {
                    let id;
                    if (z > h) id = B.WATER;
                    else if (z === h) id = beach ? B.SAND : B.GRASS;
                    else if (z > h - 4) id = beach ? B.SAND : B.DIRT;
                    else id = B.STONE;
                    data[idx(lx, ly, z)] = id;
                }
            }
        }

        // Trees. Candidate trunks are checked in a 2-block margin around the chunk too, so leaves from a tree
        // in the neighbouring chunk still land in this one (every chunk decides the same trees independently).
        const put = (wx, wy, z, id, onlyAir) => {
            const lx = wx - x0, ly = wy - y0;
            if (lx < 0 || ly < 0 || lx >= CHUNK || ly >= CHUNK || z < 0 || z >= HEIGHT) return;
            const i = idx(lx, ly, z);
            if (!onlyAir || data[i] === B.AIR) data[i] = id;
        };
        for (let wy = y0 - 2; wy < y0 + CHUNK + 2; wy++) {
            for (let wx = x0 - 2; wx < x0 + CHUNK + 2; wx++) {
                if (hash2(wx, wy, this.seed) > 0.012) continue;
                const h = this.heightAt(wx, wy);
                if (h <= WATER_LEVEL + 1 || h > HEIGHT - 12) continue;
                const trunk = 4 + Math.floor(hash2(wx, wy, this.seed + 1) * 3);
                for (let dz = -2; dz <= 1; dz++) {
                    const r = dz >= 0 ? 1 : 2;
                    for (let dy = -r; dy <= r; dy++) {
                        for (let dx = -r; dx <= r; dx++) {
                            if (r === 2 && Math.abs(dx) === 2 && Math.abs(dy) === 2 && hash2(wx + dx, wy + dy + dz, this.seed + 2) < 0.6) continue;
                            if (dz === 1 && Math.abs(dx) + Math.abs(dy) > 1) continue;
                            put(wx + dx, wy + dy, h + trunk + dz, B.LEAVES, true);
                        }
                    }
                }
                for (let z = 1; z <= trunk; z++) put(wx, wy, h + z, B.WOOD, false);
                put(wx, wy, h, B.DIRT, false);
            }
        }
        return data;
    }
}
