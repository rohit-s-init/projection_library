// Realistic block shaders. They use the same attributes and camera uniforms as Space.js (pos, col, cPoint,
// xAxis, yAxis, zAxis, veriables), so Space's buffers and draw calls drive them unchanged.
//
// Two programs:
//   shadow  - renders the world from the sun (orthographic, through Space's camera maths) into a depth map
//   block   - the main pass:
//       · sunlight from the face normal (with a small per-pixel bump from the block texture), soft shadows
//         from the shadow map (filtered over 9 samples)
//       · sky light from above, warm bounce light from below, baked ambient occlusion in the corners
//       · specular highlights per material, light shining through leaves
//       · gradient sky with a sun disk, sun glow and drifting clouds (drawn on a dome around the camera)
//       · water with animated waves, sky reflection (Fresnel), sun glints, transparency
//       · glass with a frame, reflections and transparency
//       · aerial-perspective fog that takes the sky's colour, underwater fog
//       · linear-light maths, ACES tone mapping and gamma correction
//       · redstone parts drawn from their state, glowing torches/lamps/wires, and up to 12 point lights
//         (torches, lit redstone torches, lamps) lighting the blocks around them
//
// Quality levels (#define QUALITY, chosen in the game):
//   2 Fancy   - everything above
//   1 Fast    - no shadow map, clouds or water noise; keeps the lighting model, bumps and point lights
//   0 Fastest - no realistic shading at all: classic flat face shading, simple fog, flat water
//
// Space's xUnitVec points to screen-left, so screen x uses -dot(d, xAxis); otherwise the image is mirrored.

const COMMON = `
const float ID_WATER = 5.0;
const float ID_BOT = 62.0;
const float ID_LEAVES = 7.0;
const float ID_GLASS = 9.0;
const float ID_SKY = 63.0;

// leaves sway a little in the wind; a function of position only, so neighbouring blocks stay joined
vec3 sway(vec3 p, float t) {
    float s = sin(t * 1.7 + p.x * 0.9 + p.z * 0.6) + 0.5 * sin(t * 2.9 + p.y * 1.3);
    return vec3(0.035 * s, 0.03 * s, 0.015 * sin(t * 2.3 + p.x + p.y));
}
`;

// The companion's body: model-space boxes tagged with a part number (pos.w - 2), posed here every frame from a
// few uniforms, so moving it never touches the vertex buffers.
const BOT = `
uniform vec3 botPos;
uniform float botYaw;
uniform float botPhase;      // walk cycle
uniform float botAmp;        // how much the limbs swing
uniform float botArm;        // extra right-arm swing (placing blocks, waving)
uniform float botHead;       // head turn
uniform float botBob;        // up/down offset (dancing, crouching)

vec3 rotY(vec3 p, vec3 c, float a) { p -= c; float s = sin(a), k = cos(a); return vec3(k * p.x + s * p.z, p.y, -s * p.x + k * p.z) + c; }
vec3 rotZ(vec3 p, vec3 c, float a) { p -= c; float s = sin(a), k = cos(a); return vec3(k * p.x - s * p.y, s * p.x + k * p.y, p.z) + c; }

vec3 faceNormal(float face) {
    return face < 0.5 ? vec3(1, 0, 0) : face < 1.5 ? vec3(-1, 0, 0) : face < 2.5 ? vec3(0, 1, 0)
         : face < 3.5 ? vec3(0, -1, 0) : face < 4.5 ? vec3(0, 0, 1) : vec3(0, 0, -1);
}

vec3 botPose(vec3 p, float part) {
    float sw = sin(botPhase) * botAmp;
    if (part == 4.0) p = rotY(p, vec3(0.0, 0.0, 0.75), sw);
    else if (part == 5.0) p = rotY(p, vec3(0.0, 0.0, 0.75), -sw);
    else if (part == 2.0) p = rotY(p, vec3(0.0, 0.0, 1.42), -sw * 0.8);
    else if (part == 3.0) p = rotY(p, vec3(0.0, 0.0, 1.42), sw * 0.8 + botArm);
    else if (part == 1.0) p = rotZ(p, vec3(0.0, 0.0, 1.5), botHead);
    p.z += botBob;
    return botPos + rotZ(p, vec3(0.0), botYaw);
}
`;

export const SHADOW_VERT = `
attribute vec4 pos;
attribute vec4 col;
uniform vec3 cPoint;
uniform vec3 xAxis;
uniform vec3 yAxis;
uniform vec3 zAxis;
uniform float shadowSize;
uniform float shadowRange;
uniform float time;
varying float vDepth;
${COMMON}
${BOT}
void main() {
    float id = floor(floor(col.a + 0.5) / 8.0);
    vec3 p = pos.xyz;
    if (id == ID_LEAVES) p += sway(p, time);
    else if (id == ID_BOT) p = botPose(p, pos.w - 2.0);
    vec3 d = p - cPoint;
    vDepth = dot(d, zAxis) / shadowRange;
    gl_Position = vec4(dot(d, xAxis) / shadowSize, dot(d, yAxis) / shadowSize, vDepth * 2.0 - 1.0, 1.0);
    if (id == ID_SKY) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);      // the sky casts no shadow
}`;

