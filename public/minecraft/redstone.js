// Redstone circuit simulation, 10 ticks per second (like Minecraft).
//
// State lives in world meta (per block):
//   dust        power 0..15
//   torch       bit0 lit                      (redstone torch: lit unless the block it stands on is powered)
//   lever       bit0 on                       (toggled by right click)
//   button      bit0 pressed                  (right click; stays pressed for 1 second)
//   lamp        bit0 lit
//   gates       bits0-1 facing, bit2 output, bit3 input A, bit4 input B
//   pistons     bits0-2 facing (DIRS6), bit3 extended          piston head: bits0-2 facing, bit3 sticky
//
// Each tick:
//   1. Sources, from last tick's states: levers/buttons that are on, lit redstone torches, gates whose output is on.
//      They power dust next to them to 15, and "strongly" power a solid block (the block a lever/button sits on,
//      the block above a lit torch, the block in front of a gate's output). A strongly powered block also powers
//      dust next to it, so a lever on a block drives the wire on the other side.
//   2. Dust carries power along connected wire (also one block up or down a step), losing 1 per block.
//   3. Dust "weakly" powers the block under it and the block it points into (a straight wire or a lone dot).
//   4. Torches, lamps and gates update from those signals. Torches and gates switch one tick later (a real
//      delay), so a torch loop makes a clock and nothing can hang the simulation.
//   5. Pistons powered from any side except their front extend (pushing up to 12 blocks; wires, torches and
//      other small parts in the way pop off), unpowered ones retract (sticky ones pull one block back).

import { B, DIRS, DIRS6, HEIGHT, isGate, isSolid, isPiston, shapeOf } from "./world.js";

const PUSH_LIMIT = 12;

