// Chroma Drop shaders. Same attributes and camera uniforms as Space.js (pos, col, cPoint, xAxis, yAxis, zAxis,
// veriables), so the library's camera drives everything. col.a = material, col.rgb = colour.
//
//   0 GLOSS   the tower: candy-like, flat facets (normal from screen-space derivatives), specular + rim light
//   1 GLOW    danger segments (pulsing red) and the finish ring (gold)
//   2 BALL    perfectly round shading: the normal comes from the ball's centre (uniform uBall)
//   3 SKY     full-screen pastel gradient with drifting bokeh lights
//   4 SPLAT   paint splats left where the ball bounced
//   5 SPRITE  additive glow blob; pos.w = size + corner * 100
//   6 SHARD   pieces of a shattered ring, fading out: pos.w = opacity
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
    if (mat == 3.0) { gl_Position = vec4(pos.xy, 0.99999, 1.0); vWorld = vec3(0.0); return; }
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
    const float NEAR = 0.05, FAR = 400.0;
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
uniform vec3 uTop;            // background gradient (level palette)
uniform vec3 uBottom;
uniform vec3 uBall;           // ball centre
uniform float uFlash;

const vec3 L = vec3(0.35, -0.55, 0.76);

float hash(float n) { return fract(sin(n) * 43758.5453); }

vec3 light(vec3 albedo, vec3 n, vec3 V, float gloss, float specK) {
    vec3 l = normalize(L);
    float d = max(dot(n, l), 0.0);
    float wrap = 0.42 + 0.58 * d;
    float spec = pow(max(dot(reflect(-l, n), V), 0.0), gloss) * specK;
    float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    vec3 env = mix(uBottom, uTop, n.z * 0.5 + 0.5);
    return albedo * wrap + env * 0.12 + vec3(spec) + env * fres * 0.45;
}

void main() {
    float mat = floor(vMat + 0.5);
    vec3 V = cPoint - vWorld;
    float dist = length(V);
    V /= max(dist, 1e-4);
#ifdef GL_OES_standard_derivatives
    vec3 fn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
#else
    vec3 fn = vec3(0.0, -1.0, 0.0);
#endif
    if (dot(fn, V) < 0.0) fn = -fn;

    vec3 c;
    float a = 1.0;
    if (mat == 3.0) {                                           // background
        vec2 s = gl_FragCoord.xy / uRes;
        c = mix(uBottom, uTop, smoothstep(0.0, 1.0, s.y));
        float ar = uRes.x / uRes.y;
        for (int i = 0; i < 9; i++) {                           // soft bokeh lights drifting upwards
            float fi = float(i);
            vec2 p = vec2(hash(fi * 3.1) * ar, fract(hash(fi * 7.7) + uTime * (0.012 + hash(fi) * 0.02)));
            float r = 0.05 + hash(fi * 1.3) * 0.12;
            float d = length(vec2(s.x * ar, s.y) - p);
            c += vec3(1.0, 0.98, 0.95) * smoothstep(r, r * 0.6, d) * 0.07;
        }
        c *= 1.0 - 0.25 * pow(length(s - 0.5) * 1.3, 2.0);    // vignette
        gl_FragColor = vec4(c, 1.0);
        return;
    }
    if (mat == 5.0) {
        float k = max(exp(-dot(vUV, vUV) * 3.2) - 0.05, 0.0);
        gl_FragColor = vec4(vCol * k, 1.0);
        return;
    }
    if (mat == 2.0) {                                           // ball
        vec3 n = normalize(vWorld - uBall);
        c = light(vCol, n, V, 90.0, 0.9);
    } else if (mat == 1.0) {
        c = vCol * (0.85 + 0.15 * sin(uTime * 7.0)) + light(vCol * 0.3, fn, V, 50.0, 0.5) * 0.4;
    } else if (mat == 4.0) {
        c = light(vCol, fn, V, 12.0, 0.1);
    } else {
        c = light(vCol, fn, V, 45.0, 0.45);
        if (mat == 6.0) a = vW;
    }
    // far rings fade into the background
    float fog = smoothstep(18.0, 42.0, dist);
    vec2 s = gl_FragCoord.xy / uRes;
    c = mix(c, mix(uBottom, uTop, s.y), fog) + uFlash;
    gl_FragColor = vec4(c, a);
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
    for (const n of ["aspect", "veriables", "uRes", "uTime", "uTop", "uBottom", "uBall", "uFlash"]) U[n] = loc(n);
    return U;
}
