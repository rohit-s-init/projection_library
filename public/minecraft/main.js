// Minecraft prototype on top of Space.js.
//
// Near-mesh rendering: only chunks within RENDER_DIST of the player have a mesh. Meshes are built a few per
// frame (nearest first) and dropped when the player walks away; the visible ones are packed into Space's
// posArr/colArr, which are only re-uploaded when that set (or a block) changes. Fog hides the loading edge.
//
// Buffer layout:  [sky dome][Nova][opaque blocks of all chunks][water + glass of all chunks]
// Each frame:
//   1. shadow pass - Space's camera is moved to the sun and the opaque range is drawn into the shadow map
//      (Fancy quality only)
//   2. opaque pass - sky + blocks from the player's eye
//   3. see-through pass - water and glass, blended on top
//
// Nova, the AI companion (companion.js), is a static body mesh right after the sky; the shaders pose it every
// frame from a few uniforms, so she can walk around without re-uploading anything.
// Redstone (redstone.js) ticks 10 times a second; blocks whose state changed are redrawn.

import VoxelSpace from "./VoxelSpace.js";
import { createShaders, setBotUniforms, QUALITY_NAMES } from "./shaders.js";
import { World, CHUNK, HEIGHT, B, BLOCKS, WATER_LEVEL, DIRS, DIRS6, isGate, isSolid, shapeOf, isPiston } from "./world.js";
import { buildChunkMesh, buildSkyDome } from "./mesher.js";
import { Player } from "./player.js";
import { Companion, buildBotMesh } from "./companion.js";
import { Redstone } from "./redstone.js";

const params = new URLSearchParams(location.search);
const RENDER_DIST = Math.max(2, Math.min(10, +params.get("r") || 5));   // in chunks
const SEED = +params.get("seed") || 1337;
const MESH_BUDGET_MS = 8;         // time per frame spent building new chunk meshes
const SHADOWS = params.get("shadows") !== "0";
const SHADOW_RES = 2048;          // shadow map resolution
const SHADOW_SIZE = 56;           // half-width of the area around the player that gets sun shadows (blocks)
const SHADOW_RANGE = 320;         // depth range of the sun camera
const MAX_LIGHTS = 12;            // torches / lamps lighting their surroundings
// towards the sun: late-afternoon light from the south-west, about 42° above the horizon
const SUN_DIR = (() => { const v = [-0.55, -0.42, 0.67], m = Math.hypot(...v); return v.map((x) => x / m); })();

// graphics quality: 2 Fancy (realistic), 1 Fast, 0 Fastest (no realistic shading). ?q=0|1|2 or the menu / G key.
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { } } };
let quality = [params.get("q"), store.get("mc.quality"), "2"].map((v) => (v === null ? NaN : +v)).find((v) => v >= 0 && v <= 2);
// render resolution per quality (device pixel ratio cap and scale)
const RES = [{ cap: 1, scale: 0.75 }, { cap: 1, scale: 1 }, { cap: 1.5, scale: 1 }];

// ------------------------------------------------------------------ canvas + library

const canvas = document.getElementById("view");
/** @type {WebGLRenderingContext} */
const gl = canvas.getContext("webgl", { antialias: true });
if (!gl) throw new Error("WebGL not available");

function sizeCanvas() {
    const r = RES[quality];
    const dpr = Math.min(r.cap, window.devicePixelRatio || 1) * r.scale;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
}
sizeCanvas();
window.addEventListener("resize", sizeCanvas);

const space = new VoxelSpace(gl);
space.magnifier = 1.75;                       // ≈ 85° horizontal field of view
const shaders = createShaders(gl, space, quality);
gl.clearColor(0, 0, 0, 1);

// ------------------------------------------------------------------ shadow map (sun's-eye depth, packed in RGBA)

const shadowTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, shadowTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SHADOW_RES, SHADOW_RES, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
const shadowDepth = gl.createRenderbuffer();
gl.bindRenderbuffer(gl.RENDERBUFFER, shadowDepth);
gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, SHADOW_RES, SHADOW_RES);
const shadowFbo = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, shadowTex, 0);
gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, shadowDepth);
const shadowsOk = SHADOWS && gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
gl.bindFramebuffer(gl.FRAMEBUFFER, null);
const shadowsActive = () => shadowsOk && quality === 2;

