// Nova — an AI companion that lives in the world with the player.
//
// Brain: the server endpoint /api/nova (Groq). It is asked when the player chats, and on its own when something
// happens (idle for a while, a task finished, a game ended, the player has been building...). It answers with
// something to say and up to 4 actions.
// Body: a blocky character that walks with the same physics as the player (Player class), animated in the
// vertex shader. Actions run one after another: following, walking somewhere, building (block by block, walking
// within reach), digging, chopping trees, emotes and mini-games (tag, hide and seek, race).

import { Player } from "./player.js";
import { B, BLOCKS, HEIGHT, DIRS, ID_BOT, isSolid, isGate, shapeOf } from "./world.js";
import { structureOps, STRUCTURES } from "./structures.js";

export const BOT_ID = ID_BOT;

// ------------------------------------------------------------------ body mesh
// Model space: x forward, y left, z up, feet at the origin. pos.w = 2 + part (0 body, 1 head, 2 left arm,
// 3 right arm, 4 left leg, 5 right leg) so the vertex shader knows what to swing.
export function buildBotMesh() {
    const SKIN = [0.93, 0.72, 0.58], SHIRT = [0.1, 0.6, 0.62], PANTS = [0.2, 0.24, 0.52], HAIR = [0.33, 0.19, 0.1], SHOE = [0.18, 0.16, 0.16];
    const boxes = [
        // x0, x1, y0, y1, z0, z1, part, colour
        [-0.125, 0.125, 0.0, 0.25, 0.1, 0.75, 4, PANTS], [-0.13, 0.13, 0.0, 0.25, 0.0, 0.1, 4, SHOE],
        [-0.125, 0.125, -0.25, 0.0, 0.1, 0.75, 5, PANTS], [-0.13, 0.13, -0.25, 0.0, 0.0, 0.1, 5, SHOE],
        [-0.125, 0.125, -0.25, 0.25, 0.75, 1.5, 0, SHIRT],
        [-0.125, 0.125, 0.25, 0.5, 1.2, 1.5, 2, SHIRT], [-0.125, 0.125, 0.25, 0.5, 0.75, 1.2, 2, SKIN],
        [-0.125, 0.125, -0.5, -0.25, 1.2, 1.5, 3, SHIRT], [-0.125, 0.125, -0.5, -0.25, 0.75, 1.2, 3, SKIN],
        [-0.25, 0.25, -0.25, 0.25, 1.5, 2.0, 1, SKIN],
        [-0.27, 0.27, -0.27, 0.27, 1.9, 2.03, 1, HAIR],
        [-0.27, -0.2, -0.27, 0.27, 1.62, 1.9, 1, HAIR],
    ];
    const pos = [], col = [];
    for (const [x0, x1, y0, y1, z0, z1, part, c] of boxes) {
        // faces in the same order as the mesher: +x, -x, +y, -y, +z, -z
        const quads = [
            [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
            [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]],
            [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]],
            [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
            [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
            [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]],
        ];
        quads.forEach((q, f) => {
            for (const i of [0, 1, 2, 0, 2, 3]) {
                pos.push(q[i][0], q[i][1], q[i][2], 2 + part);
                col.push(c[0], c[1], c[2], BOT_ID * 8 + f);
            }
        });
    }
    return { pos: new Float32Array(pos), col: new Float32Array(col), count: pos.length / 4 };
}

// ------------------------------------------------------------------ helpers

const BLOCK_BY_NAME = {
    grass: B.GRASS, dirt: B.DIRT, stone: B.STONE, sand: B.SAND, water: B.WATER, wood: B.WOOD, log: B.WOOD,
    leaves: B.LEAVES, leaf: B.LEAVES, planks: B.PLANKS, plank: B.PLANKS, glass: B.GLASS, cobblestone: B.COBBLE,
    cobble: B.COBBLE, bricks: B.BRICK, brick: B.BRICK, air: B.AIR,
    redstone: B.REDSTONE, "redstone dust": B.REDSTONE, dust: B.REDSTONE, wire: B.REDSTONE,
    "redstone torch": B.RS_TORCH, torch: B.TORCH, lever: B.LEVER, button: B.BUTTON,
    lamp: B.LAMP, "redstone lamp": B.LAMP,
    and: B.AND, or: B.OR, xor: B.XOR, not: B.NOT, nand: B.NAND, nor: B.NOR,
    piston: B.PISTON, "sticky piston": B.STICKY_PISTON,
};
const blockId = (name, fallback) => {
    const n = String(name ?? "").toLowerCase().replace(/[_-]/g, " ").replace(/\s*gate$/, "").trim();
    const id = BLOCK_BY_NAME[n] ?? BLOCK_BY_NAME[n.replace(/s$/, "")];
    return id === undefined ? fallback : id;
};
// "forward" | "back" | "left" | "right" relative to a frame → facing index (0 east, 1 north, 2 west, 3 south)
const facingIndex = (F, rel) => {
    if (rel === "up") return 4;
    if (rel === "down") return 5;
    const base = DIRS.findIndex((d) => d[0] === F[0] && d[1] === F[1]);
    const turn = { forward: 0, left: 1, back: 2, right: 3 }[String(rel ?? "forward").toLowerCase()] ?? 0;
    return (base + turn) & 3;
};
const num = (v, lo, hi, def) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? +v : def));
const rand = (a, b) => a + Math.random() * (b - a);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const CARDINAL = ["east", "north", "west", "south"];

