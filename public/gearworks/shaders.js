// Gearworks shaders. Same attributes and camera uniforms as Space.js (pos, col, cPoint, xAxis, yAxis, zAxis,
// veriables), so the library's camera drives everything. col.a = material.
//
//   0 METAL     brass, copper, chrome: flat facets reflecting a warm workshop environment
//   1 FIELD     the playfield: dark lacquered walnut with brass inlay rings, a compass rose, and light spill
//   2 GLOW      emissive (inserts, tubes, bumper cores, furnace)
//   3 BACK      full-screen background (a dim workshop wall)
//   4 SHADOW    ball shadows on the playfield: pos.w = darkness
//   5 SPRITE    additive glow (sparks, steam, halos); pos.w = size + corner * 100
//   6 BALL      a camera-facing quad shaded as a perfect chrome sphere; pos.w = radius + corner * 100
//   7 PAINT     lacquered wood / plastic / rubber: diffuse + a sharp clear-coat highlight
// Space's xUnitVec points to screen-left, so screen x uses -dot(v, xAxis).

export const VERT = `
attribute vec4 pos;
attribute vec4 col;
uniform vec3 cPoint;
uniform vec3 xAxis;
uniform vec3 yAxis;
uniform vec3 zAxis;
uniform vec3 veriables;
uniform float aspect;

varying vec3 vCol;
varying float vMat;
varying vec3 vWorld;
varying vec2 vUV;
varying float vW;

void main() {
    float mat = floor(col.a + 0.5);
    vMat = mat; vCol = col.rgb; vUV = vec2(0.0); vW = pos.w;
    if (mat == 3.0) { gl_Position = vec4(pos.xy, 0.99999, 1.0); vWorld = vec3(pos.xy, 0.0); return; }
    vec3 p = pos.xyz;
    if (mat == 5.0 || mat == 6.0) {
        float corner = floor(pos.w / 100.0);
        float size = pos.w - corner * 100.0;
        vec2 c = corner < 0.5 ? vec2(-1.0, -1.0) : corner < 1.5 ? vec2(1.0, -1.0) : corner < 2.5 ? vec2(1.0, 1.0) : vec2(-1.0, 1.0);
        vUV = c;
        p += (-xAxis * c.x + yAxis * c.y) * size;
    }
    vWorld = p;
    vec3 v = p - cPoint;
    float xp = -dot(v, xAxis), yp = dot(v, yAxis), zp = dot(v, zAxis);
    float k = veriables.y / 1.6;
    const float NEAR = 0.05, FAR = 200.0;
    gl_Position = vec4(xp * k, yp * k * aspect, zp * (FAR + NEAR) / (FAR - NEAR) - 2.0 * FAR * NEAR / (FAR - NEAR), zp);
}`;

export const FRAG = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec3 vCol;
varying float vMat;
varying vec3 vWorld;
varying vec2 vUV;
varying float vW;

uniform vec3 cPoint;
uniform vec3 xAxis;
uniform vec3 yAxis;
uniform vec3 zAxis;
uniform vec2 uRes;
uniform float uTime;
uniform vec4 uLights[8];        // xyz + intensity
uniform vec3 uLightCol[8];
uniform float uBlast;           // 0..1 steam-blast mode (warmer, brighter)

const vec3 KEY = vec3(-0.35, -0.55, 0.76);   // overhead lamp, slightly towards the player

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// the workshop around the machine, as seen in reflections
vec3 env(vec3 r) {
    float up = r.z;
    vec3 c = mix(vec3(0.07, 0.045, 0.03), vec3(0.32, 0.24, 0.16), smoothstep(-0.3, 0.6, up));
    c += vec3(1.0, 0.8, 0.55) * smoothstep(0.88, 0.97, dot(r, normalize(vec3(-0.3, -0.4, 0.86)))) * 1.6;   // the lamp
    c += vec3(0.9, 0.55, 0.25) * pow(max(dot(r, normalize(vec3(0.0, 1.0, 0.25))), 0.0), 6.0) * 0.5;       // glowing backboard
    float band = smoothstep(0.02, 0.0, abs(fract(atan(r.y, r.x) * 1.2) - 0.5) - 0.42) * smoothstep(0.0, 0.4, up);
    c += vec3(0.5, 0.42, 0.32) * band * 0.25;
    return c * (1.0 + uBlast * 0.4);
}