// Sun camera axes, from Space's own camera maths (the sun never moves, so they are fixed)
space.lookFrom(0, 0, 0, -SUN_DIR[0], -SUN_DIR[1], -SUN_DIR[2]);
space.updateMyVectors();
const LX = space.xUnitVec.slice(), LY = space.yUnitVec.slice(), LZ = space.zUnitVec.slice();
const light = { c: [0, 0, 0] };

// Place the sun camera over the player. The centre is snapped to whole shadow-map texels, so shadow edges
// don't crawl as the player walks.
function renderShadowMap() {
    const texel = (2 * SHADOW_SIZE) / SHADOW_RES;
    const px = player.x, py = player.y, pz = player.z;
    const dot = (a) => px * a[0] + py * a[1] + pz * a[2];
    const sx = Math.round(dot(LX) / texel) * texel - dot(LX), sy = Math.round(dot(LY) / texel) * texel - dot(LY);
    const cx = px + LX[0] * sx + LY[0] * sy, cy = py + LX[1] * sx + LY[1] * sy, cz = pz + LX[2] * sx + LY[2] * sy;
    const back = SHADOW_RANGE * 0.55;
    light.c = [cx + SUN_DIR[0] * back, cy + SUN_DIR[1] * back, cz + SUN_DIR[2] * back];

    shaders.use(shaders.shadow);
    gl.uniform1f(shaders.shadow.u.shadowSize, SHADOW_SIZE);
    gl.uniform1f(shaders.shadow.u.shadowRange, SHADOW_RANGE);
    gl.uniform1f(shaders.shadow.u.time, time);
    setBotUniforms(gl, shaders.shadow.u, botPose);
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.viewport(0, 0, SHADOW_RES, SHADOW_RES);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    space.lookFrom(light.c[0], light.c[1], light.c[2], -SUN_DIR[0], -SUN_DIR[1], -SUN_DIR[2]);
    space.drawRange(0, opaqueEnd);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    shaders.use(shaders.block);
}

// ------------------------------------------------------------------ world + chunk meshes

const world = new World(SEED);
const player = new Player(world);
const meshes = new Map();                     // "cx,cy" → mesh
const dirty = new Set();                      // chunks to rebuild (edits, redstone state changes)
let meshSetChanged = true;
const skyDome = buildSkyDome();
const botMesh = buildBotMesh();
let opaqueEnd = 0, transCount = 0;            // ranges inside Space's buffers

const key = (cx, cy) => cx + "," + cy;
const chunkOf = (v) => Math.floor(v / CHUNK);

function meshChunk(cx, cy) {
    meshes.set(key(cx, cy), buildChunkMesh(world, cx, cy));
    meshSetChanged = true;
}

// chunks within the render distance, nearest first
function wantedChunks() {
    const pcx = chunkOf(player.x), pcy = chunkOf(player.y);
    const list = [];
    for (let dy = -RENDER_DIST; dy <= RENDER_DIST; dy++)
        for (let dx = -RENDER_DIST; dx <= RENDER_DIST; dx++) {
            const d = Math.hypot(dx, dy);
            if (d <= RENDER_DIST + 0.5) list.push({ cx: pcx + dx, cy: pcy + dy, d });
        }
    return list.sort((a, b) => a.d - b.d);
}

function updateChunks(budgetMs) {
    // edited chunks first, all of them (each rebuilt once however many blocks changed in it)
    for (const k of dirty) {
        const m = meshes.get(k);
        if (m) meshChunk(m.cx, m.cy);
    }
    dirty.clear();
    const wanted = wantedChunks();
    const start = performance.now();
    for (const c of wanted) {
        if (performance.now() - start > budgetMs) break;
        if (!meshes.has(key(c.cx, c.cy))) meshChunk(c.cx, c.cy);
    }
    // forget meshes that are well out of range (block data stays in the world, so edits are kept)
    const pcx = chunkOf(player.x), pcy = chunkOf(player.y);
    for (const [k, m] of meshes) {
        if (Math.hypot(m.cx - pcx, m.cy - pcy) > RENDER_DIST + 1.5) { meshes.delete(k); meshSetChanged = true; }
    }
    if (meshSetChanged) packMeshes();
}

