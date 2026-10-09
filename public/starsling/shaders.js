// Starsling shaders. Same attributes and camera uniforms as Space.js (pos, col, cPoint, xAxis, yAxis, zAxis,
// veriables), so the library's camera drives everything. col.a = material.
//
//   0 SOLID    flat-shaded lit objects (stars, asteroids, launcher)
//   1 PLANET   procedural surfaces; col.rgb = the vertex's unit direction on the sphere, pos.w = body index
//              (colours, type, spin come from the body uniform arrays)
//   2 GLOW     emissive
//   3 SKY      full-screen nebula + stars (uses the view direction)
//   4 GRID     the spacetime grid: flat mesh pushed down into every body's gravity well (drawn additively)
//   5 SPRITE   additive glow blob; pos.w = size + corner * 100
//   6 RING     planetary rings (translucent): pos.w = radial position 0..1 across the ring
//   7 ATMO     atmosphere halo around a planet (additive sprite with a rim profile)
// Space's xUnitVec points to screen-left, so screen x uses -dot(v, xAxis).

const MAXB = 12;

export const VERT = `
attribute vec4 pos;
attribute vec4 col;
uniform vec3 cPoint;
uniform vec3 xAxis;
uniform vec3 yAxis;
uniform vec3 zAxis;
uniform vec3 veriables;
uniform float aspect;
uniform vec4 uB[${MAXB}];        // body: x, y, z, radius
uniform vec4 uBM[${MAXB}];       // body: mass, type, spin angle, tilt
uniform float uBCount;

varying vec3 vCol;
varying float vMat;
varying vec3 vWorld;
varying vec2 vUV;
varying float vW;
varying vec2 vGrid;
varying float vDepth;

void main() {
    float mat = floor(col.a + 0.5);
    vMat = mat; vCol = col.rgb; vUV = vec2(0.0); vW = pos.w; vGrid = vec2(0.0); vDepth = 0.0;
    if (mat == 3.0) { gl_Position = vec4(pos.xy, 0.99999, 1.0); vWorld = vec3(0.0); return; }
    vec3 p = pos.xyz;
    if (mat == 4.0) {                                   // sink the grid into the gravity wells
        float z = 0.0;
        for (int i = 0; i < ${MAXB}; i++) {
            if (float(i) >= uBCount) break;
            vec2 d = p.xy - uB[i].xy;
            z -= uBM[i].x * 0.55 / sqrt(dot(d, d) + 0.9);
        }
        vGrid = p.xy;
        vDepth = -z;
        p.z = max(z, -7.0) - 1.3;
    } else if (mat == 5.0 || mat == 7.0) {             // billboards
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
varying vec2 vGrid;
varying float vDepth;

uniform vec3 cPoint;
uniform vec3 xAxis;
uniform vec3 yAxis;
uniform vec3 zAxis;
uniform vec3 veriables;
uniform float aspect;
uniform vec2 uRes;
uniform float uTime;
uniform vec4 uBM[${MAXB}];
uniform vec3 uBA[${MAXB}];       // colour A
uniform vec3 uBB[${MAXB}];       // colour B
uniform float uBSeed[${MAXB}];
uniform float uFlash;

const vec3 L = vec3(-0.55, 0.25, 0.8);

float h3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float n3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * n3(p); p = p * 2.03 + 11.3; a *= 0.5; } return s; }

vec3 planetSurface(float type, vec3 d, vec3 A, vec3 B, float seed, out vec3 emit) {
    emit = vec3(0.0);
    vec3 q = d + seed;
    if (type < 0.5) {                                              // gas giant: turbulent bands + a storm
        float t = d.z * 7.0 + fbm(q * 2.2) * 2.2;
        vec3 c = mix(A, B, 0.5 + 0.5 * sin(t * 2.6));
        c = mix(c, A * 1.15, smoothstep(0.55, 0.8, fbm(q * 5.0)) * 0.35);
        float storm = smoothstep(0.22, 0.12, length(d - normalize(vec3(0.7, -0.5, -0.35))));
        return mix(c, B * 1.3 + vec3(0.1), storm * 0.8);
    } else if (type < 1.5 || type > 4.5) {                          // rock / moon: highlands and craters
        float n = fbm(q * 3.0);
        vec3 c = mix(B, A, smoothstep(0.35, 0.68, n));
        float cr = n3(q * 9.0);
        c *= 0.78 + 0.32 * smoothstep(0.25, 0.55, cr) + 0.1 * smoothstep(0.75, 0.8, cr);
        return c;
    } else if (type < 2.5) {                                        // ice: pale swirls and blue cracks
        vec3 c = mix(A, B, fbm(q * 3.5) * 0.9);
        float ridge = 1.0 - abs(n3(q * 7.0) * 2.0 - 1.0);
        return mix(c, B * 0.55, smoothstep(0.9, 0.98, ridge));
    } else if (type < 3.5) {                                        // lava: dark crust, glowing veins
        float ridge = 1.0 - abs(fbm(q * 3.2) * 2.0 - 1.0);
        float glow = smoothstep(0.86, 0.97, ridge);
        emit = B * glow * (1.6 + 0.4 * sin(uTime * 2.0 + seed));
        return A * (0.7 + 0.3 * fbm(q * 8.0));
    }
    // ocean world: continents, ice caps, drifting clouds
    float land = smoothstep(0.5, 0.54, fbm(q * 1.9));
    vec3 c = mix(A * (0.8 + 0.3 * fbm(q * 6.0)), B * (0.85 + 0.3 * fbm(q * 7.0)), land);
    c = mix(c, vec3(0.95, 0.97, 1.0), smoothstep(0.78, 0.86, abs(d.z)));
    float cl = smoothstep(0.55, 0.75, fbm(q * 2.6 + vec3(uTime * 0.03, 0.0, 0.0)));
    return mix(c, vec3(1.0), cl * 0.75);
}

vec3 tonemap(vec3 c) { return c / (1.0 + c * 0.25); }

void main() {
    float mat = floor(vMat + 0.5);
    vec3 V = normalize(cPoint - vWorld);
    vec3 l = normalize(L);

    if (mat == 3.0) {                                               // nebula sky
        vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
        vec3 d = normalize(zAxis - xAxis * ndc.x * (1.6 / veriables.y) + yAxis * ndc.y * (1.6 / (veriables.y * aspect)));
        vec3 c = vec3(0.008, 0.01, 0.03);
        float n = fbm(d * 2.2 + vec3(0.0, 0.0, uTime * 0.004));
        float n2 = fbm(d * 4.0 + 7.0);
        c += vec3(0.35, 0.1, 0.45) * smoothstep(0.45, 0.85, n) * 0.55;
        c += vec3(0.05, 0.3, 0.5) * smoothstep(0.5, 0.9, n2) * 0.45;
        c += vec3(0.9, 0.4, 0.3) * pow(smoothstep(0.6, 0.95, n * n2 * 1.8), 2.0) * 0.25;
        // stars: soft round points (a random few cells of a 3D grid over the view direction)
        vec3 g1 = d * 260.0, g2 = d * 90.0;
        float s = h3(floor(g1));
        c += step(0.9975, s) * smoothstep(0.5, 0.1, length(fract(g1) - 0.5)) * (0.6 + 0.4 * sin(uTime * 2.0 + s * 50.0)) * vec3(0.9, 0.95, 1.0);
        c += step(0.9985, h3(floor(g2))) * smoothstep(0.35, 0.0, length(fract(g2) - 0.5)) * vec3(1.0, 0.9, 0.8) * 1.4;
        gl_FragColor = vec4(tonemap(c) + uFlash, 1.0);
        return;
    }
    if (mat == 5.0) {
        float k = max(exp(-dot(vUV, vUV) * 3.2) - 0.04, 0.0);
        gl_FragColor = vec4(vCol * k, 1.0);
        return;
    }
    if (mat == 7.0) {                                               // atmosphere halo: brightest right at the rim
        float r = length(vUV) * 1.5;
        float g = r < 1.0 ? smoothstep(0.75, 1.0, r) * 0.5 : exp(-(r - 1.0) * 7.0);
        g *= 1.0 - smoothstep(1.35, 1.5, r);
        gl_FragColor = vec4(vCol * g, 1.0);
        return;
    }
    if (mat == 4.0) {                                               // spacetime grid lines
        vec2 g = vGrid;
        vec2 gd = abs(fract(g - 0.5) - 0.5);
#ifdef GL_OES_standard_derivatives
        vec2 fw = max(fwidth(g), vec2(0.001));
#else
        vec2 fw = vec2(0.03);
#endif
        vec2 ln = 1.0 - smoothstep(vec2(0.0), fw * 1.5, gd);
        float line = max(ln.x, ln.y);
        float depth = clamp(vDepth / 5.0, 0.0, 1.0);
        vec3 c = mix(vec3(0.15, 0.35, 0.9), vec3(0.9, 0.35, 1.0), depth) * (0.25 + depth * 1.3);
        float edge = 1.0 - smoothstep(14.0, 21.0, length(g * vec2(0.8, 1.1)));
        gl_FragColor = vec4(c * line * edge, 1.0);
        return;
    }
    if (mat == 2.0) { gl_FragColor = vec4(tonemap(vCol) + uFlash, 1.0); return; }

    if (mat == 1.0) {                                               // planet
        float idx = floor(vW + 0.5);
        vec4 bm = vec4(0.0); vec3 A = vec3(0.0), B = vec3(0.0); float seed = 0.0;
        for (int i = 0; i < ${MAXB}; i++) if (float(i) == idx) { bm = uBM[i]; A = uBA[i]; B = uBB[i]; seed = uBSeed[i]; }
        vec3 n = normalize(vCol);
        // surface coordinates spin (and tilt) with the planet; lighting uses the fixed normal
        float cs = cos(bm.z), sn = sin(bm.z), ct = cos(bm.w), st = sin(bm.w);
        vec3 d = vec3(n.x * cs - n.y * sn, n.x * sn + n.y * cs, n.z);
        d = vec3(d.x, d.y * ct - d.z * st, d.y * st + d.z * ct);
        vec3 emit;
        vec3 albedo = planetSurface(bm.y, d, A, B, seed, emit);
        if (bm.y > 5.5) { gl_FragColor = vec4(vec3(0.0), 1.0); return; }        // black hole core
        float diff = max(dot(n, l), 0.0);
        float term = smoothstep(-0.15, 0.25, dot(n, l));
        float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
        vec3 c = albedo * (diff * 1.15 + 0.05) + emit * (0.4 + 0.6 * (1.0 - term)) + mix(A, vec3(0.6, 0.8, 1.0), 0.5) * rim * 0.35 * term;
        gl_FragColor = vec4(tonemap(c) + uFlash, 1.0);
        return;
    }

    // SOLID / RING: flat facets
#ifdef GL_OES_standard_derivatives
    vec3 fn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
#else
    vec3 fn = vec3(0.0, 0.0, 1.0);
#endif
    if (dot(fn, V) < 0.0) fn = -fn;
    float diff = 0.3 + 0.7 * max(dot(fn, l), 0.0);
    float spec = pow(max(dot(reflect(-l, fn), V), 0.0), 30.0) * 0.4;
    vec3 c = vCol * diff + spec;
    float a = 1.0;
    if (mat == 6.0) {
        float f = vW;
        float band = 0.55 + 0.45 * sin(f * 38.0) * sin(f * 11.0 + 1.3);
        a = band * smoothstep(0.0, 0.08, f) * smoothstep(1.0, 0.85, f) * 0.75;
        c = vCol * (0.45 + 0.55 * max(dot(vec3(0.0, 0.0, 1.0), l), 0.0)) * (0.8 + 0.4 * band);
    }
    gl_FragColor = vec4(tonemap(c) + uFlash, a);
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
    const U = { MAXB };
    for (const n of ["aspect", "veriables", "uRes", "uTime", "uB", "uBM", "uBA", "uBB", "uBSeed", "uBCount", "uFlash"]) U[n] = loc(n);
    return U;
}
