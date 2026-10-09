// Skyputt: hole generation and ball physics.
//
// A hole is a winding chain of square tiles (CELL units each) on a floating island. Edges of a tile that don't
// lead to another fairway tile get a wooden rail. Hazards sit on tiles along the way: bumper posts, sand traps,
// spinning windmills, sliding blocks, slope tiles that push the ball, and boost pads. Physics is 2D on the
// z = 0 plane: rolling friction, bounces off rails (capsule tests), moving obstacles add their surface speed.

export const CELL = 3;
export const BALL_R = 0.17;
export const CUP_R = 0.28;
export const MAX_SPEED = 15;

export function mulberry32(seed) {
    return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const key = (i, j) => i + "," + j;
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export function generateHole(seed, number) {
    const rng = mulberry32(seed);
    for (let attempt = 0; attempt < 200; attempt++) {
        const len = 4 + Math.min(7, Math.floor(number * 0.7)) + Math.floor(rng() * 3);
        const cells = [[0, 0]], set = new Set([key(0, 0)]);
        let dir = 1, ok = true;
        for (let s = 1; s < len && ok; s++) {
            const opts = [];
            for (const turn of [0, 0, 1, -1]) {
                const d = (dir + turn + 4) % 4;
                if (d === 3) continue;                                  // never head back towards the camera
                const [pi, pj] = cells[cells.length - 1], ni = pi + DIRS[d][0], nj = pj + DIRS[d][1];
                if (set.has(key(ni, nj))) continue;
                // the new tile may only touch the previous one
                let touching = 0;
                for (const [di, dj] of DIRS) if (set.has(key(ni + di, nj + dj))) touching++;
                if (touching > 1) continue;
                opts.push([d, ni, nj]);
            }
            if (!opts.length) { ok = false; break; }
            const [d, ni, nj] = opts[Math.floor(rng() * opts.length)];
            dir = d; cells.push([ni, nj]); set.add(key(ni, nj));
        }
        if (!ok) continue;
        // some holes get a wider green around the cup
        if (number > 2 && rng() < 0.5) {
            const [ci, cj] = cells[cells.length - 1];
            for (const [di, dj] of DIRS) {
                const ni = ci + di, nj = cj + dj;
                if (set.has(key(ni, nj)) || nj < cj) continue;
                let touching = 0;
                for (const [ei, ej] of DIRS) if (set.has(key(ni + ei, nj + ej))) touching++;
                if (touching === 1 && rng() < 0.6) { cells.splice(cells.length - 1, 0, [ni, nj]); set.add(key(ni, nj)); }      // the cup stays last
            }
        }
        return buildHole(cells, set, rng, number, seed);
    }
    throw new Error("could not build a hole");
}

function buildHole(cells, set, rng, number, seed) {
    const C = CELL;
    const center = ([i, j]) => [i * C, j * C];
    // rails on open edges
    const walls = [];
    for (const [i, j] of cells) {
        const x0 = i * C - C / 2, x1 = i * C + C / 2, y0 = j * C - C / 2, y1 = j * C + C / 2;
        if (!set.has(key(i + 1, j))) walls.push(seg(x1, y0, x1, y1));
        if (!set.has(key(i - 1, j))) walls.push(seg(x0, y0, x0, y1));
        if (!set.has(key(i, j + 1))) walls.push(seg(x0, y1, x1, y1));
        if (!set.has(key(i, j - 1))) walls.push(seg(x0, y0, x1, y0));
    }
    const tee = center(cells[0]);
    const cupCell = cells[cells.length - 1];
    const cup = [cupCell[0] * C + (rng() - 0.5) * 1.0, cupCell[1] * C + (rng() - 0.5) * 1.0];
    // direction of travel through each tile (for slopes, boosts, windmill orientation)
    const travel = cells.map((c, k) => {
        const n = cells[Math.min(cells.length - 1, k + 1)], p = cells[Math.max(0, k - 1)];
        const dx = n[0] - p[0], dy = n[1] - p[1], L = Math.hypot(dx, dy) || 1;
        return [dx / L, dy / L];
    });
    // hazards, unlocked hole by hole
    const pool = ["bumper"];
    if (number >= 2) pool.push("sand");
    if (number >= 3) pool.push("windmill");
    if (number >= 4) pool.push("slope");
    if (number >= 5) pool.push("mover");
    if (number >= 6) pool.push("boost");
    const hz = { bumpers: [], sand: [], windmills: [], slopes: [], movers: [], boosts: [] };
    const want = Math.min(cells.length - 2, 1 + Math.floor(number * 0.6) + Math.floor(rng() * 2));
    const free = cells.map((c, k) => k).slice(1, -1).filter(() => true);
    for (let n = 0; n < want && free.length; n++) {
        const k = free.splice(Math.floor(rng() * free.length), 1)[0];
        const [cx, cy] = center(cells[k]), [tx, ty] = travel[k];
        const type = pool[Math.floor(rng() * pool.length)];
        if (type === "bumper") {
            const m = 1 + Math.floor(rng() * 2);
            for (let b = 0; b < m; b++) hz.bumpers.push({ x: cx + (rng() - 0.5) * 1.4, y: cy + (rng() - 0.5) * 1.4, r: 0.32, flash: 0 });
        } else if (type === "sand") hz.sand.push({ x: cx + (rng() - 0.5) * 0.6, y: cy + (rng() - 0.5) * 0.6, rx: 0.8 + rng() * 0.4, ry: 0.6 + rng() * 0.4, a: rng() * 3 });
        else if (type === "windmill") hz.windmills.push({ x: cx, y: cy, len: 1.05, angle: rng() * 3, omega: (rng() < 0.5 ? -1 : 1) * (1.1 + rng() * 0.8 + number * 0.03) });
        else if (type === "slope") {
            const side = rng() < 0.5 ? 1 : -1;                          // pushes sideways across the travel direction
            hz.slopes.push({ i: cells[k][0], j: cells[k][1], fx: -ty * side * 3.2, fy: tx * side * 3.2 });
        } else if (type === "mover") hz.movers.push({ x: cx, y: cy, ax: -ty, ay: tx, amp: 0.85, w: 1.2 + rng() * 0.8, phase: rng() * 6, half: 0.55, r: 0.25 });
        else if (type === "boost") hz.boosts.push({ x: cx, y: cy, dx: tx, dy: ty, r: 0.6 });
    }
    // par: roughly one stroke per two tiles of route plus the green
    const par = Math.max(2, Math.min(6, Math.round(cells.length / 3.2) + 1 + (hz.windmills.length + hz.movers.length > 1 ? 1 : 0)));
    return { cells, set, walls, tee, cup, par, number, seed, ...hz };
}
const seg = (ax, ay, bx, by) => ({ ax, ay, bx, by });

// ------------------------------------------------------------------ physics

function closest(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
    return [ax + dx * t, ay + dy * t];
}
// bounce the ball off a capsule from a to b (radius r); (vx, vy) is the obstacle's surface velocity
function hitCapsule(b, ax, ay, bx, by, r, e, svx = 0, svy = 0) {
    const [cx, cy] = closest(b.x, b.y, ax, ay, bx, by);
    let nx = b.x - cx, ny = b.y - cy;
    const R = r + BALL_R, d2 = nx * nx + ny * ny;
    if (d2 >= R * R) return 0;
    const d = Math.sqrt(d2) || 1e-6;
    nx /= d; ny /= d;
    b.x = cx + nx * R; b.y = cy + ny * R;
    const rvx = b.vx - svx, rvy = b.vy - svy, vn = rvx * nx + rvy * ny;
    if (vn >= 0) return 0.0001;
    b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny;
    return -vn;
}
export const moverPos = (m, t) => { const s = Math.sin(t * m.w + m.phase) * m.amp; return [m.x + m.ax * s, m.y + m.ay * s, Math.cos(t * m.w + m.phase) * m.amp * m.w]; };
export function inSand(h, x, y) {
    for (const s of h.sand) {
        const c = Math.cos(s.a), si = Math.sin(s.a), dx = x - s.x, dy = y - s.y;
        const u = (dx * c + dy * si) / s.rx, v = (-dx * si + dy * c) / s.ry;
        if (u * u + v * v < 1) return true;
    }
    return false;
}
// advance the ball; returns events for sounds and effects
export function step(h, b, dt, t, events) {
    const SUB = 8, dh = dt / SUB;
    for (let s = 0; s < SUB; s++) {
        const tt = t + dh * s;
        if (b.sunk) return;
        // forces: slopes
        const ci = Math.round(b.x / CELL), cj = Math.round(b.y / CELL);
        let onSlope = false;
        for (const sl of h.slopes) if (sl.i === ci && sl.j === cj) { b.vx += sl.fx * dh; b.vy += sl.fy * dh; onSlope = true; }
        // friction
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > 0) {
            const sand = inSand(h, b.x, b.y);
            const decel = (sand ? 7.5 : 1.15) + sp * (sand ? 1.6 : 0.16);
            const ns = Math.max(0, sp - decel * dh);
            b.vx *= ns / sp; b.vy *= ns / sp;
            if (sand && sp > 1 && Math.random() < 0.05) events.push({ type: "sand", x: b.x, y: b.y });
        }
        if (Math.hypot(b.vx, b.vy) > MAX_SPEED) { const k = MAX_SPEED / Math.hypot(b.vx, b.vy); b.vx *= k; b.vy *= k; }
        b.x += b.vx * dh; b.y += b.vy * dh;
        b.onSlope = onSlope;
        // boosts
        for (const p of h.boosts) {
            const inside = Math.hypot(b.x - p.x, b.y - p.y) < p.r;
            if (inside && !p.armed) { const v = Math.max(10, Math.hypot(b.vx, b.vy)); b.vx = p.dx * v; b.vy = p.dy * v; p.armed = true; p.flash = 1; events.push({ type: "boost", x: p.x, y: p.y }); }
            if (!inside) p.armed = false;
        }
        // rails
        for (const w of h.walls) { const v = hitCapsule(b, w.ax, w.ay, w.bx, w.by, 0.06, 0.62); if (v > 0.5) events.push({ type: "wall", v, x: b.x, y: b.y }); }
        for (const p of h.bumpers) { const v = hitCapsule(b, p.x, p.y, p.x, p.y, p.r, 0.95); if (v > 0.01) { b.vx *= 1.12; b.vy *= 1.12; p.flash = 1; if (v > 0.3) events.push({ type: "bumper", v, x: p.x, y: p.y }); } }
        for (const m of h.windmills) {
            const a = m.angle + m.omega * (tt - (m.t0 ?? 0)), c = Math.cos(a) * m.len, si = Math.sin(a) * m.len;
            const [cx, cy] = closest(b.x, b.y, m.x - c, m.y - si, m.x + c, m.y + si);
            const svx = -m.omega * (cy - m.y), svy = m.omega * (cx - m.x);
            const v = hitCapsule(b, m.x - c, m.y - si, m.x + c, m.y + si, 0.1, 0.5, svx, svy);
            if (v > 0.5) events.push({ type: "windmill", v, x: b.x, y: b.y });
            hitCapsule(b, m.x, m.y, m.x, m.y, 0.22, 0.5);                // the hub
        }
        for (const m of h.movers) {
            const [px, py, sv] = moverPos(m, tt);
            const ux = -m.ay, uy = m.ax;                                  // block's long axis is along the travel direction
            const v = hitCapsule(b, px - ux * m.half, py - uy * m.half, px + ux * m.half, py + uy * m.half, m.r, 0.55, m.ax * sv, m.ay * sv);
            if (v > 0.5) events.push({ type: "mover", v, x: b.x, y: b.y });
        }
        // the cup
        const dx = b.x - h.cup[0], dy = b.y - h.cup[1], dc = Math.hypot(dx, dy), spd = Math.hypot(b.vx, b.vy);
        if (dc < CUP_R) {
            if (spd < 5.5) { b.sunk = true; b.vx = b.vy = 0; b.x = h.cup[0]; b.y = h.cup[1]; events.push({ type: "cup" }); return; }
            // too fast: it lips out with a kick sideways
            if (!b.lipped) { b.vx += -dy / dc * 1.5; b.vy += dx / dc * 1.5; b.vx *= 0.75; b.vy *= 0.75; b.lipped = true; events.push({ type: "lip" }); }
        } else if (dc < CUP_R + 0.25 && spd < 1.4) {                    // gentle pull into the cup near the lip
            b.vx -= dx / dc * 2.2 * dh; b.vy -= dy / dc * 2.2 * dh;
        } else b.lipped = false;
    }
}