// pack the sky dome and every loaded chunk mesh into one pair of arrays for Space: sky, opaque, see-through
function packMeshes() {
    let opaque = skyDome.count + botMesh.count, trans = 0;
    for (const m of meshes.values()) { opaque += m.count; trans += m.tcount; }
    const total = opaque + trans;
    const pos = new Float32Array(total * 4), col = new Float32Array(total * 4);
    pos.set(skyDome.pos, 0); col.set(skyDome.col, 0);
    pos.set(botMesh.pos, skyDome.count * 4); col.set(botMesh.col, skyDome.count * 4);
    let o = (skyDome.count + botMesh.count) * 4, t = opaque * 4;
    for (const m of meshes.values()) {
        pos.set(m.pos, o); col.set(m.col, o); o += m.count * 4;
        pos.set(m.tpos, t); col.set(m.tcol, t); t += m.tcount * 4;
    }
    space.setMesh(pos, col, total);
    opaqueEnd = opaque;
    transCount = trans;
    meshSetChanged = false;
}

// a block changed shape: redraw its chunk, plus neighbours at borders (face culling, ambient occlusion)
function blockChanged(x, y, z) {
    for (let cy = chunkOf(y - 1); cy <= chunkOf(y + 1); cy++)
        for (let cx = chunkOf(x - 1); cx <= chunkOf(x + 1); cx++)
            dirty.add(key(cx, cy));
}
// only a block's state changed (redstone power, lever...): redraw just its own chunk
function stateChanged(x, y, z) { dirty.add(key(chunkOf(x), chunkOf(y))); }

const facingOf = (yaw) => ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4;   // 0 east, 1 north, 2 west, 3 south
// pistons face the player who places them (like Minecraft): looking down → facing up, and so on
const pistonFacing = () => player.pitch < -0.8 ? 4 : player.pitch > 0.8 ? 5 : (facingOf(player.yaw) + 2) & 3;

// starting state of a freshly placed block
function initialMeta(id, facing) {
    if (id === B.RS_TORCH) return 1;                       // lit
    if (isGate(id)) return facing & 3;
    if (isPiston(id)) return pistonFacing();
    return 0;
}

// the one way blocks are changed (player and Nova)
function editBlock(x, y, z, id, meta) {
    const old = world.getBlock(x, y, z), oldMeta = world.getMeta(x, y, z);
    if (!world.setBlock(x, y, z, id)) return;
    // a piston and its head belong together: breaking one removes / retracts the other
    if (isPiston(old) && (oldMeta & 8) && id !== old) {
        const [dx, dy, dz] = DIRS6[oldMeta & 7];
        if (world.getBlock(x + dx, y + dy, z + dz) === B.PISTON_HEAD) editBlock(x + dx, y + dy, z + dz, B.AIR);
    }
    if (old === B.PISTON_HEAD && id !== old) {
        const [dx, dy, dz] = DIRS6[oldMeta & 7], bx = x - dx, by = y - dy, bz = z - dz;
        if (isPiston(world.getBlock(bx, by, bz))) { world.setMeta(bx, by, bz, world.getMeta(bx, by, bz) & 7); blockChanged(bx, by, bz); }
    }
    const m = meta ?? initialMeta(id, facingOf(player.yaw));
    if (m) world.setMeta(x, y, z, m);
    blockChanged(x, y, z);
    // small parts (dust, torches...) sitting on a block that is gone drop with it
    if (!isSolid(id) && shapeOf(world.getBlock(x, y, z + 1))) editBlock(x, y, z + 1, B.AIR);
}

const redstone = new Redstone(world, stateChanged, blockChanged);

// ------------------------------------------------------------------ spawn

function findSpawn() {
    for (let r = 0; r < 200; r += 4)
        for (let a = 0; a < 8; a++) {
            const x = Math.round(Math.cos(a * Math.PI / 4) * r), y = Math.round(Math.sin(a * Math.PI / 4) * r);
            if (world.heightAt(x, y) > WATER_LEVEL + 1) return [x, y];
        }
    return [0, 0];
}
const [sx, sy] = findSpawn();
player.spawnAt(sx, sy);
updateChunks(400);                             // the chunks right around the player before the first frame

// ------------------------------------------------------------------ input

