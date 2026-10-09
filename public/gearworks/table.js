// Gearworks: the table layout and the ball physics.
//
// Table space: x runs across the playfield (-4.3 … 4.3, plus the shooter lane out to 5.0), y runs up the slope
// (flippers near y = 2.4, the top arch peaks near y = 19.6). Physics is 2D on that plane; the renderer lifts it
// into 3D. Walls are segments (a ball against a segment is a capsule test), bumpers/posts are circles, flippers
// are tapered capsules that rotate about a pivot, so their surface speed is added to the bounce.

export const BALL_R = 0.25;
export const GRAVITY = 20;          // along -y (the slope of the table)
export const MAX_SPEED = 40;
export const SUBSTEPS = 10;

export const ARC = { cx: 0.35, cy: 15, r: 4.65 };
export const PLUNGER = { x: 4.65, y: 0.3 + BALL_R + 0.01 };

const seg = (ax, ay, bx, by, o = {}) => ({ ax, ay, bx, by, e: 0.45, ...o });
function poly(points, o) { const out = []; for (let i = 1; i < points.length; i++) out.push(seg(...points[i - 1], ...points[i], o)); return out; }
function arcPts(cx, cy, r, a0, a1, n) { const p = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); p.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return p; }

export function buildTable() {
    const walls = [];
    // outer boundary: left wall, the top arch, the right wall of the shooter lane
    walls.push(...poly([[-4.3, -1.5], [-4.3, ARC.cy], ...arcPts(ARC.cx, ARC.cy, ARC.r, Math.PI, 0, 40).slice(1), [5.0, -1.5]], { kind: "rail" }));
    // shooter lane inner wall (also the right outlane wall) and the plunger tip
    walls.push(seg(4.3, -1.5, 4.3, 13.2, { kind: "rail" }));
    walls.push(seg(4.3, 0.3, 5.0, 0.3, { kind: "plunger", e: 0.1 }));
    // one-way gate at the top of the shooter lane: balls leave the lane, nothing falls back in
    walls.push(seg(4.3, 13.2, 5.0, 13.95, { kind: "gate", oneWay: true }));
    // left orbit guide (lane between it and the arch)
    walls.push(...poly([[-3.45, 8.8], [-3.45, ARC.cy], ...arcPts(ARC.cx, ARC.cy, 3.8, Math.PI, 2.2, 10).slice(1)], { kind: "rail" }));
    // deflector under the orbit exit: balls coming down the orbit roll into the left inlane, not the outlane
    walls.push(seg(-4.3, 8.3, -3.72, 6.6, { kind: "rail", e: 0.1 }));
    // inlane guides
    walls.push(...poly([[-3.72, 6.35], [-3.6, 5.4], [-3.6, 3.8], [-1.95, 2.58]], { kind: "rail" }));
    walls.push(...poly([[3.6, 5.4], [3.6, 3.8], [1.95, 2.58]], { kind: "rail" }));
    // slingshots: the slanted face kicks
    const slings = [];
    for (const s of [-1, 1]) {
        const A = [2.95 * s, 5.2], B = [2.95 * s, 4.0], C = [2.15 * s, 3.5];
        const kick = seg(...A, ...C, { kind: "sling", kick: 9, e: 0.6, side: s });
        walls.push(kick, seg(...A, ...B, { kind: "rubber" }), seg(...B, ...C, { kind: "rubber" }));
        slings.push({ A, B, C, side: s, flash: 0, seg: kick });
    }
    // rollover lane posts at the top
    const lanePosts = [-1.55, -0.5, 0.55, 1.6];
    for (const x of lanePosts) walls.push(seg(x, 16.3, x, 17.2, { kind: "post" }));
    const lanes = [0, 1, 2].map((i) => ({ x0: lanePosts[i], x1: lanePosts[i + 1], y: 16.75, lit: false, cool: 0 }));
    // drop-target pocket on the right
    walls.push(seg(3.45, 7.4, 4.3, 7.85, { kind: "rail" }), seg(3.45, 10.1, 4.3, 10.55, { kind: "rail" }));
    const targets = [[7.55, 8.3], [8.375, 9.125], [9.2, 9.95]].map(([y0, y1]) => ({ seg: seg(3.45, y0, 3.45, y1, { kind: "target", e: 0.3 }), down: false, flash: 0 }));
    // gear bumpers
    const bumpers = [[-1.15, 13.3], [1.25, 13.3], [0.05, 11.7]].map(([x, y], i) => ({ x, y, r: 0.55, kick: 10, flash: 0, spin: i * 0.7, kind: "bumper" }));
    const posts = [];
    const flippers = [
        { px: -1.85, py: 2.45, len: 1.55, rest: -0.52, up: 0.5, angle: -0.52, omega: 0, side: -1, pressed: false },
        { px: 1.85, py: 2.45, len: 1.55, rest: Math.PI + 0.52, up: Math.PI - 0.5, angle: Math.PI + 0.52, omega: 0, side: 1, pressed: false },
    ];
    const saucer = { x: -2.45, y: 10.2, r: 0.32, hold: 0, ball: null };
    const orbit = { x0: -4.3, x1: -3.45, y: 9.6 };
    return { walls, slings, lanes, targets, bumpers, posts, flippers, saucer, orbit };
}

// ------------------------------------------------------------------ physics

