// Tessera shaders. Same attributes and camera uniforms as Space.js (pos, col, cPoint, xAxis, yAxis, zAxis,
// veriables), so the library's camera drives everything. col.a = material, col.rgb = colour.
//
//   0 SOLID    flat-shaded low-poly (normal from screen-space derivatives), golden-hour light
//   1 FOLIAGE  like SOLID, but sways in the wind; pos.w = how much (0 at the root … 1 at the top)
//   2 WATER    sea + rivers: waves, turquoise shallows, animated shore foam, sun glints. pos.w = distance
//              to the island (0 on the shore … large far out)
//   3 SKY      full-screen: gradient, sun glow, drifting clouds (uses the view direction)
//   4 GLOW     emissive (lit windows, markers)
//   5 SPRITE   additive glow blob; pos.w = size + corner * 100
//   6 GHOST    the tile you're about to place: translucent, pulsing
//   7 LINE     hex outlines of the free spots
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
uniform float uTime;

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
    if (mat == 1.0) {                                   // wind
        float w = pos.w * pos.w;
        p.x += w * (sin(uTime * 1.7 + p.x * 0.8 + p.y * 0.5) * 0.05 + sin(uTime * 3.1 + p.y * 1.7) * 0.015);
        p.y += w * (cos(uTime * 1.3 + p.y * 0.7 + p.x * 0.4) * 0.04);
    } else if (mat == 2.0) {                            // gentle swell (flat right at the shore)
        float k = smoothstep(0.0, 2.0, pos.w);
        p.z += k * (sin(p.x * 0.6 + uTime * 1.1) * 0.05 + sin(p.y * 0.9 - uTime * 1.4) * 0.035);
    } else if (mat == 5.0) {                            // billboard
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
    const float NEAR = 0.05, FAR = 900.0;
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
uniform vec3 veriables;
uniform float aspect;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uSun;
uniform float uGhost;          // ghost tile pulse 0..1
uniform vec3 uGhostTint;

const vec3 SUN = vec3(1.0, 0.86, 0.66) * 1.25;
const vec3 SKY_AMB = vec3(0.42, 0.52, 0.72) * 0.55;
const vec3 GROUND_AMB = vec3(0.45, 0.36, 0.26) * 0.35;
const vec3 HORIZON = vec3(1.0, 0.8, 0.62);
const vec3 ZENITH = vec3(0.26, 0.45, 0.78);

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.07 + 13.1; a *= 0.5; } return s; }

vec3 skyColor(vec3 d) {
    float h = clamp(d.z, -0.2, 1.0);
    vec3 c = mix(HORIZON, ZENITH, pow(max(h, 0.0), 0.55));
    if (h < 0.0) c = HORIZON * 0.9;
    float sd = max(dot(d, uSun), 0.0);
    c += vec3(1.0, 0.7, 0.4) * (pow(sd, 8.0) * 0.45 + pow(sd, 90.0) * 0.8);
    return c;
}

vec3 fogged(vec3 c, float dist) {
    vec3 d = normalize(vWorld - cPoint);
    return mix(c, skyColor(vec3(d.xy, max(d.z, 0.02))) , smoothstep(60.0, 260.0, dist) * 0.9);
}

vec3 tonemap(vec3 c) { c = c / (1.0 + c * 0.35); return pow(c, vec3(0.95)); }