const keys = new Set();
// The toolkit: 9 active blocks (keys 1-9 / mouse wheel). Edited in the E screen, saved in the browser, and up to
// 3 whole toolkits can be stored as sets and loaded again.
const TOOLKIT_SIZE = 9;
const DEFAULT_TOOLKIT = [B.GRASS, B.COBBLE, B.PLANKS, B.GLASS, B.REDSTONE, B.LEVER, B.LAMP, B.PISTON, B.AND];
const ALL_BLOCKS = BLOCKS.filter((b) => b && b.id !== B.AIR && !b.hidden).map((b) => b.id);
const validToolkit = (t) => Array.isArray(t) && t.length === TOOLKIT_SIZE && t.every((id) => ALL_BLOCKS.includes(id));
const loadJSON = (k) => { try { return JSON.parse(store.get(k)); } catch { return null; } };
const HOTBAR = validToolkit(loadJSON("mc.toolkit")) ? loadJSON("mc.toolkit") : DEFAULT_TOOLKIT.slice();
const toolkitSets = (() => { const s = loadJSON("mc.toolkitSets"); return Array.isArray(s) && s.length === 3 ? s.map((t) => (validToolkit(t) ? t : null)) : [null, null, null]; })();
const saveToolkit = () => store.set("mc.toolkit", JSON.stringify(HOTBAR));
let slot = 0;
let target = null;
let inventoryOpen = false;

window.addEventListener("keydown", (e) => {
    if (chatOpen) {
        if (e.code === "Enter") { const t = chatInput.value; closeChat(); nova.chat(t); e.preventDefault(); }
        else if (e.code === "Escape") closeChat();
        return;                                            // typing: don't move the player
    }
    if (inventoryOpen) {
        if (e.code === "KeyE" || e.code === "Escape") closeInventory(true);
        return;
    }
    if (document.pointerLockElement !== canvas) return;
    if (e.code === "KeyT" || e.code === "Enter") { openChat(); e.preventDefault(); return; }
    if (e.code === "KeyE") { openInventory(); e.preventDefault(); return; }
    keys.add(e.code);
    if (/^Digit[1-9]$/.test(e.code)) selectSlot(+e.code.slice(5) - 1);
    if (e.code === "KeyF") player.flying = !player.flying;
    if (e.code === "KeyG") setQuality((quality + 2) % 3);  // Fancy → Fast → Fastest → Fancy
    if (["Space", "ControlLeft", "Tab"].includes(e.code)) e.preventDefault();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());

const overlayEl = document.getElementById("overlay");
const lockMouse = () => { if (document.pointerLockElement !== canvas) canvas.requestPointerLock(); };
canvas.addEventListener("click", lockMouse);
overlayEl.addEventListener("click", (e) => { if (!e.target.closest("#settings")) lockMouse(); });
document.addEventListener("pointerlockchange", () => {
    const locked = document.pointerLockElement === canvas;
    overlayEl.style.display = locked || inventoryOpen ? "none" : "grid";
    if (!locked) { keys.clear(); closeChat(); }
});
document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement === canvas) player.look(e.movementX, e.movementY);
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// hold a button to keep breaking / placing, like the real game
const held = { 0: false, 2: false };
let actionCooldown = 0;
canvas.addEventListener("mousedown", (e) => {
    if (document.pointerLockElement !== canvas) return;
    if (e.button === 1) { if (target) pickBlock(target.id); return; }
    if (e.button in held) { held[e.button] = true; actionCooldown = act(e.button) ? 1e9 : 0.25; }
});
window.addEventListener("mouseup", (e) => { if (e.button in held) held[e.button] = false; });
window.addEventListener("wheel", (e) => {
    if (document.pointerLockElement !== canvas) return;
    selectSlot((slot + (e.deltaY > 0 ? 1 : -1) + HOTBAR.length) % HOTBAR.length);
});

// right click on a lever / button uses it (for the player and for Nova)
function interact(x, y, z) {
    const id = world.getBlock(x, y, z);
    if (id === B.LEVER) { redstone.toggleLever(x, y, z); return true; }
    if (id === B.BUTTON) { redstone.press(x, y, z); return true; }
    return false;
}

