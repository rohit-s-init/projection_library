// Umbra shaders. Same attributes and camera uniforms as Space.js (pos, col, cPoint, xAxis, yAxis, zAxis,
// veriables), so the library's camera drives everything. col.a = material.
//
//   0 BLOCK   the sculpture: glossy flat-faceted blocks, warm key light from the spotlight, cool rim
//   1 WALL    plaster wall with a soft spotlight pool
//   2 FLOOR   dark wooden floor with the light pooling on it
//   3 BACK    full-screen dark room gradient
//   4 SHADOW  the sculpture's shadow on the wall: pos.w = darkness (a soft outer layer + a crisp inner one)
//   5 SPRITE  additive glow (dust in the beam, sparkles); pos.w = size + corner * 100
//   6 GLOW    emissive (the revealed shape, outline hints)
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
    if (mat == 5.0) {
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
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uSpot;          // centre of the light pool on the wall
uniform vec3 uWarm;          // light colour (changes per level)
uniform float uSolved;       // 0..1 celebration glow

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// brightness of the spotlight on the wall at (x, z)
float spot(vec2 p) {
    float d = length((p - uSpot.xz) * vec2(0.8, 1.0));
    return 0.08 + 1.05 * smoothstep(5.2, 1.2, d) + 0.25 * smoothstep(2.5, 0.0, d);
}

vec3 wallColor(vec3 w) {
    float grain = noise(w.xz * 9.0) * 0.06 + noise(w.xz * 2.3) * 0.08;
    vec3 plaster = vec3(0.86, 0.8, 0.72) * (0.92 + grain);
    return plaster * uWarm * spot(w.xz);
}

void main() {
    float mat = floor(vMat + 0.5);
    vec3 V = normalize(cPoint - vWorld);
    float dist = length(cPoint - vWorld);

#ifdef GL_OES_standard_derivatives
    vec3 fn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
#else
    vec3 fn = vec3(0.0, -1.0, 0.0);
#endif
    if (dot(fn, V) < 0.0) fn = -fn;

    vec3 c;
    if (mat == 3.0) {
        vec2 s = gl_FragCoord.xy / uRes;
        c = mix(vec3(0.02, 0.018, 0.03), vec3(0.07, 0.055, 0.06), s.y) * (1.0 - 0.4 * length(s - vec2(0.55, 0.6)));
        gl_FragColor = vec4(c, 1.0); return;
    }
    if (mat == 5.0) {
        float k = max(exp(-dot(vUV, vUV) * 3.2) - 0.05, 0.0);
        gl_FragColor = vec4(vCol * k, 1.0); return;
    }
    if (mat == 1.0) {
        c = wallColor(vWorld);
        c = mix(c, c * 0.6, smoothstep(6.0, 10.0, abs(vWorld.x)));
    } else if (mat == 4.0) {
        c = wallColor(vWorld) * vW;                                  // the wall, darkened
    } else if (mat == 2.0) {
        float plank = floor(vWorld.x * 1.3);
        float grain = noise(vec2(vWorld.x * 1.3, vWorld.y * 0.35 + plank * 7.1)) * 0.25 + hash(vec2(plank, 3.0)) * 0.15;
        vec3 wood = vec3(0.28, 0.17, 0.11) * (0.8 + grain);
        if (fract(vWorld.x * 1.3) < 0.03) wood *= 0.6;
        float pool = smoothstep(6.5, 0.5, length((vWorld.xy - vec2(uSpot.x * 0.6, 1.5)) * vec2(0.7, 0.5)));
        c = wood * uWarm * (0.12 + 0.9 * pool);
        c += uWarm * 0.08 * pool * pow(max(dot(reflect(-V, vec3(0.0, 0.0, 1.0)), normalize(vec3(0.0, 1.0, 0.4))), 0.0), 12.0);
    } else if (mat == 6.0) {
        c = vCol;
    } else {                                                         // sculpture block
        vec3 L = normalize(vec3(0.5, -1.0, 0.4));                    // towards the spotlight (right, behind the viewer)
        float d = max(dot(fn, L), 0.0);
        float rim = pow(1.0 - max(dot(fn, V), 0.0), 3.0);
        float spec = pow(max(dot(reflect(-L, fn), V), 0.0), 40.0);
        vec3 fill = vec3(0.25, 0.3, 0.45) * (0.5 + 0.5 * fn.z);
        c = vCol * (uWarm * d * 1.1 + fill * 0.35) + uWarm * spec * 0.5 + vec3(0.45, 0.55, 0.9) * rim * 0.35;
        c += vCol * uSolved * 0.35;
    }
    // soft darkness away from the light
    c *= 1.0 - smoothstep(14.0, 30.0, dist) * 0.7;
    gl_FragColor = vec4(c, 1.0);
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
    for (const n of ["aspect", "veriables", "uRes", "uTime", "uSpot", "uWarm", "uSolved"]) U[n] = loc(n);
    return U;
}