const K = (x, y, z) => `${x},${y},${z}`;
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export class Redstone {
    constructor(world, onStateChange, onBlockChange) {
        this.world = world;
        this.onStateChange = onStateChange;       // (x, y, z) → the block's state changed, redraw it
        this.onBlockChange = onBlockChange;       // (x, y, z) → a block was moved / removed (pistons)
        this.buttons = new Map();                 // "x,y,z" → ticks left pressed
    }

    press(x, y, z) {
        this.buttons.set(K(x, y, z), 10);
        this.set(x, y, z, 1);
    }

    toggleLever(x, y, z) {
        this.set(x, y, z, this.world.getMeta(x, y, z) ^ 1);
    }

    set(x, y, z, meta) {
        if (this.world.getMeta(x, y, z) === meta) return;
        this.world.setMeta(x, y, z, meta);
        this.onStateChange(x, y, z);
    }

    // does the gate at g (with meta m) output into cell (x, y, z)?
    gateOutputsInto(gx, gy, gz, m, x, y, z) {
        const [dx, dy] = DIRS[m & 3];
        return gx + dx === x && gy + dy === y && gz === z && (m & 4) !== 0;
    }

    tick() {
        const w = this.world;
        const parts = [];
        for (const k of w.components) {
            const [x, y, z] = k.split(",").map(Number);
            parts.push({ x, y, z, k, id: w.getBlock(x, y, z), m: w.getMeta(x, y, z) });
        }
        const byKey = new Map(parts.map((p) => [p.k, p]));

        // buttons pop back up
        for (const [k, t] of this.buttons) {
            if (t <= 1) {
                this.buttons.delete(k);
                const p = byKey.get(k);
                if (p && p.id === B.BUTTON) { this.set(p.x, p.y, p.z, 0); p.m = 0; }
            } else this.buttons.set(k, t - 1);
        }

        // ---- 1. sources
        const strong = new Set();                 // strongly powered solid blocks
        const isOnSource = (p) =>
            ((p.id === B.LEVER || p.id === B.BUTTON) && (p.m & 1)) || (p.id === B.RS_TORCH && (p.m & 1));
        for (const p of parts) {
            if ((p.id === B.LEVER || p.id === B.BUTTON) && (p.m & 1) && isSolid(w.getBlock(p.x, p.y, p.z - 1))) strong.add(K(p.x, p.y, p.z - 1));
            if (p.id === B.RS_TORCH && (p.m & 1) && isSolid(w.getBlock(p.x, p.y, p.z + 1))) strong.add(K(p.x, p.y, p.z + 1));
            if (isGate(p.id) && (p.m & 4)) {
                const [dx, dy] = DIRS[p.m & 3];
                if (isSolid(w.getBlock(p.x + dx, p.y + dy, p.z)) && !isGate(w.getBlock(p.x + dx, p.y + dy, p.z))) strong.add(K(p.x + dx, p.y + dy, p.z));
            }
        }

        // ---- 2. dust
        const dust = parts.filter((p) => p.id === B.REDSTONE);
        const power = new Map(dust.map((d) => [d.k, 0]));
        const queue = [];
        for (const d of dust) {
            let src = false;
            for (const [dx, dy, dz] of N6) {
                const nk = K(d.x + dx, d.y + dy, d.z + dz), n = byKey.get(nk);
                if (n && isOnSource(n)) src = true;
                else if (n && isGate(n.id) && this.gateOutputsInto(n.x, n.y, n.z, n.m, d.x, d.y, d.z)) src = true;
                else if (strong.has(nk)) src = true;
            }
            if (src) { power.set(d.k, 15); queue.push(d); }
        }
        // spread along the wire (breadth-first from the strongest)
        queue.sort((a, b) => power.get(b.k) - power.get(a.k));
        for (let qi = 0; qi < queue.length; qi++) {
            const d = queue[qi], pw = power.get(d.k);
            if (pw <= 1) continue;
            for (const n of this.dustNeighbours(d.x, d.y, d.z)) {
                const nk = K(n[0], n[1], n[2]);
                if (power.has(nk) && power.get(nk) < pw - 1) {
                    power.set(nk, pw - 1);
                    queue.push({ x: n[0], y: n[1], z: n[2], k: nk });
                }
            }
        }

        // ---- 3. blocks powered by dust (weakly)
        const weak = new Set();
        for (const d of dust) {
            if (!power.get(d.k)) continue;
            if (isSolid(w.getBlock(d.x, d.y, d.z - 1))) weak.add(K(d.x, d.y, d.z - 1));
            const mask = this.dustMask(d.x, d.y, d.z);
            const alongX = (mask & 3) !== 0, alongY = (mask & 12) !== 0;
            DIRS.forEach(([dx, dy]) => {
                const pointsThisWay = mask === 0 || (dx !== 0 ? !alongY : !alongX);
                const id = w.getBlock(d.x + dx, d.y + dy, d.z);
                if (pointsThisWay && isSolid(id) && !isGate(id) && id !== B.LAMP) weak.add(K(d.x + dx, d.y + dy, d.z));
            });
        }
        const powered = (k) => strong.has(k) || weak.has(k);

        // is there a signal coming out of cell (x, y, z) into the neighbour at (tx, ty, tz)?
        const signalFrom = (x, y, z, tx, ty, tz) => {
            const k = K(x, y, z), n = byKey.get(k);
            if (n) {
                if (n.id === B.REDSTONE) return power.get(k) > 0;
                if (isOnSource(n)) return true;
                if (isGate(n.id)) return this.gateOutputsInto(n.x, n.y, n.z, n.m, tx, ty, tz);
                return false;
            }
            return powered(k);
        };

        // ---- 4. new states
        for (const d of dust) {
            const p = power.get(d.k);
            if ((d.m & 15) !== p) this.set(d.x, d.y, d.z, p);
        }
        for (const p of parts) {
            if (p.id === B.RS_TORCH) {
                const lit = powered(K(p.x, p.y, p.z - 1)) ? 0 : 1;
                if ((p.m & 1) !== lit) this.set(p.x, p.y, p.z, lit);
            } else if (p.id === B.LAMP) {
                const lit = N6.some(([dx, dy, dz]) => signalFrom(p.x + dx, p.y + dy, p.z + dz, p.x, p.y, p.z)) ? 1 : 0;
                if ((p.m & 1) !== lit) this.set(p.x, p.y, p.z, lit);
            } else if (isGate(p.id)) {
                const f = p.m & 3;
                const [fx, fy] = DIRS[f], [lx, ly] = DIRS[(f + 1) & 3], [rx, ry] = DIRS[(f + 3) & 3];
                let a, b;
                if (p.id === B.NOT) {
                    a = signalFrom(p.x - fx, p.y - fy, p.z, p.x, p.y, p.z);
                    b = false;
                } else {
                    a = signalFrom(p.x + lx, p.y + ly, p.z, p.x, p.y, p.z);
                    b = signalFrom(p.x + rx, p.y + ry, p.z, p.x, p.y, p.z);
                }
                const out = p.id === B.AND ? a && b : p.id === B.OR ? a || b : p.id === B.XOR ? a !== b
                    : p.id === B.NOT ? !a : p.id === B.NAND ? !(a && b) : !(a || b);
                const m = f | (out ? 4 : 0) | (a ? 8 : 0) | (b ? 16 : 0);
                if (m !== p.m) this.set(p.x, p.y, p.z, m);
            }
        }

        // ---- 5. pistons
        for (const p of parts) {
            if (!isPiston(p.id) || w.getBlock(p.x, p.y, p.z) !== p.id) continue;
            const f = p.m & 7, [fx, fy, fz] = DIRS6[f];
            const on = DIRS6.some(([dx, dy, dz], i) => i !== f && signalFrom(p.x + dx, p.y + dy, p.z + dz, p.x, p.y, p.z));
            const extended = (p.m & 8) !== 0;
            if (on && !extended) this.extend(p, fx, fy, fz, f);
            else if (!on && extended) this.retract(p, fx, fy, fz, f);
        }
    }

    // can a piston move this block? (air/water are free space; small parts pop off)
    movable(id, z) {
        return id !== B.PISTON_HEAD && z > 0 && z < HEIGHT - 1;
    }

    moveBlock(x, y, z, tx, ty, tz) {
        const w = this.world, id = w.getBlock(x, y, z), m = w.getMeta(x, y, z);
        w.setBlock(tx, ty, tz, id);
        if (m) w.setMeta(tx, ty, tz, m);
        this.onBlockChange(tx, ty, tz);
    }

    clear(x, y, z) {
        this.world.setBlock(x, y, z, B.AIR);
        this.onBlockChange(x, y, z);
    }

    extend(p, fx, fy, fz, f) {
        const w = this.world;
        // find the line of blocks in front, up to the first free cell
        const line = [];
        let x = p.x + fx, y = p.y + fy, z = p.z + fz;
        for (; ;) {
            const id = w.getBlock(x, y, z);
            if (id === B.AIR || id === B.WATER || shapeOf(id)) break;           // free (small parts get crushed)
            if (!this.movable(id, z) || (isPiston(id) && (w.getMeta(x, y, z) & 8))) return;   // blocked
            line.push([x, y, z]);
            if (line.length > PUSH_LIMIT) return;                                  // too heavy
            x += fx; y += fy; z += fz;
        }
        if (z < 0 || z >= HEIGHT) return;
        if (shapeOf(w.getBlock(x, y, z))) this.clear(x, y, z);
        for (let i = line.length - 1; i >= 0; i--) {                              // move from the far end
            const [bx, by, bz] = line[i];
            this.moveBlock(bx, by, bz, bx + fx, by + fy, bz + fz);
        }
        const hx = p.x + fx, hy = p.y + fy, hz = p.z + fz;
        w.setBlock(hx, hy, hz, B.PISTON_HEAD);
        w.setMeta(hx, hy, hz, f | (p.id === B.STICKY_PISTON ? 8 : 0));
        this.onBlockChange(hx, hy, hz);
        w.setMeta(p.x, p.y, p.z, (p.m & 7) | 8);
        this.onBlockChange(p.x, p.y, p.z);
    }

    retract(p, fx, fy, fz) {
        const w = this.world;
        const hx = p.x + fx, hy = p.y + fy, hz = p.z + fz;
        if (w.getBlock(hx, hy, hz) === B.PISTON_HEAD) this.clear(hx, hy, hz);
        if (p.id === B.STICKY_PISTON) {
            const bx = hx + fx, by = hy + fy, bz = hz + fz, id = w.getBlock(bx, by, bz);
            const pullable = id !== B.AIR && id !== B.WATER && !shapeOf(id) && this.movable(id, bz) && !(isPiston(id) && (w.getMeta(bx, by, bz) & 8));
            if (pullable && w.getBlock(hx, hy, hz) === B.AIR) { this.moveBlock(bx, by, bz, hx, hy, hz); this.clear(bx, by, bz); }
        }
        w.setMeta(p.x, p.y, p.z, p.m & 7);
        this.onBlockChange(p.x, p.y, p.z);
    }

    // connected dust: same level, or one step up/down if nothing solid blocks the step
    dustNeighbours(x, y, z) {
        const w = this.world, out = [];
        for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (w.getBlock(nx, ny, z) === B.REDSTONE) out.push([nx, ny, z]);
            if (!isSolid(w.getBlock(x, y, z + 1)) && w.getBlock(nx, ny, z + 1) === B.REDSTONE) out.push([nx, ny, z + 1]);
            if (!isSolid(w.getBlock(nx, ny, z)) && w.getBlock(nx, ny, z - 1) === B.REDSTONE) out.push([nx, ny, z - 1]);
        }
        return out;
    }

    // which sides the wire visually connects to: bit 1 +x, 2 -x, 4 +y, 8 -y (also used by the mesher)
    dustMask(x, y, z) {
        return dustMask(this.world, x, y, z);
    }
}

export function dustMask(w, x, y, z) {
    let mask = 0;
    DIRS.forEach(([dx, dy], i) => {
        const nx = x + dx, ny = y + dy, id = w.getBlock(nx, ny, z);
        const bit = [1, 4, 2, 8][i];
        if (id >= B.REDSTONE && id <= B.STICKY_PISTON && id !== B.TORCH) mask |= bit;
        else if (!isSolid(w.getBlock(x, y, z + 1)) && w.getBlock(nx, ny, z + 1) === B.REDSTONE) mask |= bit;
        else if (!isSolid(id) && w.getBlock(nx, ny, z - 1) === B.REDSTONE) mask |= bit;
    });
    return mask;
}