// returns true when the click used a switch (so holding the button doesn't keep flipping it)
function act(button) {
    if (!target) return false;
    if (button === 0) {
        // water next to the hole flows in (one step, enough for a prototype)
        const n = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]];
        const wet = n.some(([dx, dy, dz]) => world.getBlock(target.x + dx, target.y + dy, target.z + dz) === B.WATER);
        editBlock(target.x, target.y, target.z, wet ? B.WATER : B.AIR);
        nova.notePlayerEdit("break");
    } else if (button === 2) {
        if (interact(target.x, target.y, target.z)) return true;
        if (!target.prev) return;
        const [x, y, z] = target.prev, id = HOTBAR[slot];
        if (player.overlapsBlock(x, y, z) && isSolid(id)) return;
        if (nova.bot.overlapsBlock(x, y, z) && isSolid(id)) return;
        if (z < 0 || z >= HEIGHT) return;
        // small parts need a solid block to stand on
        if (shapeOf(id) && !isSolid(world.getBlock(x, y, z - 1))) { toast("That needs a solid block under it"); return; }
        editBlock(x, y, z, id);
        nova.notePlayerEdit("place");
    }
}

// ------------------------------------------------------------------ HUD: hotbar, inventory, settings, toast

const hotbarEl = document.getElementById("hotbar");
const infoEl = document.getElementById("info");
const invEl = document.getElementById("inventory");
const toastEl = document.getElementById("toast");
const css = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
const swatch = (id) => {
    const b = BLOCKS[id];
    return `<div class="swatch" style="background:linear-gradient(${css(b.top)} 0 35%, ${css(b.side)} 35%)"></div>`;
};

function renderHotbar() {
    hotbarEl.innerHTML = "";
    HOTBAR.forEach((id, i) => {
        const el = document.createElement("div");
        el.className = "slot" + (i === slot ? " active" : "");
        el.innerHTML = `${swatch(id)}<span>${i + 1}</span>`;
        el.title = BLOCKS[id].name;
        hotbarEl.appendChild(el);
    });
    renderToolkitEditor();
}
function setSlot(i, id) {
    HOTBAR[i] = id;
    saveToolkit();
    renderHotbar();
    selectSlot(slot);
}
function selectSlot(i) {
    slot = i;
    [...hotbarEl.children].forEach((el, k) => el.classList.toggle("active", k === i));
    document.getElementById("blockname").textContent = BLOCKS[HOTBAR[i]].name;
}
// middle click: select the block if it's on the hotbar, otherwise put it in the current slot
function pickBlock(id) {
    const i = HOTBAR.indexOf(id);
    if (i >= 0) selectSlot(i);
    else if (ALL_BLOCKS.includes(id)) setSlot(slot, id);
}

// ---- toolkit editor (E): pick a slot at the top, then click (or drag) blocks from the list into it
const invGrid = invEl.querySelector(".grid");
const kitEl = invEl.querySelector(".toolkit");
const setsEl = invEl.querySelector(".sets");
let editSlot = 0;

function renderToolkitEditor() {
    kitEl.innerHTML = "";
    HOTBAR.forEach((id, i) => {
        const el = document.createElement("button");
        el.className = "kslot" + (i === editSlot ? " editing" : "");
        el.innerHTML = `${swatch(id)}<span class="n">${i + 1}</span><span class="name">${BLOCKS[id].name}</span>`;
        el.title = "Click to choose what goes here, or drop a block on it";
        el.addEventListener("click", () => { editSlot = i; renderToolkitEditor(); });
        el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
        el.addEventListener("dragleave", () => el.classList.remove("over"));
        el.addEventListener("drop", (e) => { e.preventDefault(); const id2 = +e.dataTransfer.getData("text/plain"); if (ALL_BLOCKS.includes(id2)) { editSlot = i; setSlot(i, id2); } });
        kitEl.appendChild(el);
    });
    invEl.querySelector(".slotinfo").textContent = `Editing slot ${editSlot + 1} — click a block below (or drag one onto any slot). Changes are saved automatically.`;
    setsEl.innerHTML = "";
    toolkitSets.forEach((set, i) => {
        const box = document.createElement("div");
        box.className = "set";
        box.innerHTML = `<b>Set ${i + 1}</b><div class="mini">${set ? set.map((id) => swatch(id)).join("") : "<i>empty</i>"}</div>`;
        const save = document.createElement("button"), load = document.createElement("button");
        save.textContent = "Save"; load.textContent = "Load"; load.disabled = !set;
        save.addEventListener("click", () => { toolkitSets[i] = HOTBAR.slice(); store.set("mc.toolkitSets", JSON.stringify(toolkitSets)); renderToolkitEditor(); toast(`Toolkit saved to set ${i + 1}`); });
        load.addEventListener("click", () => { toolkitSets[i].forEach((id, k) => (HOTBAR[k] = id)); saveToolkit(); renderHotbar(); selectSlot(slot); toast(`Loaded set ${i + 1}`); });
        box.append(save, load);
        setsEl.appendChild(box);
    });
}
invEl.querySelector(".reset").addEventListener("click", () => { DEFAULT_TOOLKIT.forEach((id, k) => (HOTBAR[k] = id)); saveToolkit(); renderHotbar(); selectSlot(slot); });
invEl.querySelector(".done").addEventListener("click", () => closeInventory(true));

