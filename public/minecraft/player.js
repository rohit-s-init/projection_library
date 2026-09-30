// First-person player: mouse look, walking with gravity and block collisions, flying, swimming,
// and a voxel raycast for picking the block under the crosshair.

import { B, isSolid } from "./world.js";

const HALF_W = 0.3;          // player box is 0.6 × 0.6 × 1.8
const TALL = 1.8;
const EYE = 1.62;
const GRAVITY = 28;
const JUMP = 8.6;
const WALK = 4.3, SPRINT = 5.8, FLY = 11;
const EPS = 1e-4;

export class Player {
    constructor(world) {
        this.world = world;
        this.x = 0; this.y = 0; this.z = 0;       // feet centre
        this.vx = 0; this.vy = 0; this.vz = 0;
        this.yaw = 0; this.pitch = -0.2;
        this.onGround = false;
        this.flying = false;
        this.inWater = false;
    }

    get eye() { return [this.x, this.y, this.z + EYE]; }

    get dir() {
        const cp = Math.cos(this.pitch);
        return [cp * Math.cos(this.yaw), cp * Math.sin(this.yaw), Math.sin(this.pitch)];
    }

    look(mx, my) {
        this.yaw -= mx * 0.0024;
        this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - my * 0.0024));
    }

    spawnAt(x, y) {
        this.x = x + 0.5; this.y = y + 0.5;
        this.z = this.world.heightAt(x, y) + 1;
        while (this.collides(this.x, this.y, this.z)) this.z += 1;   // e.g. spawned inside a tree
        this.vx = this.vy = this.vz = 0;
    }

    // does the player box at (x, y, z) overlap any solid block?
    collides(x, y, z) {
        const w = this.world;
        const x0 = Math.floor(x - HALF_W), x1 = Math.floor(x + HALF_W - EPS);
        const y0 = Math.floor(y - HALF_W), y1 = Math.floor(y + HALF_W - EPS);
        const z0 = Math.floor(z), z1 = Math.floor(z + TALL - EPS);
        for (let bz = z0; bz <= z1; bz++)
            for (let by = y0; by <= y1; by++)
                for (let bx = x0; bx <= x1; bx++)
                    if (isSolid(w.getBlock(bx, by, bz))) return true;
        return false;
    }

    // would a block placed at (bx, by, bz) overlap the player?
    overlapsBlock(bx, by, bz) {
        return bx + 1 > this.x - HALF_W && bx < this.x + HALF_W &&
               by + 1 > this.y - HALF_W && by < this.y + HALF_W &&
               bz + 1 > this.z && bz < this.z + TALL;
    }

    update(dt, keys) {
        const w = this.world;
        if (dt <= 0) return;
        // if we ever end up inside blocks (e.g. a block appeared on us), climb out upwards
        for (let n = 0; n < 64 && this.collides(this.x, this.y, this.z); n++) { this.z = Math.floor(this.z) + 1; this.vz = 0; }
        this.inWater = w.getBlock(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z + 0.4)) === B.WATER;

        // desired horizontal velocity from WASD, relative to where we look
        let fwd = 0, side = 0;
        if (keys.has("KeyW")) fwd += 1;
        if (keys.has("KeyS")) fwd -= 1;
        if (keys.has("KeyD")) side += 1;
        if (keys.has("KeyA")) side -= 1;
        const fx = Math.cos(this.yaw), fy = Math.sin(this.yaw);
        const rx = Math.sin(this.yaw), ry = -Math.cos(this.yaw);
        let mx = fx * fwd + rx * side, my = fy * fwd + ry * side;
        const m = Math.hypot(mx, my);
        if (m > 0) { mx /= m; my /= m; }

        let speed = this.flying ? FLY : keys.has("ControlLeft") || keys.has("ShiftRight") ? SPRINT : WALK;
        if (this.inWater && !this.flying) speed *= 0.55;
        const grip = this.flying ? 8 : this.onGround ? 14 : 3;
        const k = Math.min(1, dt * grip);
        this.vx += (mx * speed - this.vx) * k;
        this.vy += (my * speed - this.vy) * k;

        if (this.flying) {
            const up = (keys.has("Space") ? 1 : 0) - (keys.has("ShiftLeft") ? 1 : 0);
            this.vz += (up * FLY - this.vz) * Math.min(1, dt * 8);
        } else if (this.inWater) {
            this.vz -= GRAVITY * 0.25 * dt;
            if (keys.has("Space")) this.vz = Math.min(this.vz + 30 * dt, 3.5);
            this.vz = Math.max(this.vz, -3);
        } else {
            this.vz -= GRAVITY * dt;
            if (keys.has("Space") && this.onGround) this.vz = JUMP;
            this.vz = Math.max(this.vz, -50);
        }

        // move one axis at a time in small steps, so fast falls can't tunnel through a block
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(this.vx), Math.abs(this.vy), Math.abs(this.vz)) * dt / 0.4));
        const h = dt / steps;
        this.onGround = false;
        for (let s = 0; s < steps; s++) {
            this.x += this.vx * h;
            if (this.collides(this.x, this.y, this.z)) {
                this.x = this.vx > 0 ? Math.floor(this.x + HALF_W) - HALF_W - EPS : Math.floor(this.x - HALF_W) + 1 + HALF_W + EPS;
                this.vx = 0;
            }
            this.y += this.vy * h;
            if (this.collides(this.x, this.y, this.z)) {
                this.y = this.vy > 0 ? Math.floor(this.y + HALF_W) - HALF_W - EPS : Math.floor(this.y - HALF_W) + 1 + HALF_W + EPS;
                this.vy = 0;
            }
            this.z += this.vz * h;
            if (this.collides(this.x, this.y, this.z)) {
                if (this.vz < 0) { this.z = Math.floor(this.z) + 1; this.onGround = true; }
                else this.z = Math.floor(this.z + TALL) - TALL - EPS;
                this.vz = 0;
            }
        }
        if (this.flying && this.onGround) this.flying = false;   // landing ends flight
        if (this.z < -20) this.spawnAt(Math.floor(this.x), Math.floor(this.y));
    }

    // Voxel DDA along the view ray: first non-air, non-water block within reach, plus the empty cell in front of it
    raycast(reach = 6) {
        const [ox, oy, oz] = this.eye, [dx, dy, dz] = this.dir;
        let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
        const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
        const tdx = sx ? Math.abs(1 / dx) : Infinity, tdy = sy ? Math.abs(1 / dy) : Infinity, tdz = sz ? Math.abs(1 / dz) : Infinity;
        let tmx = sx > 0 ? (x + 1 - ox) * tdx : sx < 0 ? (ox - x) * tdx : Infinity;
        let tmy = sy > 0 ? (y + 1 - oy) * tdy : sy < 0 ? (oy - y) * tdy : Infinity;
        let tmz = sz > 0 ? (z + 1 - oz) * tdz : sz < 0 ? (oz - z) * tdz : Infinity;
        let prev = null, t = 0;
        while (t <= reach) {
            const id = this.world.getBlock(x, y, z);
            if (id !== B.AIR && id !== B.WATER) return { x, y, z, id, prev };
            prev = [x, y, z];
            if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; }
            else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; }
            else { z += sz; t = tmz; tmz += tdz; }
        }
        return null;
    }
}
