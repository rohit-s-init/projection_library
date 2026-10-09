// Prism Rush shaders. Same attributes and camera uniforms as Space.js (pos, col, cPoint, xAxis, yAxis, zAxis,
// veriables), so the library's camera drives everything.
//
// col.a = material * 8 (+ extra), col.rgb = colour.  Materials:
//   0 SOLID   colour already shaded on the CPU (lighting + neon rim), fogged
//   1 GLOW    neon parts (rails, edges, lasers, gems): bright, less fog
//   2 GROUND  the landscape grid: a fixed mesh that follows the camera; hills and neon lines made here
//   3 SKY     full-screen quad: gradient, striped synthwave sun, stars, mountain silhouettes
//   4 TRACK   the road: glossy dark floor, lane lines, chevrons, sky + sun reflection
//   6 SPRITE  camera-facing glow blob (drawn additively): pos.w = size + corner * 100
//
// The whole world is bent in the vertex shader (x += bend.x·d², z += bend.y·d², d = distance ahead), which
// gives sweeping curves and a falling horizon while the game logic stays on a straight line.
// Space's xUnitVec points to screen-left, so screen x uses -dot(v, xAxis).

export const VERT = `
attribute vec4 pos;
attribute vec4 col;
uniform vec3 cPoint;
uniform vec3 xAxis;
uniform vec3 yAxis;
uniform vec3 zAxis;
uniform vec3 veriables;      // Space's (zShifter, magnifier, -): magnifier = field of view
uniform float aspect;
uniform vec2 uBend;
uniform float uGroundSnap;

varying vec3 vCol;
varying float vMat;
varying vec3 vWorld;
varying vec3 vLocal;
varying float vDist;
varying vec2 vUV;

float hills(vec2 q) {
    float a = abs(q.x);
    float m = smoothstep(11.0, 42.0, a);
    float n = sin(q.x * 0.11 + q.y * 0.05) * 0.5 + 0.5;
    n += (sin(q.y * 0.083 - q.x * 0.05) * 0.5 + 0.5) * 0.7;
    n += (sin(q.x * 0.23 + q.y * 0.17) * 0.5 + 0.5) * 0.35;
    return m * n * (3.0 + a * 0.2) - 0.08;
}

void main() {
    float info = floor(col.a + 0.5);
    float mat = floor(info / 8.0);
    vMat = mat;
    vCol = col.rgb;
    vUV = vec2(0.0);
    if (mat == 3.0) {                                   // sky: straight to the screen, behind everything
        gl_Position = vec4(pos.xy, 0.99999, 1.0);
        vWorld = vec3(0.0); vLocal = vec3(0.0); vDist = 1000.0;
        return;
    }
    vec3 p = pos.xyz;
    if (mat == 2.0) { p.y += uGroundSnap; p.z = hills(p.xy); }
    vLocal = p;

    float d = max(p.y - cPoint.y, 0.0);
    p.x += uBend.x * d * d;
    p.z += uBend.y * d * d;

    if (mat == 6.0) {                                   // billboard: expand around its centre, facing the camera
        float corner = floor(pos.w / 100.0);
        float size = pos.w - corner * 100.0;
        vec2 c = corner < 0.5 ? vec2(-1.0, -1.0) : corner < 1.5 ? vec2(1.0, -1.0) : corner < 2.5 ? vec2(1.0, 1.0) : vec2(-1.0, 1.0);
        vUV = c;
        p += (-xAxis * c.x + yAxis * c.y) * size;
    }
    vWorld = p;

    vec3 v = p - cPoint;
    float xp = -dot(v, xAxis), yp = dot(v, yAxis), zp = dot(v, zAxis);
    vDist = length(v);
    float k = veriables.y / 1.6;
    const float NEAR = 0.05, FAR = 1200.0;
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
varying vec3 vLocal;
varying float vDist;
varying vec2 vUV;

uniform vec3 cPoint;
uniform vec2 uRes;
uniform float uTime;
uniform float uBeat;          // 0..1 pulse on the music's beat
uniform float uHorizon;       // horizon height on screen (0 bottom … 1 top)
uniform float uSunX;          // sun offset from the screen centre
uniform float uFlash;         // white flash (crash, zone change)
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSun1;
uniform vec3 uSun2;
uniform vec3 uGrid;
uniform vec3 uAccent;
uniform vec3 uGround;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec3 fogged(vec3 c, float amount) {
    float f = smoothstep(70.0, 420.0, vDist) * amount;
    return mix(c, uSkyHorizon * 0.9, f);
}

vec3 sky(vec2 s) {
    float h = s.y - uHorizon;
    vec3 c = mix(uSkyHorizon, uSkyTop, smoothstep(0.0, 0.55, h));
    c = mix(c, uSkyTop * 0.4, smoothstep(0.5, 1.0, h));
    if (h < 0.0) c = uSkyHorizon * 0.55;

    // stars
    vec2 g = floor(gl_FragCoord.xy / 2.5);
    float st = step(0.9965, hash(g)) * smoothstep(0.08, 0.35, h);
    c += st * (0.6 + 0.4 * sin(uTime * 3.0 + hash(g + 7.0) * 40.0)) * vec3(0.9, 0.95, 1.0);

    // striped sun
    float ar = uRes.x / uRes.y;
    vec2 q = vec2((s.x - 0.5 - uSunX) * ar, s.y - (uHorizon + 0.14));
    float R = 0.19;
    float r = length(q);
    c += uSun1 * 0.55 * exp(-r * 5.0) + uSun2 * 0.3 * exp(-r * 2.2);
    if (r < R) {
        float t = (q.y + R) / (2.0 * R);
        float cut = q.y < 0.02 ? step(fract(q.y * 30.0 - uTime * 0.35), 0.5 * (1.0 - t * 1.7)) : 0.0;
        vec3 sc = mix(uSun2, uSun1, t) * 1.5;
        c = mix(c, sc, (1.0 - cut) * smoothstep(R, R - 0.004, r));
    }

    // far mountains with glowing ridges
    float x = s.x + uSunX * 0.35;
    float m = 0.03 + 0.045 * abs(sin(x * 7.0 + 1.3)) * (0.6 + 0.4 * sin(x * 3.1)) + 0.018 * abs(sin(x * 23.0 + 0.4));
    if (h > -0.01 && h < m) c = mix(uSkyTop * 0.22, uSkyHorizon * 0.35, h / max(m, 0.001));
    c += uGrid * exp(-abs(h - m) * 350.0) * 0.8 * step(-0.01, h);
    c += uSkyHorizon * exp(-abs(h) * 40.0) * 0.5;
    return c;
}

void main() {
    vec3 c;
    float a = 1.0;
    vec2 s = gl_FragCoord.xy / uRes;
    float mat = floor(vMat + 0.5);          // interpolated varyings aren't exact: round before comparing

    if (mat == 3.0) {
        c = sky(s);
    } else if (mat == 2.0) {                                              // neon landscape grid
        vec2 g = vLocal.xy / 4.0;
        vec2 gd = abs(fract(g - 0.5) - 0.5);
#ifdef GL_OES_standard_derivatives
        vec2 fw = max(fwidth(g), vec2(0.0005));
#else
        vec2 fw = vec2(0.01 + vDist * 0.00035);
#endif
        vec2 ln = 1.0 - smoothstep(vec2(0.0), fw * 1.6, gd);
        vec2 gl = exp(-gd / (fw * 7.0 + 0.02));
        float line = max(ln.x, ln.y) * (1.0 - smoothstep(250.0, 520.0, vDist) * 0.6);
        float glow = max(gl.x, gl.y) * 0.35;
        float hgt = clamp(vLocal.z / 14.0, 0.0, 1.0);
        c = uGround * (0.5 + hgt) + uGrid * (line * (1.3 + uBeat * 0.8) + glow) * (0.55 + hgt);
        c = fogged(c, 0.9);
    } else if (mat == 4.0) {                                              // the road
        float x = vLocal.x, y = vLocal.y, ax = abs(x);
        c = vec3(0.012, 0.012, 0.03);
        c += uAccent * 0.9 * smoothstep(0.16, 0.0, abs(ax - 6.45));       // bright edges
        c += uAccent * 0.18 * exp(-abs(ax - 6.45) * 3.0);
        float lane = min(abs(ax - 1.3), abs(ax - 3.9));
        c += uAccent * 0.28 * smoothstep(0.06, 0.0, lane) * step(0.45, fract(y * 0.2));
        float chev = fract(y * 0.12 - ax * 0.12);
        c += uAccent * 0.1 * step(chev, 0.06) * step(ax, 1.0);
        vec3 V = normalize(cPoint - vWorld);
        float fres = pow(1.0 - clamp(V.z, 0.0, 1.0), 3.0);
        c += uSkyHorizon * 0.28 * fres;
        c += uSun1 * 0.5 * fres * exp(-abs(s.x - 0.5 - uSunX) * 18.0);    // sun reflected in the glossy floor
        c += uGrid * 0.05 * (1.0 + uBeat);
        c = fogged(c, 0.8);
    } else if (mat == 6.0) {                                              // glow sprite (additive)
        float r2 = dot(vUV, vUV);
        float k = exp(-r2 * 3.2) - 0.04;
        c = vCol * max(k, 0.0) * (1.0 - smoothstep(150.0, 450.0, vDist));
        a = 1.0;
    } else if (mat == 1.0) {
        c = fogged(vCol, 0.55);
    } else {
        c = fogged(vCol, 1.0);
    }
    if (mat != 6.0) c += uFlash;
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
    gl.bindAttribLocation(program, space.posId, "pos");      // Space's attribute slots
    gl.bindAttribLocation(program, space.colId, "col");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));

    const loc = (n) => gl.getUniformLocation(program, n);
    // point Space's own uniform locations at this program
    Object.assign(space, {
        program,
        cPointLoc: loc("cPoint"), vPointLoc: loc("vPoint"),
        xAxisLoc: loc("xAxis"), yAxisLoc: loc("yAxis"), zAxisLoc: loc("zAxis"),
        varsLocation: loc("veriables"),
    });
    gl.useProgram(program);
    const U = {};
    for (const n of ["aspect", "uBend", "uGroundSnap", "uRes", "uTime", "uBeat", "uHorizon", "uSunX", "uFlash",
        "uSkyTop", "uSkyHorizon", "uSun1", "uSun2", "uGrid", "uAccent", "uGround", "veriables"]) U[n] = loc(n);
    return U;
}