for (const id of ALL_BLOCKS) {
    const el = document.createElement("button");
    el.className = "item";
    el.draggable = true;
    el.innerHTML = `${swatch(id)}<span>${BLOCKS[id].name}</span>`;
    el.addEventListener("click", () => { setSlot(editSlot, id); editSlot = (editSlot + 1) % TOOLKIT_SIZE; renderToolkitEditor(); });
    el.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", String(id)));
    invGrid.appendChild(el);
}
renderHotbar();
selectSlot(0);

function openInventory() {
    inventoryOpen = true;
    keys.clear();
    editSlot = slot;
    renderToolkitEditor();
    invEl.style.display = "grid";
    document.exitPointerLock();
}
function closeInventory(relock) {
    inventoryOpen = false;
    invEl.style.display = "none";
    if (relock) lockMouse();
}
invEl.addEventListener("click", (e) => { if (e.target === invEl) closeInventory(true); });

let toastTimer = 0;
function toast(text) {
    toastEl.textContent = text;
    toastEl.style.opacity = 1;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.style.opacity = 0), 1800);
}

// graphics quality menu (on the pause screen) and G key
const qualityButtons = [...document.querySelectorAll("#settings button[data-q]")];
qualityButtons.forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); setQuality(+b.dataset.q); }));
function setQuality(q) {
    quality = q;
    store.set("mc.quality", String(q));
    shaders.setQuality(q);
    sizeCanvas();
    qualityButtons.forEach((b) => b.classList.toggle("active", +b.dataset.q === q));
    toast(`Graphics: ${QUALITY_NAMES[q]}`);
}
qualityButtons.forEach((b) => b.classList.toggle("active", +b.dataset.q === quality));

// ------------------------------------------------------------------ Nova: chat, name tag, speech bubble, brain

const chatLog = document.getElementById("chatlog");
const chatInput = document.getElementById("chatinput");
const tagEl = document.getElementById("novatag");
const bubbleEl = document.getElementById("novabubble");
const brainEl = document.getElementById("brain");
let chatOpen = false;

function addChat(who, text, kind = "nova") {
    const line = document.createElement("div");
    line.className = `line ${kind}`;
    line.innerHTML = `<b></b> <span></span>`;
    line.querySelector("b").textContent = who + ":";
    line.querySelector("span").textContent = text;
    chatLog.appendChild(line);
    while (chatLog.children.length > 40) chatLog.firstChild.remove();
    chatLog.scrollTop = chatLog.scrollHeight;
    setTimeout(() => line.classList.add("old"), 12000);
}
function openChat() {
    chatOpen = true;
    keys.clear();
    chatInput.value = "";
    document.body.classList.add("chatting");
    chatInput.focus();
}
function closeChat() {
    if (!chatOpen) return;
    chatOpen = false;
    chatInput.blur();
    document.body.classList.remove("chatting");
}

const nova = new Companion({ world, player, editBlock, interact, ui: { chat: addChat } });
let botPose = nova.uniforms();

// world point → CSS pixels on screen (same projection as the shader, including the flipped x axis)
function toScreen(x, y, z) {
    const X = space.xUnitVec, Y = space.yUnitVec, Z = space.zUnitVec;
    const dx = x - space.Xc, dy = y - space.Yc, dz = z - space.Zc;
    const zp = dx * Z[0] + dy * Z[1] + dz * Z[2];
    if (zp < 0.2) return null;
    const k = space.magnifier / 1.6 / zp, aspect = canvas.width / canvas.height;
    const sx = -(dx * X[0] + dy * X[1] + dz * X[2]) * k, sy = (dx * Y[0] + dy * Y[1] + dz * Y[2]) * k * aspect;
    return [(sx + 1) / 2 * window.innerWidth, (1 - sy) / 2 * window.innerHeight, zp];
}