function closestOnSeg(px, py, s) {
    const dx = s.bx - s.ax, dy = s.by - s.ay, L2 = dx * dx + dy * dy;
    let t = ((px - s.ax) * dx + (py - s.ay) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return [s.ax + dx * t, s.ay + dy * t, t];
}

// collide one ball with a static segment; returns the impact speed (0 if no contact)
function hitSegment(b, s) {
    const [cx, cy] = closestOnSeg(b.x, b.y, s);
    let nx = b.x - cx, ny = b.y - cy;
    const d2 = nx * nx + ny * ny;
    if (d2 >= BALL_R * BALL_R) return 0;
    const d = Math.sqrt(d2) || 1e-6;
    nx /= d; ny /= d;
    if (s.oneWay) {                                   // the gate: only pushes balls coming down from above-left
        const gx = -(s.by - s.ay), gy = s.bx - s.ax, gl = Math.hypot(gx, gy);
        const ux = gx / gl, uy = gy / gl;            // normal on the playfield side
        if ((b.x - cx) * ux + (b.y - cy) * uy < 0 || b.vx * ux + b.vy * uy > 0) return 0;
        nx = ux; ny = uy;
    }
    b.x = cx + nx * BALL_R; b.y = cy + ny * BALL_R;
    const vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return 0;
    b.vx -= (1 + s.e) * vn * nx; b.vy -= (1 + s.e) * vn * ny;
    if (s.kick && -vn > 1.2) { b.vx += nx * s.kick; b.vy += ny * s.kick; }
    return -vn;
}
function hitCircle(b, c) {
    let nx = b.x - c.x, ny = b.y - c.y;
    const R = c.r + BALL_R, d2 = nx * nx + ny * ny;
    if (d2 >= R * R) return 0;
    const d = Math.sqrt(d2) || 1e-6;
    nx /= d; ny /= d;
    b.x = c.x + nx * R; b.y = c.y + ny * R;
    const vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return 0.001;
    b.vx -= 1.5 * vn * nx; b.vy -= 1.5 * vn * ny;
    if (c.kick) { b.vx += nx * c.kick; b.vy += ny * c.kick; }
    return -vn;
}
export const flipperTip = (f) => [f.px + Math.cos(f.angle) * f.len, f.py + Math.sin(f.angle) * f.len];
function hitFlipper(b, f) {
    const [tx, ty] = flipperTip(f);
    const s = { ax: f.px, ay: f.py, bx: tx, by: ty };
    const [cx, cy, t] = closestOnSeg(b.x, b.y, s);
    const fr = 0.22 - t * 0.1;
    let nx = b.x - cx, ny = b.y - cy;
    const R = fr + BALL_R, d2 = nx * nx + ny * ny;
    if (d2 >= R * R) return 0;
    const d = Math.sqrt(d2) || 1e-6;
    nx /= d; ny /= d;
    b.x = cx + nx * R; b.y = cy + ny * R;
    const vfx = -f.omega * (cy - f.py), vfy = f.omega * (cx - f.px);    // surface speed of the flipper there
    const rvx = b.vx - vfx, rvy = b.vy - vfy, vn = rvx * nx + rvy * ny;
    if (vn >= 0) return 0;
    b.vx -= 1.35 * vn * nx; b.vy -= 1.35 * vn * ny;
    return -vn;
}

// advance flippers and balls by dt; `events` collects what was hit for scoring/sounds
export function stepPhysics(T, balls, dt, events) {
    const h = dt / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) {
        for (const f of T.flippers) {
            const target = f.pressed ? f.up : f.rest, speed = f.pressed ? 26 : 16;
            const old = f.angle, diff = target - f.angle, stepA = Math.sign(diff) * Math.min(Math.abs(diff), speed * h);
            f.angle += stepA;
            f.omega = (f.angle - old) / h;
        }
        for (const b of balls) {
            if (b.held) continue;
            b.vy -= GRAVITY * h;
            const sp = Math.hypot(b.vx, b.vy);
            if (sp > MAX_SPEED) { b.vx *= MAX_SPEED / sp; b.vy *= MAX_SPEED / sp; }
            b.x += b.vx * h; b.y += b.vy * h;
            for (const w of T.walls) { const v = hitSegment(b, w); if (v > 0) events.push({ type: w.kind, v, b, w }); }
            for (const t of T.targets) if (!t.down) { const v = hitSegment(b, t.seg); if (v > 0) events.push({ type: "target", v, b, t }); }
            for (const c of T.bumpers) { const v = hitCircle(b, c); if (v > 0.01) events.push({ type: "bumper", v, b, c }); }
            for (const f of T.flippers) { const v = hitFlipper(b, f); if (v > 0) events.push({ type: "flipper", v, b, f }); }
        }
        // balls against each other (multiball)
        for (let i = 0; i < balls.length; i++) for (let j = i + 1; j < balls.length; j++) {
            const a = balls[i], c = balls[j];
            if (a.held || c.held) continue;
            const dx = c.x - a.x, dy = c.y - a.y, d = Math.hypot(dx, dy);
            if (d > 0 && d < BALL_R * 2) {
                const nx = dx / d, ny = dy / d, push = (BALL_R * 2 - d) / 2;
                a.x -= nx * push; a.y -= ny * push; c.x += nx * push; c.y += ny * push;
                const rel = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
                if (rel < 0) { a.vx += rel * nx; a.vy += rel * ny; c.vx -= rel * nx; c.vy -= rel * ny; events.push({ type: "clack", v: -rel }); }
            }
        }
    }
}