vec3 spill(vec3 p, vec3 n) {
    vec3 s = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        vec3 L = uLights[i].xyz - p;
        float d2 = dot(L, L);
        s += uLightCol[i] * uLights[i].w * max(dot(n, normalize(L)), 0.0) / (1.0 + d2 * 1.4);
    }
    return s;
}

vec3 playfield(vec3 w) {
    // walnut planks running up the table
    float plank = floor(w.x * 0.9 + 10.0);
    float g = noise(vec2(w.x * 7.0 + plank * 3.1, w.y * 0.45)) * 0.6 + noise(vec2(w.x * 22.0, w.y * 1.6 + plank)) * 0.25;
    float rings = sin((w.x * 6.0 + g * 4.0 + noise(w.xy * vec2(1.0, 0.2)) * 3.0)) * 0.5 + 0.5;
    vec3 wood = mix(vec3(0.16, 0.075, 0.035), vec3(0.3, 0.15, 0.07), rings * 0.6 + g * 0.4) * (0.85 + hash(vec2(plank, 1.0)) * 0.3);
    if (fract(w.x * 0.9 + 10.0) < 0.012) wood *= 0.55;
    // brass inlays: rings around the bumper cluster, a compass rose under the pressure dial, border lines
    vec3 brass = vec3(0.78, 0.56, 0.24);
    float inlay = 0.0;
    vec2 c1 = w.xy - vec2(0.05, 12.75);
    float r1 = length(c1 * vec2(1.0, 1.25));
    inlay = max(inlay, smoothstep(0.035, 0.0, abs(r1 - 2.25)));
    inlay = max(inlay, smoothstep(0.02, 0.0, abs(r1 - 2.4)));
    vec2 c2 = w.xy - vec2(0.1, 8.0);
    float r2 = length(c2), a2 = atan(c2.y, c2.x);
    inlay = max(inlay, smoothstep(0.03, 0.0, abs(r2 - 1.35)));
    float rose = smoothstep(0.02, 0.0, abs(r2 - (1.3 - pow(abs(sin(a2 * 4.0)), 0.5) * 0.55)));
    inlay = max(inlay, rose * step(r2, 1.32));
    inlay = max(inlay, smoothstep(0.025, 0.0, abs(abs(w.x) - 3.95)) * step(w.y, 15.0) * step(5.6, w.y));
    vec3 c = mix(wood, brass, inlay * 0.85);
    return c;
}

vec3 tone(vec3 c) { return vec3(1.0) - exp(-c * 1.5); }