function updateNovaHud() {
    const b = nova.bot;
    const s = toScreen(b.x, b.y, b.z + 2.35);
    const visible = s && s[2] < RENDER_DIST * CHUNK * 0.8;
    tagEl.style.display = visible ? "block" : "none";
    const talking = nova.thinking || performance.now() / 1000 < nova.bubbleUntil;
    bubbleEl.style.display = visible && talking ? "block" : "none";
    if (!visible) return;
    const scale = Math.max(0.6, Math.min(1.2, 8 / s[2]));
    tagEl.style.transform = `translate(${s[0]}px, ${s[1]}px) translate(-50%, -100%) scale(${scale})`;
    tagEl.textContent = nova.task ? `Nova · ${nova.task.label}` : "Nova";
    if (talking) {
        bubbleEl.textContent = nova.thinking && performance.now() / 1000 >= nova.bubbleUntil ? "…" : nova.bubble;
        bubbleEl.style.transform = `translate(${s[0]}px, ${s[1] - 26 * scale}px) translate(-50%, -100%)`;
    }
}

// how much of Nova's Groq allowance is left (from the rate-limit headers the server passes on)
function updateBrainHud() {
    const br = nova.brain, fmt = (n) => (n == null ? "–" : Number(n).toLocaleString());
    const bar = (left, total) => {
        const f = left != null && total ? Math.max(0, Math.min(1, left / total)) : 0;
        return `<div class="bar"><i style="width:${(f * 100).toFixed(0)}%;background:${f > 0.4 ? "#5fd08a" : f > 0.15 ? "#f0c24f" : "#ef6b5b"}"></i></div>`;
    };
    brainEl.innerHTML =
        `<div class="title">Nova's brain${nova.thinking ? " · thinking…" : ""}</div>` +
        `<div class="row"><span>Tokens this minute</span><b>${fmt(br.tokensRemaining)} / ${fmt(br.tokensLimit)}</b></div>${bar(br.tokensRemaining, br.tokensLimit)}` +
        `<div class="row"><span>Requests today</span><b>${fmt(br.requestsRemaining)} / ${fmt(br.requestsLimit)}</b></div>${bar(br.requestsRemaining, br.requestsLimit)}` +
        `<div class="row small"><span>Last reply</span><b>${fmt(br.lastTokens)} tokens</b></div>` +
        `<div class="row small"><span>This session</span><b>${fmt(br.sessionTokens)} tokens · ${br.calls} replies</b></div>` +
        (br.resetRequests ? `<div class="row small"><span>Requests reset in</span><b>${br.resetRequests}</b></div>` : "") +
        (br.error ? `<div class="row small err">${br.error}</div>` : "");
}

// ------------------------------------------------------------------ point lights (torches, lamps)

const LIGHT_COLORS = { [B.TORCH]: [2.2, 1.36, 0.55], [B.RS_TORCH]: [1.2, 0.14, 0.05], [B.LAMP]: [2.6, 1.95, 1.1] };
const ptPos = new Float32Array(MAX_LIGHTS * 3), ptCol = new Float32Array(MAX_LIGHTS * 3);
function gatherLights() {
    const list = [];
    for (const k of world.components) {
        const [x, y, z] = k.split(",").map(Number), id = world.getBlock(x, y, z);
        const on = id === B.TORCH || ((id === B.RS_TORCH || id === B.LAMP) && world.getMeta(x, y, z) & 1);
        if (!on) continue;
        const d = Math.hypot(x - player.x, y - player.y, z - player.z);
        if (d < 40) list.push({ x: x + 0.5, y: y + 0.5, z: z + (id === B.LAMP ? 0.5 : 0.62), id, d });
    }
    list.sort((a, b) => a.d - b.d);
    const n = Math.min(MAX_LIGHTS, list.length);
    for (let i = 0; i < n; i++) {
        ptPos.set([list[i].x, list[i].y, list[i].z], i * 3);
        ptCol.set(LIGHT_COLORS[list[i].id], i * 3);
    }
    return n;
}

// ------------------------------------------------------------------ loop

let last = performance.now(), time = 0, frames = 0, fpsTime = last, fps = 0, tickAcc = 0;
const FACING_NAMES = ["east", "north", "west", "south"];
const FACING_NAMES6 = ["east", "north", "west", "south", "up", "down"];