// ------------------------------------------------------------------ body physics (same rules as the player)

class Bot extends Player {
    constructor(world) {
        super(world);
        this.keys = new Set();
        this.stuck = 0;
        this.target = null;
    }

    // walk towards (tx, ty); returns true once within `arrive` blocks
    steer(tx, ty, arrive = 1.5, sprint = false) {
        const dx = tx - this.x, dy = ty - this.y, d = Math.hypot(dx, dy);
        this.target = [tx, ty];
        if (d < arrive) { this.halt(); return true; }
        this.turnTo(Math.atan2(dy, dx), 0.25);
        this.keys.add("KeyW");
        if (sprint) this.keys.add("ControlLeft");
        return false;
    }

    halt() { this.keys.delete("KeyW"); this.keys.delete("ControlLeft"); this.target = null; }

    turnTo(yaw, k = 0.15) { this.yaw += wrap(yaw - this.yaw) * k; }

    faceTowards(x, y, k = 0.1) { this.turnTo(Math.atan2(y - this.y, x - this.x), k); }

    tick(dt) {
        const trying = this.keys.has("KeyW");
        if (trying && this.inWater) this.keys.add("Space");
        this.update(dt, this.keys);
        this.keys.delete("Space");
        // blocked: hop up the step; still blocked after a while: teleport a bit closer
        if (trying && Math.hypot(this.vx, this.vy) < 1.0) this.stuck += dt; else this.stuck = 0;
        if (this.stuck > 0.2 && this.onGround) this.keys.add("Space");
        if (this.stuck > 3.5 && this.target) {
            const [tx, ty] = this.target, a = Math.atan2(ty - this.y, tx - this.x);
            this.spawnAt(Math.floor(this.x + Math.cos(a) * 3), Math.floor(this.y + Math.sin(a) * 3));
            this.stuck = 0;
        }
    }
}

// ------------------------------------------------------------------ the companion

export class Companion {
    constructor({ world, player, editBlock, interact, ui }) {
        this.world = world;
        this.player = player;
        this.editBlock = editBlock;       // (x, y, z, id, meta?) → changes the world and remeshes
        this.interact = interact;         // (x, y, z) → flips a lever / presses a button
        this.ui = ui;                     // { chat(who, text, kind) }
        this.bot = new Bot(world);
        this.bot.spawnAt(Math.floor(player.x) + 2, Math.floor(player.y) + 1);

        this.mode = "follow";             // what to do when no task is running: follow | stay | wander
        this.queue = [];                  // actions waiting to run
        this.task = null;                 // the running action
        this.history = [];                // chat history for the model
        this.pending = false;
        this.queuedChat = null;
        this.lastAsk = -1e9;
        this.lastChat = performance.now() / 1000;
        this.idle = 0;
        this.nextIdle = rand(45, 80);
        this.edits = [];                  // times of recent player block placements
        this.lastBuildEvent = -1e9;

        this.bubble = "";
        this.bubbleUntil = 0;
        // Groq allowance, from the rate-limit headers the server passes on
        this.brain = { tokensRemaining: null, tokensLimit: null, requestsRemaining: null, requestsLimit: null,
            resetRequests: "", lastTokens: null, sessionTokens: 0, calls: 0, error: "" };
        this.mood = "happy";
        this.thinking = false;

        // animation state, read by the shader uniforms
        this.anim = { phase: 0, amp: 0, arm: 0, head: 0, bob: 0, spin: 0 };
        this.emote = null;
        this.armSwing = 0;
        this.wanderTarget = null;

        setTimeout(() => this.event("You just appeared in the world next to the player. Greet them and suggest something fun to do together.", true), 1500);
    }

    get now() { return performance.now() / 1000; }