export const SHADOW_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying float vDepth;
// depth packed into 4 bytes (works without the depth-texture extension)
vec4 packDepth(float d) {
    vec4 e = fract(vec4(1.0, 255.0, 65025.0, 16581375.0) * d);
    return e - e.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
}
void main() { gl_FragColor = packDepth(clamp(vDepth, 0.0, 1.0)); }`;

export const BLOCK_VERT = `
attribute vec4 pos;
attribute vec4 col;
uniform vec3 cPoint;
uniform vec3 xAxis;
uniform vec3 yAxis;
uniform vec3 zAxis;
uniform vec3 veriables;     // (zShifter, magnifier, -) — Space's uniform; magnifier sets the field of view
uniform float aspect;
uniform float time;

varying vec3 vWorld;
varying vec3 vToCam;
varying vec3 vAlbedo;
varying float vInfo;
varying float vAO;
varying vec3 vBotN;           // companion only: posed normal
varying vec3 vBotLocal;       // companion only: model-space position (for the face)
varying float vBotPart;

const float NEAR = 0.05;
const float FAR = 900.0;
${COMMON}
${BOT}
void main() {
    float info = floor(col.a + 0.5);
    float id = floor(info / 8.0);
    vec3 p = pos.xyz;
    vBotN = vec3(0.0); vBotLocal = pos.xyz; vBotPart = 0.0;
    if (id == ID_SKY) p = cPoint + p * 500.0;            // dome follows the camera
    else if (id == ID_LEAVES) p += sway(p, time);
    else if (id == ID_BOT) {
        vBotPart = pos.w - 2.0;
        p = botPose(pos.xyz, vBotPart);
        vBotN = rotZ(faceNormal(mod(info, 8.0)), vec3(0.0), botYaw + (vBotPart == 1.0 ? botHead : 0.0));
    }

    vec3 d = p - cPoint;
    float xProj = -dot(d, xAxis);                         // Space's x axis points left: flip to screen-right
    float yProj = dot(d, yAxis);
    float zProj = dot(d, zAxis);
    float k = veriables.y / 1.6;
    gl_Position = vec4(xProj * k, yProj * k * aspect,
                       zProj * (FAR + NEAR) / (FAR - NEAR) - 2.0 * FAR * NEAR / (FAR - NEAR),
                       zProj);
    if (id == ID_SKY) gl_Position.z = gl_Position.w * 0.99999;   // behind everything

    vWorld = p;
    vToCam = cPoint - p;
    vAlbedo = col.rgb;
    vInfo = info;
    vAO = id == ID_SKY || id == ID_BOT ? 1.0 : pos.w;
}`;

export const BLOCK_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec3 vWorld;
varying vec3 vToCam;
varying vec3 vAlbedo;
varying float vInfo;
varying float vAO;
varying vec3 vBotN;
varying vec3 vBotLocal;
varying float vBotPart;

uniform vec3 sunDir;          // towards the sun
uniform float time;
uniform float renderEnd;      // distance where the loaded world ends
uniform float underwater;
uniform vec3 selBlock;
uniform float selActive;

uniform sampler2D shadowMap;
uniform float shadowOn;
uniform vec3 lightC;          // sun camera position and axes (captured from Space during the shadow pass)
uniform vec3 lightX;
uniform vec3 lightY;
uniform vec3 lightZ;
uniform float shadowSize;
uniform float shadowRange;
uniform float shadowTexel;

uniform vec3 ptPos[12];       // point lights (torches, lamps): position and colour
uniform vec3 ptCol[12];
uniform float ptCount;
${COMMON}
const vec3 SUN_COL = vec3(1.0, 0.9, 0.76) * 2.7;
const vec3 SKY_AMB = vec3(0.34, 0.48, 0.72) * 0.85;
const vec3 GROUND_AMB = vec3(0.3, 0.26, 0.2) * 0.45;
const vec3 WATER_FOG = vec3(0.015, 0.09, 0.14);

float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
    return s;
}

// sky colour in a direction (linear light); sun = include the sun disk and clouds
vec3 sky(vec3 dir, bool sun) {
    float h = dir.z;
    vec3 zenith = vec3(0.07, 0.2, 0.52), horizon = vec3(0.55, 0.68, 0.85);
    vec3 c = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.45));
    if (h < 0.0) c = mix(horizon, vec3(0.3, 0.33, 0.36), clamp(-h * 3.0, 0.0, 1.0));
    float sd = max(dot(dir, sunDir), 0.0);
    c += vec3(1.0, 0.75, 0.5) * (0.35 * pow(sd, 6.0) + 0.6 * pow(sd, 48.0));          // glow around the sun
    if (sun) {
#if QUALITY >= 2
        if (h > 0.0) {
            vec2 cp = dir.xy / (h + 0.12) * 1.3 + vec2(time * 0.012, time * 0.004);
            float n = fbm(cp * 1.6);
            float cover = smoothstep(0.48, 0.78, n) * smoothstep(0.0, 0.18, h);
            float lit = 0.75 + 0.5 * smoothstep(0.5, 0.85, n) * (0.5 + 0.5 * sd);
            vec3 cloud = mix(vec3(0.62, 0.66, 0.74), vec3(1.05, 1.0, 0.95), lit - 0.5) + vec3(1.0, 0.8, 0.6) * 0.4 * pow(sd, 8.0);
            c = mix(c, cloud, cover);
        }
#endif
        c += SUN_COL * 12.0 * smoothstep(0.99955, 0.99975, sd);                          // sun disk
    }
    return c;
}

float unpackDepth(vec4 c) { return dot(c, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0)); }

// 0 = fully in shadow, 1 = fully lit (3×3 filtered, fades out at the edge of the shadow map)
float shadowAt(vec3 wp) {
#if QUALITY < 2
    return 1.0;
#else
    if (shadowOn < 0.5) return 1.0;
    vec3 d = wp - lightC;
    vec2 uv = vec2(dot(d, lightX), dot(d, lightY)) / shadowSize * 0.5 + 0.5;
    float depth = dot(d, lightZ) / shadowRange - 0.0006;
    float edge = smoothstep(0.0, 0.06, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
    if (edge <= 0.0) return 1.0;
    float lit = 0.0;
    for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++)
            lit += depth > unpackDepth(texture2D(shadowMap, uv + vec2(float(x), float(y)) * shadowTexel)) ? 0.0 : 1.0;
    return mix(1.0, lit / 9.0, edge);
#endif
}

vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 finish(vec3 c) {
    vec3 t = aces(c * 0.5);                                  // exposure + filmic tone curve
    t = mix(vec3(dot(t, vec3(0.2126, 0.7152, 0.0722))), t, 1.15);   // a touch more colour
    return pow(clamp(t, 0.0, 1.0), vec3(1.0 / 2.2));
}

// animated water surface normal: a few crossing wave trains
vec3 waterNormal(vec2 p, float t) {
    vec2 g = vec2(0.0);
    vec2 d1 = vec2(0.8, 0.6), d2 = vec2(-0.5, 0.86), d3 = vec2(0.2, -0.98), d4 = vec2(-0.9, -0.3);
    g += d1 * 0.9 * 0.08 * cos(dot(d1, p) * 0.9 + t * 1.3);
    g += d2 * 1.7 * 0.05 * cos(dot(d2, p) * 1.7 + t * 1.9);
    g += d3 * 3.1 * 0.025 * cos(dot(d3, p) * 3.1 + t * 2.7);
    g += d4 * 5.3 * 0.014 * cos(dot(d4, p) * 5.3 + t * 3.6);
#if QUALITY >= 2
    g += (vec2(vnoise(p * 2.5 + t * 0.7), vnoise(p * 2.5 - t * 0.6 + 7.0)) - 0.5) * 0.3;
#endif
    return normalize(vec3(-g, 1.0));
}

// aerial perspective / underwater fog
vec3 atmosphere(vec3 color, float dist, vec3 viewDir) {
    float fog;
    vec3 fogCol;
    if (underwater > 0.5) {
        fog = 1.0 - exp(-dist * 0.11);
        fogCol = WATER_FOG;
    } else {
        fog = 1.0 - exp(-dist * 0.0065 * exp(-max(vWorld.z - 28.0, 0.0) * 0.02));
        fog = max(fog, smoothstep(renderEnd * 0.7, renderEnd, dist));        // hide the edge of the loaded world
        fogCol = sky(viewDir, false);
    }
    return mix(color, fogCol, fog);
}

// the companion: flat-coloured clothes and skin, a simple face, lit and shadowed like everything else
vec3 shadeBot(vec3 viewDir) {
    vec3 N = normalize(vBotN);
    vec3 c = vAlbedo;
    float face = mod(floor(vInfo + 0.5), 8.0);
    if (vBotPart == 1.0 && face < 0.5 && vBotLocal.z < 1.9) {           // front of the head
        vec2 q = vBotLocal.yz;
        if (abs(abs(q.x) - 0.11) < 0.055 && abs(q.y - 1.76) < 0.045) c = abs(abs(q.x) - 0.11) < 0.025 ? vec3(0.1, 0.25, 0.55) : vec3(0.95);
        if (abs(q.x) < 0.08 && abs(q.y - 1.61) < 0.018) c = vec3(0.55, 0.28, 0.25);
    }
    vec3 albedo = pow(c, vec3(2.2));
    // Nova is thin, rounded-off geometry that moves every frame: sample the shadow map further off her surface
    // (and a little towards the sun) so she doesn't speckle with her own shadow
    float sh = dot(N, sunDir) > 0.0 ? shadowAt(vWorld + N * 0.3 + sunDir * 0.2) : 0.0;
    vec3 ambient = mix(GROUND_AMB, SKY_AMB, N.z * 0.5 + 0.5);
    float spec = 0.08 * pow(max(dot(N, normalize(sunDir - viewDir)), 0.0), 16.0);
    return albedo * (SUN_COL * max(dot(N, sunDir), 0.0) * sh + ambient) + SUN_COL * spec * sh;
}

void main() {
    float info = floor(vInfo + 0.5);
    float face = mod(info, 8.0);
    float id = floor(info / 8.0);
    vec3 viewDir = normalize(-vToCam);          // camera → pixel
    float dist = length(vToCam);

#if QUALITY == 0
    if (id == ID_SKY) {
        gl_FragColor = vec4(underwater > 0.5 ? vec3(0.1, 0.25, 0.45) : mix(vec3(0.62, 0.76, 0.92), vec3(0.33, 0.52, 0.88), clamp(viewDir.z, 0.0, 1.0)), 1.0);
        return;
    }
    if (id == ID_BOT) {
        gl_FragColor = vec4(vAlbedo * (0.55 + 0.45 * max(dot(normalize(vBotN), sunDir), 0.0)), 1.0);
        return;
    }
#else
    if (id == ID_SKY) {
        vec3 c = underwater > 0.5 ? WATER_FOG : sky(viewDir, true);
        gl_FragColor = vec4(finish(c), 1.0);
        return;
    }
    if (id == ID_BOT) {
        gl_FragColor = vec4(finish(atmosphere(shadeBot(viewDir), dist, viewDir)), 1.0);
        return;
    }
#endif

    vec3 n = face < 0.5 ? vec3(1, 0, 0) : face < 1.5 ? vec3(-1, 0, 0)
           : face < 2.5 ? vec3(0, 1, 0) : face < 3.5 ? vec3(0, -1, 0)
           : face < 4.5 ? vec3(0, 0, 1) : vec3(0, 0, -1);
    vec3 tu = face < 1.5 ? vec3(0, 1, 0) : vec3(1, 0, 0);          // face axes, matching uv below
    vec3 tv = face < 3.5 ? vec3(0, 0, 1) : vec3(0, 1, 0);

    // which block this pixel belongs to, and where on its face
    vec3 inside = vWorld - n * 0.002;
    vec3 cell = floor(inside);
    vec3 local = inside - cell;
    vec2 uv = face < 1.5 ? local.yz : face < 3.5 ? local.xz : local.xy;
    vec2 texel = floor(uv * 16.0);
    float r = hash(vec3(texel, 0.0) + cell * 17.0);

    // ---- material: albedo pattern, bumpiness, shininess
    vec3 c = vAlbedo;
    vec3 emit = vec3(0.0);            // light the surface gives off itself (linear, added after lighting)
    float tex = 1.0, bump = 0.35, specK = 0.04, gloss = 12.0;
    if (id == 1.0) {                                    // grass
        if (face > 3.5) tex = 0.8 + 0.4 * r;
        else {
            float edge = 0.8 - 0.14 * hash(vec3(texel.x, cell.x + cell.y, 3.0));
            if (uv.y > edge) c *= vec3(0.36, 0.62, 0.22) / vec3(0.52, 0.38, 0.26);
            tex = 0.8 + 0.32 * r;
        }
        specK = 0.06;
    } else if (id == 2.0) { tex = 0.78 + 0.38 * r; bump = 0.45; }                     // dirt
    else if (id == 3.0) { tex = 0.82 + 0.2 * r + 0.1 * hash(vec3(floor(uv * 4.0), 5.0) + cell); specK = 0.1; gloss = 24.0; }
    else if (id == 4.0) { tex = 0.9 + 0.14 * r; bump = 0.2; }                         // sand
    else if (id == 6.0) {                                                              // wood
        if (face > 3.5) tex = 0.85 + 0.15 * sin(length(uv - 0.5) * 38.0);
        else { tex = 0.76 + 0.3 * hash(vec3(texel.x, cell.x * 3.0 + cell.y, 6.0)); bump = 0.6; }
    } else if (id == ID_LEAVES) { tex = 0.68 + 0.55 * r; if (r < 0.14) tex = 0.38; bump = 0.7; specK = 0.08; }
    else if (id == 8.0) {                                                              // planks
        float board = floor(uv.y * 4.0);
        tex = 0.86 + 0.14 * hash(vec3(board, cell.x + cell.y * 7.0, cell.z)) + 0.06 * r;
        if (fract(uv.y * 4.0) < 0.07) tex = 0.6;
        if (fract(uv.x + board * 0.37) < 0.035) tex = 0.64;
        specK = 0.06; gloss = 20.0;
    } else if (id == 10.0) {                                                           // cobblestone
        vec2 g = uv * 4.0 + vec2(0.5 * floor(mod(uv.y * 4.0, 2.0)), 0.0);
        vec2 f = fract(g);
        tex = 0.72 + 0.4 * hash(vec3(floor(g), 10.0) + cell);
        if (min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) < 0.1) tex = 0.5;
        bump = 0.7; specK = 0.08;
    } else if (id == 11.0) {                                                           // bricks
        float row = floor(uv.y * 4.0);
        float bx = uv.x * 2.0 + mod(row, 2.0) * 0.5;
        tex = 0.86 + 0.2 * r;
        if (fract(uv.y * 4.0) < 0.12 || fract(bx) < 0.06) { c = vec3(dot(c, vec3(0.333))) * 1.5; tex = 1.0; }
        bump = 0.5;
    } else if (id == 12.0) {                                                           // redstone dust
        // rgb = (power / 15, connection mask / 15, -): draw the wire towards connected sides, cut out the rest
        float pw = vAlbedo.r, mask = floor(vAlbedo.g * 15.0 + 0.5);
        vec2 q = local.xy - 0.5;
        float bE = mod(mask, 2.0), bW = mod(floor(mask / 2.0), 2.0), bN = mod(floor(mask / 4.0), 2.0), bS = mod(floor(mask / 8.0), 2.0);
        if (mask < 0.5) { bE = 1.0; bW = 1.0; bN = 1.0; bS = 1.0; }
        float wd = 0.1 + 0.03 * (r - 0.5);
        bool wire = length(q) < 0.17
            || (bE > 0.5 && q.x > 0.0 && abs(q.y) < wd) || (bW > 0.5 && q.x < 0.0 && abs(q.y) < wd)
            || (bN > 0.5 && q.y > 0.0 && abs(q.x) < wd) || (bS > 0.5 && q.y < 0.0 && abs(q.x) < wd);
        if (!wire) discard;
        c = mix(vec3(0.32, 0.03, 0.02), vec3(1.0, 0.14, 0.06), pw) * (0.8 + 0.35 * r);
        emit = vec3(1.0, 0.1, 0.03) * pw * pw * 1.2;
        bump = 0.0; specK = 0.0;
    } else if (id == 13.0 || id == 14.0) {                                             // redstone torch / torch
        c = vec3(0.42, 0.28, 0.14) * (0.85 + 0.3 * r);
        if (local.z > 0.47) {
            if (id == 14.0) { c = vec3(1.0, 0.85, 0.45); emit = vec3(1.0, 0.62, 0.22) * 5.0; }
            else if (vAlbedo.r > 0.5) { c = vec3(1.0, 0.25, 0.12); emit = vec3(1.0, 0.1, 0.03) * 4.0; }
            else c = vec3(0.3, 0.06, 0.05);
        }
        bump = 0.0; specK = 0.0;
    } else if (id == 15.0) {                                                           // lever
        if (local.z < 0.19) c = vec3(0.5, 0.5, 0.52) * (0.8 + 0.3 * r);
        else {
            c = vec3(0.45, 0.32, 0.18);
            if (local.z > 0.6) { c = vAlbedo.r > 0.5 ? vec3(1.0, 0.2, 0.1) : vec3(0.35, 0.08, 0.06); emit = vec3(1.0, 0.1, 0.03) * vAlbedo.r * 1.5; }
        }
        bump = 0.0;
    } else if (id == 16.0) {                                                           // button
        c = vec3(0.55, 0.55, 0.57) * (0.85 + 0.2 * r); bump = 0.0;
    } else if (id == 17.0) {                                                           // redstone lamp
        float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
        vec2 g = fract(uv * 4.0);
        float grid = min(min(g.x, 1.0 - g.x), min(g.y, 1.0 - g.y));
        if (vAlbedo.r > 0.5) { c = vec3(1.0, 0.86, 0.58) * (0.85 + 0.2 * r); emit = vec3(1.0, 0.72, 0.38) * (grid < 0.12 ? 0.6 : 2.2); }
        else c = vec3(0.42, 0.28, 0.17) * (0.8 + 0.3 * r) * (grid < 0.12 ? 0.7 : 1.0);
        if (e < 0.06) { c = vec3(0.35, 0.22, 0.12); emit *= 0.2; }
        bump = 0.2;
    } else if (id >= 18.0 && id <= 23.0) {                                             // logic gates
        // rgb = (output on, facing / 3, inputs / 3)
        vec3 gc = id == 18.0 ? vec3(0.2, 0.45, 0.95) : id == 19.0 ? vec3(0.25, 0.8, 0.35) : id == 20.0 ? vec3(0.7, 0.35, 0.95)
                : id == 21.0 ? vec3(0.95, 0.55, 0.15) : id == 22.0 ? vec3(0.15, 0.75, 0.8) : vec3(0.95, 0.35, 0.6);
        float outOn = vAlbedo.r, f = floor(vAlbedo.g * 3.0 + 0.5), ins = floor(vAlbedo.b * 3.0 + 0.5);
        float inA = mod(ins, 2.0), inB = floor(ins / 2.0);
        vec3 OUT_ON = vec3(1.0, 0.2, 0.1), OUT_OFF = vec3(0.3, 0.06, 0.05), IN_ON = vec3(1.0, 0.8, 0.3), IN_OFF = vec3(0.18);
        c = vec3(0.26, 0.27, 0.31) * (0.85 + 0.2 * r);
        vec2 dir = f < 0.5 ? vec2(1.0, 0.0) : f < 1.5 ? vec2(0.0, 1.0) : f < 2.5 ? vec2(-1.0, 0.0) : vec2(0.0, -1.0);
        if (face > 3.5 && face < 4.5) {                                  // top: coloured panel, arrow to the output
            vec2 q = uv - 0.5;
            float a = dot(q, dir), sd = dot(q, vec2(-dir.y, dir.x));      // along the arrow / to its left
            if (max(abs(q.x), abs(q.y)) < 0.36) c = gc * 0.8;
            if ((abs(sd) < 0.05 && a > -0.26 && a < 0.12) || (a >= 0.12 && a < 0.3 && abs(sd) < (0.3 - a) * 1.1)) c = vec3(0.95);
            if (a > 0.4 && abs(sd) < 0.1) { c = outOn > 0.5 ? OUT_ON : OUT_OFF; emit = vec3(1.0, 0.1, 0.03) * outOn * 1.5; }
            if (id == 21.0) {
                if (a < -0.4 && abs(sd) < 0.1) { c = inA > 0.5 ? IN_ON : IN_OFF; emit = vec3(1.0, 0.6, 0.2) * inA; }
            } else {
                if (sd > 0.4 && abs(a) < 0.1) { c = inA > 0.5 ? IN_ON : IN_OFF; emit = vec3(1.0, 0.6, 0.2) * inA; }
                if (sd < -0.4 && abs(a) < 0.1) { c = inB > 0.5 ? IN_ON : IN_OFF; emit = vec3(1.0, 0.6, 0.2) * inB; }
            }
        } else if (face < 3.5) {                                          // sides: colour band, glowing output
            if (uv.y > 0.7 && uv.y < 0.85) c = gc;
            vec2 fn = face < 0.5 ? vec2(1.0, 0.0) : face < 1.5 ? vec2(-1.0, 0.0) : face < 2.5 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
            if (dot(fn, dir) > 0.5 && abs(uv.x - 0.5) < 0.12 && abs(uv.y - 0.45) < 0.12) { c = outOn > 0.5 ? OUT_ON : OUT_OFF; emit = vec3(1.0, 0.1, 0.03) * outOn * 1.5; }
        }
        bump = 0.25; specK = 0.1;
    } else if (id >= 24.0 && id <= 26.0) {                                             // pistons / piston head
        // rgb = (extended, facing / 5, sticky)
        float f = floor(vAlbedo.g * 5.0 + 0.5);
        vec3 dir = f < 0.5 ? vec3(1, 0, 0) : f < 1.5 ? vec3(0, 1, 0) : f < 2.5 ? vec3(-1, 0, 0)
                 : f < 3.5 ? vec3(0, -1, 0) : f < 4.5 ? vec3(0, 0, 1) : vec3(0, 0, -1);
        vec3 lc = local - 0.5;
        float along = dot(lc, dir) + 0.5;                                  // 0 back … 1 front of the cell
        vec3 across = abs(lc - dir * dot(lc, dir));
        float cross = max(max(across.x, across.y), across.z);
        bool front = dot(n, dir) > 0.5, back = dot(n, dir) < -0.5;
        bool sticky = vAlbedo.b > 0.5, extended = vAlbedo.r > 0.5;
        vec3 STONE = vec3(0.5, 0.5, 0.52) * (0.82 + 0.25 * r);
        vec3 WOOD = vec3(0.72, 0.56, 0.34) * (0.86 + 0.18 * r);
        vec3 SLIME = vec3(0.42, 0.78, 0.32) * (0.85 + 0.2 * r);
        if (id == 26.0) {
            c = WOOD;                                                      // plate
            if (front && sticky && cross < 0.44) c = SLIME;
            if (!front && cross < 0.13) c = vec3(0.55, 0.42, 0.26) * (0.85 + 0.2 * r);   // arm
        } else if (front) {
            if (extended) c = cross < 0.13 ? vec3(0.55, 0.42, 0.26) : vec3(0.16, 0.15, 0.15);   // socket with the arm
            else { c = sticky && cross < 0.44 ? SLIME : WOOD; if (cross > 0.44) c = WOOD * 0.8; }
        } else if (back) {
            c = STONE * 0.85;
            if (cross < 0.15) c = STONE * 0.6;
        } else {
            c = STONE;
            if (along > (extended ? 0.55 : 0.78)) c = WOOD;                // wooden rim near the front
        }
        bump = 0.3; specK = 0.06;
    }
    c *= tex;

    // selection outline on the block under the crosshair
    float sel = selActive > 0.5 && all(equal(cell, selBlock)) ? 1.0 : 0.0;
    if (sel > 0.5) {
        float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
        if (e < 0.03) c *= 0.12;
    }

#if QUALITY == 0
    // Fastest: no realistic shading - classic per-face shade, corner darkening, flat water, simple fog
    {
        float shade = face > 3.5 && face < 4.5 ? 1.0 : face > 4.5 ? 0.5 : face < 1.5 ? 0.8 : 0.65;
        vec3 col = c * shade * (0.45 + 0.55 * vAO) + emit * 0.35;
        float a = 1.0;
        if (id == ID_WATER) { col = vec3(0.16, 0.36, 0.72) * (0.88 + 0.12 * sin(time * 2.0 + vWorld.x + vWorld.y)); a = 0.72; }
        if (id == ID_GLASS) { float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)); a = e < 0.07 ? 0.9 : 0.25; }
        if (sel > 0.5) col *= 1.15;
        vec3 fogC = underwater > 0.5 ? vec3(0.1, 0.25, 0.45) : vec3(0.62, 0.76, 0.92);
        float fg = underwater > 0.5 ? 1.0 - exp(-dist * 0.12) : smoothstep(renderEnd * 0.55, renderEnd, dist);
        gl_FragColor = vec4(mix(col, fogC, fg), a);
        return;
    }
#endif

    vec3 albedo = pow(clamp(c, 0.0, 1.0), vec3(2.2));

    // per-pixel bump from the texture: neighbouring texels are a little higher or lower
    float rx = hash(vec3(texel + vec2(1.0, 0.0), 0.0) + cell * 17.0);
    float ry = hash(vec3(texel + vec2(0.0, 1.0), 0.0) + cell * 17.0);
    vec3 N = normalize(n + (tu * (r - rx) + tv * (r - ry)) * bump);

    float ao = vAO * vAO;
    float ndl = dot(N, sunDir);
    float sh = dot(n, sunDir) > 0.0 ? shadowAt(vWorld + n * 0.06) : 0.0;
    vec3 ambient = mix(GROUND_AMB, SKY_AMB, N.z * 0.5 + 0.5) * ao;
    vec3 H = normalize(sunDir - viewDir);
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, -viewDir), 0.0), 5.0);

    vec3 color;
    float alpha = 1.0;

    if (id == ID_WATER) {
        bool top = face > 3.5 && face < 4.5;
        vec3 W = top ? waterNormal(vWorld.xy, time) : n;
        if (underwater > 0.5 && top) W = -W;
        float wf = 0.02 + 0.98 * pow(1.0 - max(dot(W, -viewDir), 0.0), 5.0);
        vec3 R = reflect(viewDir, W);
        R.z = abs(R.z);                                   // waves never reflect the ground below the horizon
        vec3 refl = underwater > 0.5 ? WATER_FOG * 2.0 : sky(R, true) * mix(0.55, 1.0, sh);
        float glint = pow(max(dot(R, sunDir), 0.0), 600.0) * 6.0 * sh;
        vec3 body = vec3(0.01, 0.07, 0.09) * (SKY_AMB + SUN_COL * 0.3 * max(sunDir.z, 0.0));
        color = mix(body, refl, wf * 0.9) + SUN_COL * glint;
        alpha = mix(0.7, 0.98, wf);
        if (underwater > 0.5) alpha = 0.55;
    } else if (id == ID_GLASS) {
        float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
        vec3 refl = sky(reflect(viewDir, n), false);
        float streak = abs(uv.x - uv.y - 0.25) < 0.04 || abs(uv.x - uv.y + 0.15) < 0.025 ? 1.0 : 0.0;
        vec3 lit = albedo * (SUN_COL * max(ndl, 0.0) * sh + ambient);
        color = mix(lit * 0.6, refl, 0.25 + 0.6 * fres) + streak * 0.25;
        alpha = e < 0.07 ? 0.9 : 0.18 + 0.5 * fres + 0.3 * streak;
    } else {
        vec3 direct = SUN_COL * max(ndl, 0.0) * sh;
        float spec = specK * pow(max(dot(N, H), 0.0), gloss) * (gloss + 2.0) / 8.0;
        color = albedo * (direct + ambient) + SUN_COL * spec * sh * fres * 4.0;
        // sunlight glowing through leaves
        if (id == ID_LEAVES) color += albedo * SUN_COL * 0.35 * max(dot(viewDir, sunDir), 0.0) * (0.4 + 0.6 * sh);
        if (sel > 0.5) color *= 1.15;
    }

    // torches and lamps light up the blocks around them
    if (id != ID_WATER) {
        for (int i = 0; i < 12; i++) {
            if (float(i) >= ptCount) break;
            vec3 L = ptPos[i] - vWorld;
            float d2 = dot(L, L);
            float att = max(0.0, 1.0 - d2 / 100.0) / (1.0 + d2 * 0.35);
            color += albedo * ptCol[i] * att * (0.3 + 0.7 * max(dot(N, L * inversesqrt(d2 + 1e-4)), 0.0));
        }
    }
    color += emit;

    gl_FragColor = vec4(finish(atmosphere(color, dist, viewDir)), alpha);
}`;