function describe(t) {
    if (!t) return "";
    const b = BLOCKS[t.id], m = world.getMeta(t.x, t.y, t.z);
    let s = ` · looking at ${b.name}`;
    if (t.id === B.REDSTONE) s += ` (power ${m & 15})`;
    else if (t.id === B.LEVER || t.id === B.BUTTON) s += m & 1 ? " (on)" : " (off) — right click to use";
    else if (t.id === B.RS_TORCH || t.id === B.LAMP) s += m & 1 ? " (lit)" : " (off)";
    else if (isGate(t.id)) s += ` → output ${FACING_NAMES[m & 3]}: ${m & 4 ? "ON" : "off"}` + (t.id === B.NOT ? ` · input back: ${m & 8 ? "on" : "off"}` : ` · inputs left ${m & 8 ? "on" : "off"}, right ${m & 16 ? "on" : "off"}`);
    else if (isPiston(t.id)) s += ` (facing ${FACING_NAMES6[m & 7]}, ${m & 8 ? "extended" : "retracted"})`;
    return s;
}

function frame(now) {
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));   // the first rAF timestamp can be older than `last`
    last = now;
    time += dt;

    player.update(dt, keys);
    nova.update(dt, target);
    botPose = nova.uniforms();
    // redstone: fixed 10 ticks per second
    tickAcc += dt;
    for (let n = 0; tickAcc >= 0.1 && n < 3; n++) { redstone.tick(); tickAcc -= 0.1; }
    tickAcc = Math.min(tickAcc, 0.1);
    updateChunks(MESH_BUDGET_MS);

    target = player.raycast();
    if (target && (held[0] || held[2])) {
        actionCooldown -= dt;
        if (actionCooldown <= 0) { act(held[0] ? 0 : 2); actionCooldown = 0.22; target = player.raycast(); }
    }

    // 1. shadows from the sun
    if (shadowsActive()) renderShadowMap();

    // 2. + 3. the world from the player's eye
    const U = shaders.block.u;
    const [ex, ey, ez] = player.eye, [dx, dy, dz] = player.dir;
    space.lookFrom(ex, ey, ez, dx, dy, dz);
    const underwater = world.getBlock(Math.floor(ex), Math.floor(ey), Math.floor(ez)) === B.WATER;

    gl.uniform1f(U.aspect, canvas.width / canvas.height);
    gl.uniform1f(U.time, time);
    gl.uniform3fv(U.sunDir, SUN_DIR);
    gl.uniform1f(U.renderEnd, RENDER_DIST * CHUNK);
    gl.uniform1f(U.underwater, underwater ? 1 : 0);
    gl.uniform3fv(U.selBlock, target ? [target.x, target.y, target.z] : [0, 0, -999]);
    gl.uniform1f(U.selActive, target ? 1 : 0);
    gl.uniform1f(U.shadowOn, shadowsActive() ? 1 : 0);
    gl.uniform3fv(U.lightC, light.c);
    gl.uniform3fv(U.lightX, LX);
    gl.uniform3fv(U.lightY, LY);
    gl.uniform3fv(U.lightZ, LZ);
    gl.uniform1f(U.shadowSize, SHADOW_SIZE);
    gl.uniform1f(U.shadowRange, SHADOW_RANGE);
    gl.uniform1f(U.shadowTexel, 1 / SHADOW_RES);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, shadowTex);
    gl.uniform1i(U.shadowMap, 0);
    const nLights = quality > 0 ? gatherLights() : 0;
    gl.uniform3fv(U.ptPos, ptPos);
    gl.uniform3fv(U.ptCol, ptCol);
    gl.uniform1f(U.ptCount, nLights);

    setBotUniforms(gl, U, botPose);

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    space.drawRange(0, opaqueEnd);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    space.drawRange(opaqueEnd, transCount);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    updateNovaHud();

    frames++;
    if (now - fpsTime > 500) {
        fps = Math.round(frames * 1000 / (now - fpsTime)); frames = 0; fpsTime = now;
        infoEl.textContent =
            `${fps} fps · ${meshes.size} chunks · ${(space.totalVert / 3 | 0).toLocaleString()} tris · ${QUALITY_NAMES[quality]} (G)\n` +
            `xyz ${player.x.toFixed(1)} ${player.y.toFixed(1)} ${player.z.toFixed(1)}` +
            `${player.flying ? " · flying" : ""}${describe(target)}`;
        updateBrainHud();
    }
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
