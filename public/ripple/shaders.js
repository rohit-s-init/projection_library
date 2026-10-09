// Ripple shaders. Same attributes and camera uniforms as Space.js (pos, col, cPoint, xAxis, yAxis, zAxis,
// veriables), so the library's camera drives everything. col.a = material.
//
//   0 SOLID   flat-shaded garden, rocks, boat, lily pads, lanterns: cool moonlight + warm lantern point lights
//   1 WATER   reads the ripple texture (normals, shallowness, height) and reflects the night sky, the moon and
//             every lantern; lighter in the shallows, sparkles on crests
//   2 GLOW    emissive (lantern paper, candle, open lotus)
//   3 SKY     full-screen night sky: gradient, stars, moon with halo
//   5 SPRITE  additive glow (fireflies, splashes, lantern halos); pos.w = size + corner * 100
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
    const float NEAR = 0.05, FAR = 300.0;
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
uniform sampler2D uWater;
uniform vec4 uPondRect;        // x0, y0, width, height of the water texture in world units
uniform vec4 uLights[6];       // lantern lights: xyz, strength
uniform float uLightCount;

const vec3 MOON_DIR = vec3(0.45, 0.62, 0.64);
const vec3 MOON = vec3(0.62, 0.72, 0.98);
const vec3 WARM = vec3(1.0, 0.62, 0.3);

vec3 tone(vec3 c) { return vec3(1.0) - exp(-c * 1.8); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec3 nightSky(vec3 d) {
    float h = d.z;
    vec3 c = mix(vec3(0.09, 0.12, 0.26), vec3(0.02, 0.03, 0.09), smoothstep(0.0, 0.7, h));
    c += vec3(0.2, 0.15, 0.3) * exp(-abs(h) * 6.0);                    // a faint glow on the horizon
    vec3 m = normalize(MOON_DIR);
    float md = dot(d, m);
    c += MOON * (smoothstep(0.9985, 0.9991, md) * 2.2 + pow(max(md, 0.0), 60.0) * 0.35 + pow(max(md, 0.0), 8.0) * 0.06);
    return c;
}

void main() {
    float mat = floor(vMat + 0.5);
    vec3 V = normalize(cPoint - vWorld);

    if (mat == 3.0) {
        vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
        vec3 d = normalize(zAxis - xAxis * ndc.x * (1.6 / veriables.y) + yAxis * ndc.y * (1.6 / (veriables.y * aspect)));
        vec3 c = nightSky(d);
        vec2 g = floor(gl_FragCoord.xy / 2.0);
        float s = hash(g);
        c += step(0.996, s) * (0.5 + 0.5 * sin(uTime * 2.0 + s * 60.0)) * smoothstep(0.0, 0.25, d.z) * vec3(0.9, 0.95, 1.0);
        gl_FragColor = vec4(tone(c), 1.0); return;
    }
    if (mat == 5.0) {
        float k = max(exp(-dot(vUV, vUV) * 3.2) - 0.05, 0.0);
        gl_FragColor = vec4(vCol * k, 1.0); return;
    }
    if (mat == 2.0) { gl_FragColor = vec4(vCol, 1.0); return; }

    if (mat == 1.0) {                                                   // water
        vec2 uv = (vWorld.xy - uPondRect.xy) / uPondRect.zw;
        vec4 t = texture2D(uWater, uv);
        vec3 n = normalize(vec3((t.r - 0.5) * 2.0, (t.g - 0.5) * 2.0, 1.0));
        float shallow = t.b, crest = t.a - 0.5;
        float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
        vec3 R = reflect(-V, n);
        vec3 refl = min(nightSky(vec3(R.xy, abs(R.z))), vec3(0.55, 0.62, 0.8));
        vec3 body = mix(vec3(0.02, 0.08, 0.13), vec3(0.08, 0.3, 0.32), shallow);
        vec3 c = mix(body, refl, 0.2 + fres * 0.6);
        // moon glint and long lantern reflections
        c += MOON * pow(max(dot(R, normalize(MOON_DIR)), 0.0), 220.0) * 1.4;
        for (int i = 0; i < 6; i++) {
            if (float(i) >= uLightCount) break;
            vec3 L = uLights[i].xyz - vWorld;
            float d = length(L);
            float sp = pow(max(dot(R, L / d), 0.0), 40.0);
            c += WARM * uLights[i].w * (sp * 1.2 + 0.16 / (1.0 + d * d * 0.6));
        }
        c += vec3(0.6, 0.75, 1.0) * max(crest, 0.0) * 0.5;               // light catching the crests
        gl_FragColor = vec4(tone(c), 1.0); return;
    }

    // solid
#ifdef GL_OES_standard_derivatives
    vec3 fn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
#else
    vec3 fn = vec3(0.0, 0.0, 1.0);
#endif
    if (dot(fn, V) < 0.0) fn = -fn;
    vec3 c = vCol * (vec3(0.12, 0.14, 0.26) + MOON * max(dot(fn, normalize(MOON_DIR)), 0.0) * 0.85);
    for (int i = 0; i < 6; i++) {
        if (float(i) >= uLightCount) break;
        vec3 L = uLights[i].xyz - vWorld;
        float d = length(L);
        c += vCol * WARM * uLights[i].w * max(dot(fn, L / d), 0.0) * 2.2 / (1.0 + d * d * 0.35);
    }
    c += vec3(0.25, 0.3, 0.5) * pow(1.0 - max(dot(fn, V), 0.0), 3.0) * 0.12;
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
    for (const n of ["aspect", "veriables", "uRes", "uTime", "uWater", "uPondRect", "uLights", "uLightCount"]) U[n] = loc(n);
    return U;
}
