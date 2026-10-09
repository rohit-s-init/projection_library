// Skyputt shaders. Same attributes and camera uniforms as Space.js (pos, col, cPoint, xAxis, yAxis, zAxis,
// veriables), so the library's camera drives everything. col.a = material.
//
//   0 SOLID    flat-shaded wood, stone, rock, trees: warm sun, sky-blue fill, soft rim
//   1 TURF     the fairway: mown stripes, fine grass noise, darker near the rails
//   2 GLOW     emissive
//   3 SKY      full-screen sky with the sun and high wisps
//   4 SAND     sand traps: grainy, raked ripples
//   5 SPRITE   additive glow; pos.w = size + corner * 100
//   6 BALL     camera-facing quad shaded as a dimpled white golf ball; pos.w = radius + corner * 100
//   7 CLOUDS   the sea of clouds far below (an animated noise layer)
//   8 SHADOW   soft dark disc on the turf: pos.w = darkness
// Everything fades into the sky haze with distance.
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
    const float NEAR = 0.05, FAR = 500.0;
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
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uTop;
uniform vec3 uHor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += noise(p) * a; p = p * 2.03 + 7.1; a *= 0.5; } return s; }

vec3 sky(vec3 d) {
    float h = d.z;
    vec3 c = mix(uHor, uTop, smoothstep(-0.1, 0.6, h));
    float s = max(dot(d, normalize(uSunDir)), 0.0);
    c += uSunCol * (pow(s, 800.0) * 5.0 + pow(s, 30.0) * 0.3 + pow(s, 4.0) * 0.12);
    // high wisps
    if (h > 0.0) {
        vec2 q = d.xy / (h + 0.25) * 2.0 + vec2(uTime * 0.01, 0.0);
        c += vec3(1.0) * smoothstep(0.55, 0.85, fbm(q * vec2(0.6, 1.8))) * 0.25 * smoothstep(0.0, 0.25, h);
    }
    return c;
}
vec3 tone(vec3 c) { return vec3(1.0) - exp(-c * 1.35); }
vec3 haze(vec3 c, float dist) { return mix(c, uHor, clamp(1.0 - exp(-max(dist - 18.0, 0.0) * 0.006), 0.0, 1.0)); }

vec3 light(vec3 albedo, vec3 n, vec3 V) {
    vec3 L = normalize(uSunDir);
    float d = max(dot(n, L), 0.0);
    vec3 fill = mix(vec3(0.35, 0.33, 0.3), uTop * 0.9, n.z * 0.5 + 0.5);
    float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    return albedo * (uSunCol * d * 1.05 + fill * 0.55) + uHor * rim * 0.12;
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
        gl_FragColor = vec4(tone(sky(d)), 1.0); return;
    }
    if (mat == 5.0) {
        float k = max(exp(-dot(vUV, vUV) * 3.2) - 0.05, 0.0);
        gl_FragColor = vec4(vCol * k, 1.0); return;
    }
    if (mat == 2.0) { gl_FragColor = vec4(vCol, 1.0); return; }
    if (mat == 6.0) {                                                // golf ball impostor
        float r2 = dot(vUV, vUV);
        if (r2 > 1.0) discard;
        vec3 n = normalize(-xAxis * vUV.x + yAxis * vUV.y - zAxis * sqrt(1.0 - r2));
        vec2 dm = fract(vUV * 4.5 + vec2(0.0, 0.5) * floor(vUV.x * 4.5)) - 0.5;
        float dimple = smoothstep(0.18, 0.05, dot(dm, dm)) * 0.08;
        vec3 c = light(vec3(0.95, 0.95, 0.93) * (1.0 - dimple), n, V);
        c += uSunCol * pow(max(dot(reflect(-V, n), normalize(uSunDir)), 0.0), 60.0) * 0.5;
        gl_FragColor = vec4(tone(c), 1.0); return;
    }
    if (mat == 7.0) {                                                // the sea of clouds
        vec2 q = vWorld.xy * 0.03 + vec2(uTime * 0.008, uTime * 0.003);
        float n = fbm(q) * 0.7 + fbm(q * 3.0 - uTime * 0.01) * 0.3;
        vec3 c = mix(vec3(0.5, 0.64, 0.88), vec3(1.05, 1.03, 1.0), smoothstep(0.32, 0.72, n));
        c = mix(c, c * vec3(0.8, 0.85, 1.0), smoothstep(0.6, 0.3, n) * 0.5);
        c += uSunCol * 0.1 * smoothstep(0.6, 0.9, n);
        c = mix(c, uHor, clamp(dist / 420.0, 0.0, 1.0));
        gl_FragColor = vec4(tone(c), 1.0); return;
    }

    vec3 c;
    if (mat == 1.0) {                                                // turf
        float stripe = step(0.5, fract((vWorld.x + vWorld.y * 0.0) / 1.5)) * 0.07 + step(0.5, fract(vWorld.y / 1.5)) * 0.07;
        float fine = noise(vWorld.xy * 14.0) * 0.12 + noise(vWorld.xy * 3.0) * 0.08;
        vec3 g = vCol * (0.86 + stripe + fine);
        c = light(g, vec3(0.0, 0.0, 1.0), V);
        c *= mix(0.8, 1.0, clamp(vW, 0.0, 1.0));                    // vW: closeness to the rails (ambient occlusion)
    } else if (mat == 4.0) {                                         // sand
        float rake = sin(vWorld.x * 9.0 + sin(vWorld.y * 2.0) * 1.5) * 0.04;
        vec3 s = vec3(0.93, 0.82, 0.6) * (0.9 + noise(vWorld.xy * 40.0) * 0.15 + rake);
        c = light(s, vec3(0.0, 0.0, 1.0), V);
    } else if (mat == 8.0) {                                         // shadow (drawn over turf, darkens it)
        float stripe = step(0.5, fract(vWorld.x / 1.5)) * 0.07 + step(0.5, fract(vWorld.y / 1.5)) * 0.07;
        c = light(vCol * (0.86 + stripe), vec3(0.0, 0.0, 1.0), V) * vW;
    } else {
        c = light(vCol, fn, V);
    }
    gl_FragColor = vec4(tone(haze(c, dist)), 1.0);
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
    for (const n of ["aspect", "veriables", "uRes", "uTime", "uSunDir", "uSunCol", "uTop", "uHor"]) U[n] = loc(n);
    return U;
}
