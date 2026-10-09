// Stratos shaders. Same attributes and camera uniforms as Space.js (pos, col, cPoint, xAxis, yAxis, zAxis,
// veriables), so the library's camera drives everything. col.a = material.
//
//   0 GLASS     the tower's slabs: tinted glass with sky reflections, a sun highlight and an inner glow
//   1 BUILDING  skyscrapers: mirrored by day, lit windows by night
//   2 GLOW      emissive
//   3 SKY       full-screen sky: altitude-driven gradient, sun, stars, aurora
//   5 SPRITE    additive glow (sparkles); pos.w = size + corner * 100
//   6 GROUND    the city floor: streets glowing at night
//   7 CLOUD     soft cloud puffs, tinted by the time of day; pos.w = size + corner * 100
// Every lit material fades into the horizon colour with distance (aerial perspective).
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

void main() {
    float mat = floor(col.a + 0.5);
    vMat = mat; vCol = col.rgb; vUV = vec2(0.0);
    if (mat == 3.0) { gl_Position = vec4(pos.xy, 0.99999, 1.0); vWorld = vec3(0.0); return; }
    vec3 p = pos.xyz;
    if (mat == 5.0 || mat == 7.0) {
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
    const float NEAR = 0.1, FAR = 600.0;
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

uniform vec3 cPoint;
uniform vec3 xAxis;
uniform vec3 yAxis;
uniform vec3 zAxis;
uniform vec3 veriables;
uniform float aspect;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uTop;          // sky colour overhead
uniform vec3 uHor;          // sky colour at the horizon (also the fog)
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uCloud;
uniform float uNight;       // 0 day … 1 night: city lights, stars
uniform float uAurora;
uniform float uFog;         // fog density

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

vec3 sky(vec3 d) {
    float h = d.z;
    vec3 c = mix(uHor, uTop, smoothstep(-0.05, 0.55, h));
                         // below the horizon: haze
    float s = max(dot(d, normalize(uSunDir)), 0.0);
    c += uSunCol * (pow(s, 900.0) * 6.0 + pow(s, 40.0) * 0.3 + pow(s, 6.0) * 0.07);
    return c;
}

vec3 tone(vec3 c) { return vec3(1.0) - exp(-c * 1.4); }

vec3 fogged(vec3 c, float dist) {
    float f = 1.0 - exp(-dist * uFog);
    return mix(c, uHor, clamp(f, 0.0, 1.0));
}

void main() {
    float mat = floor(vMat + 0.5);
    vec3 V = normalize(cPoint - vWorld);
    float dist = length(cPoint - vWorld);

#ifdef GL_OES_standard_derivatives
    vec3 fn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
#else
    vec3 fn = vec3(0.0, 0.0, 1.0);
#endif
    if (dot(fn, V) < 0.0) fn = -fn;

    if (mat == 3.0) {
        vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
        vec3 d = normalize(zAxis - xAxis * ndc.x * (1.6 / veriables.y) + yAxis * ndc.y * (1.6 / (veriables.y * aspect)));
        vec3 c = sky(d);
        // stars
        vec2 g = floor(gl_FragCoord.xy / 2.0);
        float st = hash(g + floor(d.xy * 40.0));
        c += step(0.9965, hash(g)) * uNight * (0.6 + 0.4 * sin(uTime * 3.0 + st * 40.0)) * smoothstep(0.0, 0.3, d.z) * vec3(0.9, 0.95, 1.0);
        // aurora curtains
        if (uAurora > 0.0) {
            float a = atan(d.y, d.x);
            float band = noise(vec2(a * 3.0 + uTime * 0.05, uTime * 0.1)) * 0.6 + noise(vec2(a * 9.0 - uTime * 0.08, 2.0)) * 0.4;
            float hgt = smoothstep(0.0, 0.12, d.z) * smoothstep(0.6, 0.2, d.z);
            float curtain = pow(band, 3.0) * hgt * (0.6 + 0.4 * sin(a * 30.0 + uTime));
            c += mix(vec3(0.1, 1.0, 0.55), vec3(0.6, 0.2, 1.0), smoothstep(0.15, 0.6, d.z)) * curtain * uAurora * 3.0;
        }
        gl_FragColor = vec4(tone(c), 1.0); return;
    }
    if (mat == 5.0) {
        float k = max(exp(-dot(vUV, vUV) * 3.2) - 0.05, 0.0);
        gl_FragColor = vec4(vCol * k, 1.0); return;
    }
    if (mat == 7.0) {                                                 // alpha-blended cloud puff (premultiplied)
        float r2 = dot(vUV, vUV);
        float n = noise(vUV * 2.3 + vCol.xy * 10.0) * 0.6 + noise(vUV * 5.0 - vCol.yx * 7.0) * 0.4;
        float a = clamp((exp(-r2 * 2.0) - 0.14) * 1.3 * (0.55 + 0.7 * n), 0.0, 1.0) * vCol.z * smoothstep(8.0, 30.0, dist) * 0.8;
        vec3 sunSide = uSunCol * pow(max(dot(normalize(vWorld - cPoint), normalize(uSunDir)), 0.0), 3.0) * 0.6;
        vec3 cc = uCloud * (0.7 + 0.35 * n - vUV.y * 0.12) + sunSide;
        gl_FragColor = vec4(tone(cc) * a, a); return;
    }
    if (mat == 2.0) { gl_FragColor = vec4(fogged(vCol, dist * 0.5), 1.0); return; }

    vec3 L = normalize(uSunDir);
    vec3 c;
    if (mat == 0.0) {                                                 // glass slab
        vec3 R = reflect(-V, fn);
        float fres = 0.08 + 0.92 * pow(1.0 - max(dot(fn, V), 0.0), 4.0);
        float d = max(dot(fn, L), 0.0);
        vec3 body = vCol * (0.35 + 0.65 * d) * mix(vec3(1.0), uSunCol * 0.8 + 0.3, 0.4) + vCol * 0.18 * (1.0 + uNight);
        if (fn.z > 0.5) body *= 1.15;
        c = mix(body, sky(R), fres * 0.65);
        c += uSunCol * pow(max(dot(R, L), 0.0), 120.0) * 1.6;
        c += vCol * uNight * 0.35;                                    // they glow softly after dark
    } else if (mat == 1.0) {                                          // building
        vec2 f = abs(fn.x) > 0.5 ? vWorld.yz : vWorld.xz;
        vec2 cell = floor(f * vec2(1.6, 1.25));
        vec2 w = fract(f * vec2(1.6, 1.25));
        float win = step(0.18, w.x) * step(w.x, 0.82) * step(0.2, w.y) * step(w.y, 0.78);
        vec3 R = reflect(-V, fn);
        float fres = 0.1 + 0.9 * pow(1.0 - max(dot(fn, V), 0.0), 4.0);
        vec3 wall = vCol * (0.25 + 0.6 * max(dot(fn, L), 0.0)) + vCol * 0.08;
        if (abs(fn.z) > 0.5) { c = wall * 0.9; }
        else {
            vec3 glass = mix(wall * 0.6, sky(R), 0.35 + fres * 0.4);
            c = mix(wall, glass, win * (1.0 - uNight * 0.7));
            float lit = step(0.55, hash(cell + vCol.xy * 50.0));
            c += win * lit * uNight * vec3(1.0, 0.78, 0.45) * (0.8 + 0.4 * hash(cell * 1.7));
        }
    } else if (mat == 6.0) {                                          // city floor
        vec2 g = abs(fract(vWorld.xy / 9.0) - 0.5);
        float street = smoothstep(0.06, 0.0, min(g.x, g.y) - 0.02);
        c = vec3(0.07, 0.08, 0.09) * (0.4 + 0.6 * max(dot(fn, L), 0.0)) + vec3(0.08, 0.1, 0.08) * (1.0 - street) * (1.0 - uNight);
        c += street * uNight * vec3(1.0, 0.65, 0.3) * 0.9 * (0.7 + 0.3 * hash(floor(vWorld.xy / 3.0))) * smoothstep(240.0, 170.0, length(vWorld.xy));
        dist *= 1.6;
    } else {
        c = vCol * (0.3 + 0.7 * max(dot(fn, L), 0.0));
    }
    c = fogged(c, dist);
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
    for (const n of ["aspect", "veriables", "uRes", "uTime", "uTop", "uHor", "uSunDir", "uSunCol", "uCloud", "uNight", "uAurora", "uFog"]) U[n] = loc(n);
    return U;
}