void main() {
    float mat = floor(vMat + 0.5);
    vec3 V = cPoint - vWorld;
    float dist = length(V);
    V /= max(dist, 1e-4);

    // flat normal of this facet (computed up front: derivatives must not sit inside branches)
#ifdef GL_OES_standard_derivatives
    vec3 fn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
#else
    vec3 fn = vec3(0.0, 0.0, 1.0);
#endif
    if (dot(fn, V) < 0.0) fn = -fn;

    vec3 c;
    float a = 1.0;

    if (mat == 3.0) {                                           // sky
        vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
        vec3 d = normalize(zAxis - xAxis * ndc.x * (1.6 / veriables.y) + yAxis * ndc.y * (1.6 / (veriables.y * aspect)));
        c = skyColor(d);
        if (d.z > 0.0) {                                        // soft drifting clouds on a dome
            vec2 q = d.xy / (d.z + 0.25) * 1.6 + vec2(uTime * 0.012, uTime * 0.005);
            float n = fbm(q);
            float cover = smoothstep(0.5, 0.78, n) * smoothstep(0.0, 0.25, d.z);
            vec3 cl = mix(vec3(1.0, 0.86, 0.78), vec3(1.0, 0.97, 0.93), smoothstep(0.55, 0.85, n)) + vec3(1.0, 0.6, 0.3) * pow(max(dot(d, uSun), 0.0), 6.0) * 0.5;
            c = mix(c, cl, cover * 0.85);
        }
        gl_FragColor = vec4(tonemap(c), 1.0);
        return;
    }

    if (mat == 5.0) {                                           // glow sprite (additive)
        float k = max(exp(-dot(vUV, vUV) * 3.0) - 0.05, 0.0);
        gl_FragColor = vec4(vCol * k, 1.0);
        return;
    }

    if (mat == 7.0) {                                           // free-spot outline
        gl_FragColor = vec4(vCol, 0.35 + 0.25 * sin(uTime * 3.0));
        return;
    }

    if (mat == 2.0) {                                           // water
        float shore = vW;
        vec2 p = vWorld.xy;
        vec2 g = vec2(cos(p.x * 1.3 + uTime * 1.6) * 0.06 + cos(p.x * 0.5 + p.y * 0.9 + uTime) * 0.05,
                      cos(p.y * 1.1 - uTime * 1.3) * 0.06 + cos(p.y * 0.4 - p.x * 0.8 + uTime * 0.8) * 0.05);
        g += (vec2(noise(p * 3.0 + uTime * 0.7), noise(p * 3.0 - uTime * 0.6 + 5.0)) - 0.5) * 0.25;
        vec3 n = normalize(vec3(-g, 1.0));
        vec3 shallow = vec3(0.32, 0.85, 0.82), deep = vec3(0.05, 0.3, 0.5);
        vec3 body = mix(shallow, deep, smoothstep(0.2, 7.0, shore));
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
        vec3 R = reflect(-V, n);
        vec3 refl = skyColor(vec3(R.xy, abs(R.z)));
        float spec = pow(max(dot(R, uSun), 0.0), 180.0) * 2.5;
        c = body * (SKY_AMB * 1.4 + SUN * max(dot(n, uSun), 0.0) * 0.55);
        c = mix(c, refl, fres * 0.8) + SUN * spec;
        // foam: rings breaking on the shore
        float foam = smoothstep(0.9, 0.0, shore) * (0.55 + 0.45 * sin(shore * 9.0 - uTime * 2.5));
        foam *= smoothstep(0.35, 0.65, noise(p * 4.0 + uTime * 0.3));
        c = mix(c, vec3(1.0), clamp(foam, 0.0, 1.0) * 0.85);
        gl_FragColor = vec4(tonemap(fogged(c, dist)), 1.0);
        return;
    }

    if (mat == 4.0) { gl_FragColor = vec4(tonemap(fogged(vCol, dist)), 1.0); return; }

    // lit surfaces (SOLID, FOLIAGE, GHOST)
    vec3 albedo = vCol;
    float ndl = max(dot(fn, uSun), 0.0);
    float occl = mix(0.7, 1.0, smoothstep(0.25, 0.8, vWorld.z));           // a little darker near the ground
    vec3 amb = mix(GROUND_AMB, SKY_AMB, fn.z * 0.5 + 0.5) * occl;
    float rim = pow(1.0 - max(dot(fn, V), 0.0), 3.0);
    c = albedo * (SUN * ndl + amb) + vec3(1.0, 0.75, 0.5) * rim * 0.12 * (0.4 + ndl);
    if (mat == 6.0) {
        c = mix(c, uGhostTint, 0.35) + uGhostTint * (0.15 + 0.2 * uGhost);
        a = 0.72;
    }
    gl_FragColor = vec4(tonemap(fogged(c, dist)), a);
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
    for (const n of ["aspect", "veriables", "uRes", "uTime", "uSun", "uGhost", "uGhostTint"]) U[n] = loc(n);
    return U;
}