function compile(gl, space, vsSrc, fsSrc) {
    const make = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, make(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(program, make(gl.FRAGMENT_SHADER, fsSrc));
    // keep the attribute slots Space already wired its buffers to
    gl.bindAttribLocation(program, space.posId, "pos");
    gl.bindAttribLocation(program, space.colId, "col");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return program;
}

// the uniform locations Space's draw code uses, for a program
function spaceLocations(gl, program) {
    const loc = (name) => gl.getUniformLocation(program, name);
    return {
        program,
        cPointLoc: loc("cPoint"),
        vPointLoc: loc("vPoint"),
        xAxisLoc: loc("xAxis"),
        yAxisLoc: loc("yAxis"),
        zAxisLoc: loc("zAxis"),
        varsLocation: loc("veriables"),
    };
}

const BOT_UNIFORMS = ["botPos", "botYaw", "botPhase", "botAmp", "botArm", "botHead", "botBob"];

// companion pose -> uniforms of the current program
export function setBotUniforms(gl, u, pose) {
    gl.uniform3fv(u.botPos, pose.pos);
    gl.uniform1f(u.botYaw, pose.yaw);
    gl.uniform1f(u.botPhase, pose.phase);
    gl.uniform1f(u.botAmp, pose.amp);
    gl.uniform1f(u.botArm, pose.arm);
    gl.uniform1f(u.botHead, pose.head);
    gl.uniform1f(u.botBob, pose.bob);
}

export const QUALITY_NAMES = ["Fastest", "Fast", "Fancy"];

export function createShaders(gl, space, quality = 2) {
    const shadowProg = compile(gl, space, SHADOW_VERT, SHADOW_FRAG);
    const uniforms = (p, names) => Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));

    // one block program per quality level, compiled the first time it's needed
    const blockPrograms = {};
    const blockFor = (q) => {
        if (!blockPrograms[q]) {
            const prog = compile(gl, space, BLOCK_VERT, `#define QUALITY ${q}\n` + BLOCK_FRAG);
            blockPrograms[q] = {
                space: spaceLocations(gl, prog),
                u: uniforms(prog, ["aspect", "time", "sunDir", "renderEnd", "underwater", "selBlock", "selActive",
                    "shadowMap", "shadowOn", "lightC", "lightX", "lightY", "lightZ", "shadowSize", "shadowRange", "shadowTexel",
                    "ptPos", "ptCol", "ptCount", ...BOT_UNIFORMS]),
                primed: false,
            };
        }
        return blockPrograms[q];
    };
    const block = blockFor(quality);
    const shadow = {
        space: spaceLocations(gl, shadowProg),
        u: uniforms(shadowProg, ["shadowSize", "shadowRange", "time", ...BOT_UNIFORMS]),
    };

    // point Space at a program's uniforms and make it current
    const use = (s) => {
        Object.assign(space, s.space);
        gl.useProgram(s.space.program);
    };

    const api = { block, shadow, use, quality };
    // switch the main pass to another quality level
    api.setQuality = (q) => {
        api.quality = q;
        api.block = blockFor(q);
        use(api.block);
        if (!api.block.primed) {
            gl.uniform3fv(api.block.space.varsLocation, new Float32Array([space.zShifter, space.magnifier, 0]));
            api.block.primed = true;
        }
    };
    api.setQuality(quality);
    return api;
}