    // ---------------------------------------------------------------- talking

    say(text, secs) {
        if (!text) return;
        this.bubble = text;
        this.bubbleUntil = this.now + (secs ?? 4 + text.length * 0.06);
        this.ui.chat("Nova", text);
    }

    chat(text) {
        text = text.trim();
        if (!text) return;
        this.ui.chat("You", text, "you");
        this.lastChat = this.now;
        this.idle = 0;
        if (this.pending) { this.queuedChat = text; return; }
        this.ask("chat", text);
    }

    // something happened; let Nova decide what (if anything) to do about it
    event(text, force = false) {
        if (this.pending) return;
        if (!force && this.now - this.lastAsk < 25) return;
        this.ask("event", text);
    }

    notePlayerEdit(kind) {
        if (kind !== "place") return;
        const t = this.now;
        this.edits.push(t);
        while (this.edits.length && t - this.edits[0] > 60) this.edits.shift();
        if (this.edits.length >= 12 && t - this.lastBuildEvent > 150 && !this.task) {
            this.lastBuildEvent = t;
            this.event(`The player has been building (${this.edits.length} blocks placed in the last minute), near where they're looking. React to it, maybe offer to help or suggest an addition.`);
        }
    }

    async ask(trigger, message) {
        this.pending = true;
        this.thinking = true;
        this.lastAsk = this.now;
        const userTurn = trigger === "chat" ? message : `[EVENT] ${message}`;
        try {
            const res = await fetch("/api/nova", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ trigger, message, context: this.context(), history: this.history.slice(-14) }),
            });
            const data = await res.json().catch(() => ({}));
            if (data.meta) this.updateBrain(data.meta);
            if (!res.ok) throw new Error(data.error || `server error ${res.status}`);
            this.brain.error = "";
            this.history.push({ role: "user", content: userTurn });
            this.history.push({ role: "assistant", content: JSON.stringify({ say: data.say, actions: data.actions }) });
            if (this.history.length > 30) this.history.splice(0, this.history.length - 30);
            this.handleReply(data, trigger);
        } catch (err) {
            this.brain.error = err.message;
            if (trigger === "chat") this.ui.chat("Nova", `(I can't think right now: ${err.message})`, "error");
            else console.warn("Nova:", err.message);
        } finally {
            this.pending = false;
            this.thinking = false;
            if (this.queuedChat) { const t = this.queuedChat; this.queuedChat = null; this.ask("chat", t); }
        }
    }

    updateBrain({ usage, limits }) {
        const b = this.brain;
        if (limits) {
            for (const k of ["tokensRemaining", "tokensLimit", "requestsRemaining", "requestsLimit"])
                if (limits[k] != null && Number.isFinite(+limits[k])) b[k] = +limits[k];
            if (limits.resetRequests) b.resetRequests = limits.resetRequests;
        }
        if (usage && usage.total_tokens) {
            b.lastTokens = usage.total_tokens;
            b.sessionTokens += usage.total_tokens;
            b.calls++;
        }
    }

    handleReply({ say, actions, mood }, trigger) {
        if (mood) this.mood = mood;
        if (say) this.say(say);
        let list = (actions || []).filter((a) => a && typeof a.type === "string");
        if (list.some((a) => a.type === "stop")) { this.cancelAll(); list = list.filter((a) => a.type !== "stop"); }
        if (!list.length) return;
        const minor = (a) => a.type === "emote" || a.type === "look_at_player";
        if (trigger === "chat" && list.some((a) => !minor(a))) {
            this.cancelAll();                          // a new request from the player replaces what Nova was doing
        } else if (trigger === "event" && (this.task || this.queue.length) && list.some((a) => !minor(a))) {
            return;                                    // busy: ignore self-started plans
        }
        this.queue.push(...list);
    }

    cancelAll() {
        if (this.task?.cancel) this.task.cancel();
        this.task = null;
        this.queue = [];
        this.emote = null;
        this.bot.halt();
    }

    // what Nova gets to know about the game
    context() {
        const p = this.player, b = this.bot, w = this.world;
        const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
        const counts = {};
        let treeDist = Infinity, water = false;
        for (let dz = -4; dz <= 8; dz++)
            for (let dy = -10; dy <= 10; dy++)
                for (let dx = -10; dx <= 10; dx++) {
                    const id = w.getBlock(px + dx, py + dy, pz + dz);
                    if (id === B.AIR) continue;
                    const n = BLOCKS[id].name.toLowerCase();
                    counts[n] = (counts[n] || 0) + 1;
                    if (id === B.WOOD) treeDist = Math.min(treeDist, Math.hypot(dx, dy));
                    if (id === B.WATER) water = true;
                }
        const facing = CARDINAL[((Math.round(p.yaw / (Math.PI / 2)) % 4) + 4) % 4];
        const look = this.lookTarget;
        return {
            player: {
                x: px, y: py, z: pz, facing, flying: p.flying, inWater: p.inWater,
                lookingAt: look ? { block: BLOCKS[look.id].name, x: look.x, y: look.y, z: look.z } : null,
                blocksPlacedLastMinute: this.edits.length,
            },
            nova: {
                x: Math.floor(b.x), y: Math.floor(b.y), z: Math.floor(b.z),
                distanceToPlayer: Math.round(Math.hypot(b.x - p.x, b.y - p.y)),
                doing: this.task ? this.task.label : this.mode, queued: this.queue.map((a) => a.type), mood: this.mood,
            },
            nearby: { blocks: counts, nearestTreeDistance: Number.isFinite(treeDist) ? Math.round(treeDist) : null, waterNearby: water },
            secondsSincePlayerSpokeLast: Math.round(this.now - this.lastChat),
        };
    }

    // ---------------------------------------------------------------- per frame

    update(dt, lookTarget) {
        this.lookTarget = lookTarget;
        const b = this.bot;
        b.keys.delete("KeyW"); b.keys.delete("ControlLeft");

        if (!this.task && this.queue.length) this.task = this.makeTask(this.queue.shift());
        const task = this.task;
        if (task) {
            if (task.update(dt)) {
                if (this.task === task) this.task = null;       // (a "stop" task may already have cleared it)
                if (task.report) this.event(task.report, true);
            }
        } else {
            this.defaultBehaviour(dt);
        }
        b.tick(dt);
        this.animate(dt);

        // free will: every so often when nothing is going on, Nova gets to decide something on its own
        if (!this.pending && !this.task && !this.queue.length) this.idle += dt; else this.idle = 0;
        if (this.idle > this.nextIdle && this.now - this.lastChat > 30) {
            this.idle = 0;
            this.nextIdle = rand(50, 100);
            const d = Math.hypot(b.x - this.player.x, b.y - this.player.y);
            this.event(`Nothing has happened for a while (you are in ${this.mode} mode, ${Math.round(d)} blocks from the player). Do something of your own if you feel like it: a remark, a suggestion, a small project or a game invitation — or just stay quiet.`);
        }
    }

    defaultBehaviour(dt) {
        const b = this.bot, p = this.player;
        const d = Math.hypot(p.x - b.x, p.y - b.y);
        if (this.mode === "follow") {
            if (d > 40) this.teleportNearPlayer();
            else if (d > 3.5) b.steer(p.x, p.y, 3, d > 9);
            else b.faceTowards(p.x, p.y);
        } else if (this.mode === "wander") {
            if (!this.wanderTarget || b.steer(this.wanderTarget[0], this.wanderTarget[1], 1.5) || Math.random() < dt * 0.08) {
                const a = rand(0, Math.PI * 2), r = rand(5, 16);
                this.wanderTarget = [p.x + Math.cos(a) * r, p.y + Math.sin(a) * r];
            }
        } else {
            if (d < 25) b.faceTowards(p.x, p.y, 0.05);
        }
    }

    teleportNearPlayer() {
        const p = this.player, a = p.yaw + Math.PI + rand(-0.6, 0.6);
        this.bot.spawnAt(Math.floor(p.x + Math.cos(a) * 3), Math.floor(p.y + Math.sin(a) * 3));
    }

    animate(dt) {
        const b = this.bot, A = this.anim, p = this.player;
        const speed = Math.hypot(b.vx, b.vy);
        A.phase += dt * speed * 2.4;
        A.amp += (Math.min(0.9, speed / 4) - A.amp) * Math.min(1, dt * 8);
        this.armSwing = Math.max(0, this.armSwing - dt * 4);
        A.arm = -1.3 * Math.sin(Math.min(1, this.armSwing) * Math.PI);
        A.bob = 0; A.spin = 0;
        // head turns towards the player when close
        const toPlayer = wrap(Math.atan2(p.y - b.y, p.x - b.x) - b.yaw);
        const wantHead = Math.hypot(p.x - b.x, p.y - b.y) < 12 ? Math.max(-1, Math.min(1, toPlayer)) : 0;
        A.head += (wantHead - A.head) * Math.min(1, dt * 5);

        const e = this.emote;
        if (e) {
            e.t += dt;
            if (e.name === "dance") { A.bob = Math.abs(Math.sin(e.t * 7)) * 0.18; A.head = Math.sin(e.t * 3.5) * 0.5; A.arm = -1.6 + Math.sin(e.t * 7) * 0.8; A.phase += dt * 7; A.amp = 0.6; }
            if (e.name === "wave") A.arm = -2.6 + Math.sin(e.t * 12) * 0.4;
            if (e.name === "spin") A.spin = e.t * 9;
            if (e.name === "nod") A.bob = Math.max(0, Math.sin(e.t * 10)) * -0.05;
            if (e.name === "jump" && b.onGround) b.keys.add("Space");
            if (e.name === "hide") A.bob = -0.35;
            if (e.t > e.dur) this.emote = null;
        }
    }

    uniforms() {
        const b = this.bot, A = this.anim;
        return { pos: [b.x, b.y, b.z], yaw: b.yaw + A.spin, phase: A.phase, amp: A.amp, arm: A.arm, head: A.head, bob: A.bob };
    }

    // ---------------------------------------------------------------- actions

    // player-relative frame: facing snapped to N/E/S/W; origin on the ground `ahead` blocks in front
    frame(where = "front") {
        const p = this.player, b = this.bot;
        const a = Math.round(p.yaw / (Math.PI / 2)) * (Math.PI / 2);
        const F = [Math.round(Math.cos(a)), Math.round(Math.sin(a))], R = [F[1], -F[0]];
        const base = where === "nova" ? b : p;
        const ahead = where === "front" ? 3 : 1;
        const ox = Math.floor(base.x) + F[0] * ahead, oy = Math.floor(base.y) + F[1] * ahead;
        return { F, R, ox, oy, oz: this.groundZ(ox, oy, Math.floor(base.z)) };
    }

    groundZ(x, y, fromZ) {
        for (let z = Math.min(HEIGHT - 2, fromZ + 6); z > 0; z--) {
            const id = this.world.getBlock(x, y, z - 1);
            if (isSolid(id)) return z;
        }
        return fromZ;
    }

    // starting state for blocks that have one: gates face `rel` (default: the way the player looks)
    metaFor(id, fr, rel) {
        if (isGate(id)) return facingIndex(fr.F, rel) & 3;
        if (id === B.PISTON || id === B.STICKY_PISTON) return facingIndex(fr.F, rel);   // the side it pushes towards
        if (id === B.RS_TORCH) return 1;
        return undefined;
    }

    toWorld(fr, r, f, u) { return [fr.ox + fr.R[0] * r + fr.F[0] * f, fr.oy + fr.R[1] * r + fr.F[1] * f, fr.oz + u]; }

    makeTask(a) {
        const p = this.player, b = this.bot;
        const instant = (fn, label) => ({ label, update: () => { fn(); return true; } });

        switch (a.type) {
            case "follow": return instant(() => { this.mode = "follow"; }, "following");
            case "stay": return instant(() => { this.mode = "stay"; b.halt(); }, "staying");
            case "wander": return instant(() => { this.mode = "wander"; this.wanderTarget = null; }, "wandering");
            case "stop": return instant(() => { this.emote = null; this.bot.halt(); }, "stopping");   // queued actions after it still run
            case "look_at_player": return instant(() => { b.yaw = Math.atan2(p.y - b.y, p.x - b.x); }, "looking");
            case "emote": {
                const name = ["jump", "dance", "wave", "spin", "nod"].includes(a.name) ? a.name : "wave";
                return instant(() => { this.emote = { name, t: 0, dur: name === "dance" ? 4 : name === "spin" ? 0.7 : 2 }; }, name);
            }
            case "come": {
                let t = 0;
                return { label: "coming to the player", update: (dt) => { t += dt; this.mode = "follow"; return b.steer(p.x, p.y, 2.5, true) || t > 30; } };
            }
            case "goto": {
                const x = num(a.x, -1e5, 1e5, b.x), y = num(a.y, -1e5, 1e5, b.y);
                let t = 0;
                return { label: `walking to ${Math.round(x)},${Math.round(y)}`, update: (dt) => { t += dt; this.mode = "stay"; return b.steer(x, y, 1.5, true) || t > 45; } };
            }
            case "build": return this.buildTask(a);
            case "build_custom": return this.customBuildTask(a);
            case "place": {
                const fr = this.frame("front");
                const [x, y, z] = this.toWorld(fr, Math.round(num(a.right, -12, 12, 0)), Math.round(num(a.forward, -12, 12, 0)), Math.round(num(a.up, -4, 16, 0)));
                const id = blockId(a.block, B.COBBLE);
                return this.opsTask([{ x, y, z, id, meta: this.metaFor(id, fr, a.facing) }], "placing a block", "");
            }
            case "use": {                                  // flip a lever / press a button (searches 1 block around the spot)
                const fr = this.frame("front");
                const [x, y, z] = this.toWorld(fr, Math.round(num(a.right, -12, 12, 0)), Math.round(num(a.forward, -12, 12, 0)), Math.round(num(a.up, -4, 16, 0)));
                let t = 0;
                return {
                    label: "using a switch",
                    update: (dt) => {
                        t += dt;
                        if (!b.steer(x + 0.5, y + 0.5, 3, false) && t < 12) return false;
                        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                            const id = this.world.getBlock(x + dx, y + dy, z + dz);
                            if ((id === B.LEVER || id === B.BUTTON) && this.interact) { this.interact(x + dx, y + dy, z + dz); this.armSwing = 1; return true; }
                        }
                        this.say("Hmm, there's no lever or button there.");
                        return true;
                    },
                };
            }
            case "dig": {
                const fr = this.frame("front");
                const w = Math.round(num(a.width, 1, 9, 3)), d = Math.round(num(a.depth, 1, 9, 3)), h = Math.round(num(a.height, 1, 6, 2));
                const ops = [];
                for (let u = 0; u < h; u++)                      // top layer first, going down
                    for (let f = 0; f < d; f++)
                        for (let r = -Math.floor(w / 2); r < w - Math.floor(w / 2); r++) {
                            const [x, y, z] = this.toWorld(fr, r, f, -1 - u);
                            ops.push({ x, y, z, id: B.AIR });
                        }
                return this.opsTask(ops, "digging", "You finished digging the hole the player asked for.");
            }
            case "chop_tree": return this.chopTask();
            case "game": return this.gameTask(a.name);
            default:
                return instant(() => {}, "nothing");
        }
    }

    buildTask(a) {
        const name = STRUCTURES.includes(a.structure) ? a.structure : "house";
        const block = a.block ? blockId(a.block, undefined) : undefined;
        const bp = structureOps(name, a.size, block);
        const fr = this.frame(a.where === "here" || a.where === "nova" ? a.where : "front");
        if (name === "bridge") fr.oz = Math.floor(this.player.z);        // bridges start at the player's feet level
        const ops = [];
        if (bp.clear) {
            const c = bp.clear;
            for (let u = c.u1; u >= c.u0; u--)
                for (let f = c.f0; f <= c.f1; f++)
                    for (let r = c.r0; r <= c.r1; r++) {
                        const [x, y, z] = this.toWorld(fr, r, f, u);
                        ops.push({ x, y, z, id: B.AIR, clear: true });
                    }
        }
        if (bp.foundation) {
            for (const [r, f, u, id] of bp.ops) {
                if (u !== 0 || id === B.AIR) continue;
                const [x, y, z] = this.toWorld(fr, r, f, 0);
                for (let k = 1; k <= 6; k++) {
                    const below = this.world.getBlock(x, y, z - k);
                    if (isSolid(below)) break;
                    ops.push({ x, y, z: z - k, id: B.COBBLE, foundation: k });
                }
            }
        }
        const main = bp.ops.slice().sort((p, q) => p[2] - q[2]).map(([r, f, u, id]) => {
            const [x, y, z] = this.toWorld(fr, r, f, u);
            return { x, y, z, id };
        });
        // foundations bottom-up, after clearing
        const clear = ops.filter((o) => o.clear), found = ops.filter((o) => o.foundation).sort((p, q) => q.foundation - p.foundation);
        return this.opsTask([...clear, ...found, ...main], `building a ${name}`, `You finished building the ${name} (${main.length} blocks). Tell the player, maybe suggest what to add next.`);
    }

    customBuildTask(a) {
        const fr = this.frame("front");
        const list = Array.isArray(a.blocks) ? a.blocks.slice(0, 300) : [];
        const ops = [];
        for (const e of list) {
            if (!Array.isArray(e) || e.length < 4) continue;
            const r = Math.round(num(e[0], -12, 12, 0)), f = Math.round(num(e[1], -12, 12, 0)), u = Math.round(num(e[2], 0, 16, 0));
            const [x, y, z] = this.toWorld(fr, r, f, u);
            const id = blockId(e[3], B.PLANKS);
            ops.push({ x, y, z, id, meta: this.metaFor(id, fr, e[4]) });
        }
        ops.sort((p, q) => p.z - q.z || (shapeOf(p.id) ? 1 : 0) - (shapeOf(q.id) ? 1 : 0));   // wires/torches after their support
        return this.opsTask(ops, "building something of my own design", `You finished your custom build (${ops.length} blocks). Show it off to the player.`);
    }

    chopTask() {
        const b = this.bot, w = this.world;
        // a real tree: a wood column with leaves at the top (so wooden posts in buildings are left alone)
        const isTree = (x, y, z) => {
            let top = z;
            while (w.getBlock(x, y, top + 1) === B.WOOD && top - z < 12) top++;
            if (w.getBlock(x, y, top + 1) === B.LEAVES) return true;
            return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => w.getBlock(x + dx, y + dy, top) === B.LEAVES);
        };
        const bx = Math.floor(b.x), by = Math.floor(b.y), bz = Math.floor(b.z);
        let best = null, bestD = Infinity;
        for (let dz = -3; dz <= 8; dz++)
            for (let dy = -20; dy <= 20; dy++)
                for (let dx = -20; dx <= 20; dx++) {
                    if (w.getBlock(bx + dx, by + dy, bz + dz) !== B.WOOD || !isTree(bx + dx, by + dy, bz + dz)) continue;
                    const d = Math.hypot(dx, dy) + Math.abs(dz) * 0.3;
                    if (d < bestD) { bestD = d; best = [bx + dx, by + dy, bz + dz]; }
                }
        if (!best) {
            this.say("Hmm, I can't see any trees around here.");
            return { label: "looking for trees", update: () => true };
        }
        // flood-fill the trunk and nearby leaves
        const seen = new Set(), ops = [], stack = [best], key = (x, y, z) => `${x},${y},${z}`;
        while (stack.length && ops.length < 160) {
            const [x, y, z] = stack.pop();
            const k = key(x, y, z);
            if (seen.has(k)) continue;
            seen.add(k);
            const id = w.getBlock(x, y, z);
            if (id !== B.WOOD && id !== B.LEAVES) continue;
            if (Math.hypot(x - best[0], y - best[1]) > 3.5) continue;
            ops.push({ x, y, z, id: B.AIR });
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) stack.push([x + dx, y + dy, z + dz]);
        }
        ops.sort((p, q) => q.z - p.z);
        return this.opsTask(ops, "chopping a tree", "You finished chopping down a tree.");
    }

    // place / remove blocks one by one, walking within reach of each
    opsTask(ops, label, report) {
        const b = this.bot, p = this.player, w = this.world;
        let i = 0, cool = 0, t = 0, deferred = 0;
        return {
            label, report,
            update: (dt) => {
                cool -= dt;
                // skip blocks that are already right
                for (let n = 0; n < 40 && i < ops.length && w.getBlock(ops[i].x, ops[i].y, ops[i].z) === ops[i].id; n++) i++;
                if (i >= ops.length) return true;
                const o = ops[i];
                const d = Math.hypot(o.x + 0.5 - b.x, o.y + 0.5 - b.y);
                b.faceTowards(o.x + 0.5, o.y + 0.5, 0.2);
                t += dt;
                if (d > 4.5 && t < 6) { b.steer(o.x + 0.5, o.y + 0.5, 3.5, d > 10); return false; }
                if (cool > 0) return false;
                if (o.id !== B.AIR && o.id !== B.WATER && (p.overlapsBlock(o.x, o.y, o.z) || b.overlapsBlock(o.x, o.y, o.z))) {
                    deferred += dt;
                    if (b.overlapsBlock(o.x, o.y, o.z)) {
                        // Nova is standing where the block goes: step out of the way (or hop next to the player)
                        let ax = b.x - (o.x + 0.5), ay = b.y - (o.y + 0.5), m = Math.hypot(ax, ay);
                        if (m < 0.2) { const a = rand(0, Math.PI * 2); ax = Math.cos(a); ay = Math.sin(a); m = 1; }
                        b.steer(o.x + 0.5 + (ax / m) * 2.5, o.y + 0.5 + (ay / m) * 2.5, 0.3);
                        if (deferred > 3) { this.teleportNearPlayer(); deferred = 0; }
                    } else if (deferred > 4) { i++; deferred = 0; }   // the player is standing there: wait, then skip
                    return false;
                }
                if (o.z >= 1 && o.z < HEIGHT) this.editBlock(o.x, o.y, o.z, o.id, o.meta);
                this.armSwing = 1;
                i++; t = 0; deferred = 0;
                cool = o.clear ? 0.03 : 0.09;
                return i >= ops.length;
            },
        };
    }

    // ---------------------------------------------------------------- games

    gameTask(name) {
        const b = this.bot, p = this.player;
        const dist = () => Math.hypot(p.x - b.x, p.y - b.y);
        let t = 0;

        if (name === "hide_and_seek") {
            const a = rand(0, Math.PI * 2), r = rand(18, 30);
            const spot = [p.x + Math.cos(a) * r, p.y + Math.sin(a) * r];
            let hidden = false, hintAt = 90;
            this.say("Close your eyes and count to 10... I'm hiding! 🙈");
            return {
                label: "playing hide and seek (hiding)",
                report: null,
                update: (dt) => {
                    t += dt;
                    if (!hidden) {
                        if (b.steer(spot[0], spot[1], 1.5, true) || t > 25) { hidden = true; this.emote = { name: "hide", t: 0, dur: 1e9 }; }
                        return false;
                    }
                    if (dist() < 3.5) {
                        this.emote = null;
                        this.say("Aww, you found me! 😄");
                        this.event(`Hide and seek is over: the player found you after ${Math.round(t)} seconds. React and maybe suggest another round or something else.`, true);
                        return true;
                    }
                    if (t > hintAt) { hintAt += 40; this.emote = { name: "jump", t: 0, dur: 1.5 }; this.say("Psst... over here! 👋"); }
                    if (t > 240) { this.emote = null; this.say("I win! Nobody finds me! 😎"); return true; }
                    return false;
                },
                cancel: () => { this.emote = null; },
            };
        }

        if (name === "race") {
            const a = p.yaw + rand(-0.8, 0.8), r = rand(25, 35);
            const gx = Math.floor(p.x + Math.cos(a) * r), gy = Math.floor(p.y + Math.sin(a) * r);
            const gz = this.groundZ(gx, gy, Math.floor(p.z));
            for (let u = 0; u < 6; u++) this.editBlock(gx, gy, gz + u, u % 2 ? B.GLASS : B.BRICK);
            let started = false, count = 3.5;
            this.say("See that pillar? First one to touch it wins! Ready...", 3);
            return {
                label: "racing the player",
                update: (dt) => {
                    t += dt;
                    if (!started) {
                        const before = Math.ceil(count);
                        count -= dt;
                        if (Math.ceil(count) !== before && count > 0) { this.bubble = `${Math.ceil(count)}...`; this.bubbleUntil = this.now + 1; }
                        if (count <= 0) { started = true; this.say("GO! 🏁", 1.5); }
                        b.faceTowards(gx + 0.5, gy + 0.5, 0.3);
                        return false;
                    }
                    const pd = Math.hypot(p.x - gx - 0.5, p.y - gy - 0.5), bd = Math.hypot(b.x - gx - 0.5, b.y - gy - 0.5);
                    if (pd < 2.2 || bd < 2.2 || t > 60) {
                        const winner = pd < 2.2 ? "player" : bd < 2.2 ? "nova" : "nobody";
                        this.say(winner === "player" ? "Nooo, you beat me! 😤" : winner === "nova" ? "I WIN! 🏆" : "Time's up!");
                        this.event(`The race is over, winner: ${winner}. React and maybe ask for a rematch or suggest something else.`, true);
                        return true;
                    }
                    b.steer(gx + 0.5, gy + 0.5, 1.5, true);
                    return false;
                },
            };
        }

        // tag (default)
        let it = "player", cooldown = 3, fleeDir = Math.atan2(b.y - p.y, b.x - p.x);     // the player starts as "it"
        return {
            label: "playing tag",
            update: (dt) => {
                t += dt; cooldown -= dt;
                const d = dist();
                if (it === "nova") {
                    if (cooldown < 0) b.steer(p.x, p.y, 0.8, true);
                    if (d < 1.3 && cooldown < 0) { it = "player"; cooldown = 2.5; this.say("Tag! You're it! 😜", 2); fleeDir = Math.atan2(b.y - p.y, b.x - p.x); }
                } else {
                    fleeDir += wrap(Math.atan2(b.y - p.y, b.x - p.x) - fleeDir) * 0.05 + rand(-0.15, 0.15);
                    b.steer(b.x + Math.cos(fleeDir) * 6, b.y + Math.sin(fleeDir) * 6, 0.5, false);
                    if (d < 1.4 && cooldown < 0) { it = "nova"; cooldown = 2.5; this.say("Argh, you got me! My turn!", 2); }
                    if (d > 30) fleeDir = Math.atan2(p.y - b.y, p.x - b.x);    // don't run off too far
                }
                if (t > 150) {
                    this.say("Phew, I'm out of breath! 😮‍💨");
                    this.event("The game of tag has ended (2.5 minutes passed). React and suggest what to do next.", true);
                    return true;
                }
                return false;
            },
        };
    }
}