void main() {
    float mat = floor(vMat + 0.5);
    vec3 V = normalize(cPoint - vWorld);

#ifdef GL_OES_standard_derivatives
    vec3 fn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
#else
    vec3 fn = vec3(0.0, 0.0, 1.0);
#endif
    if (dot(fn, V) < 0.0) fn = -fn;

    if (mat == 3.0) {
        vec2 s = gl_FragCoord.xy / uRes;
        vec3 c = mix(vec3(0.03, 0.02, 0.018), vec3(0.09, 0.06, 0.045), s.y);
        c *= 1.0 - 0.5 * length((s - vec2(0.5, 0.55)) * vec2(1.0, 0.8));
        float bricks = step(0.94, fract(gl_FragCoord.y / 26.0)) + step(0.97, fract(gl_FragCoord.x / 70.0 + floor(gl_FragCoord.y / 26.0) * 0.5));
        c *= 1.0 - min(bricks, 1.0) * 0.3;
        gl_FragColor = vec4(c, 1.0); return;
    }
    if (mat == 5.0) {
        float k = max(exp(-dot(vUV, vUV) * 3.2) - 0.05, 0.0);
        gl_FragColor = vec4(vCol * k, 1.0); return;
    }
    if (mat == 2.0) { gl_FragColor = vec4(vCol * (1.0 + uBlast * 0.25), 1.0); return; }
    if (mat == 6.0) {                                                // chrome ball impostor
        float r2 = dot(vUV, vUV);
        if (r2 > 1.0) discard;
        vec3 n = normalize(-xAxis * vUV.x + yAxis * vUV.y - zAxis * sqrt(1.0 - r2));
        vec3 R = reflect(-V, n);
        vec3 c = R.z < 0.0 ? playfield(vWorld + R * 0.6) * 0.5 + spill(vWorld, vec3(0.0, 0.0, 1.0)) * 0.3 : env(R);
        c = c * vec3(0.9, 0.9, 0.95) + spill(vWorld, n) * 0.4;
        c += vec3(1.0, 0.9, 0.75) * pow(max(dot(R, normalize(KEY)), 0.0), 120.0) * 2.0;
        c *= 0.75 + 0.25 * smoothstep(1.0, 0.6, r2);
        gl_FragColor = vec4(tone(c), 1.0); return;
    }

    vec3 c;
    if (mat == 1.0 || mat == 4.0) {
        vec3 base = playfield(vWorld);
        vec3 n = vec3(0.0, 0.0, 1.0);
        c = base * (0.18 + 0.75 * max(dot(n, normalize(KEY)), 0.0) * (1.0 - 0.4 * smoothstep(5.0, 13.0, length(vWorld.xy - vec2(0.0, 8.0)))));
        c += base * spill(vWorld, n) * 2.2;
        // clear coat: the lamp reflected in the lacquer
        vec3 R = reflect(-V, n);
        c += vec3(1.0, 0.85, 0.6) * pow(max(dot(R, normalize(vec3(-0.3, -0.4, 0.86))), 0.0), 60.0) * 0.25;
        c += env(R) * 0.05;
        if (mat == 4.0) c *= vW;
    } else if (mat == 0.0) {
        vec3 R = reflect(-V, fn);
        float d = max(dot(fn, normalize(KEY)), 0.0);
        c = vCol * (env(R) * 1.25 + d * 0.25) + spill(vWorld, fn) * vCol * 1.4;
        c += vec3(1.0, 0.9, 0.7) * pow(max(dot(R, normalize(KEY)), 0.0), 50.0) * 0.8;
    } else {                                                         // paint / rubber / lacquered wood
        vec3 R = reflect(-V, fn);
        float d = max(dot(fn, normalize(KEY)), 0.0);
        c = vCol * (0.2 + d * 0.8) + spill(vWorld, fn) * vCol * 1.6;
        c += vec3(1.0, 0.88, 0.7) * pow(max(dot(R, normalize(KEY)), 0.0), 40.0) * 0.25;
    }
    gl_FragColor = vec4(tone(c), 1.0);
}`;

export function createProgram(gl, space) {
    gl.getExtension("OES_standard_derivatives");
    const make = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, make(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, make(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(program, space.posId, "pos");
    gl.bindAttribLocation(program, space.colId, "col");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const loc = (n) => gl.getUniformLocation(program, n);
    Object.assign(space, {
        program,
        cPointLoc: loc("cPoint"), vPointLoc: loc("vPoint"),
        xAxisLoc: loc("xAxis"), yAxisLoc: loc("yAxis"), zAxisLoc: loc("zAxis"),
        varsLocation: loc("veriables"),
    });
    gl.useProgram(program);
    const U = {};
    for (const n of ["aspect", "veriables", "uRes", "uTime", "uLights", "uLightCol", "uBlast"]) U[n] = loc(n);
    return U;
}
