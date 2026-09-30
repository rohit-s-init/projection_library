// Seeded 2D Perlin noise + fractal (fbm) sum, used by the terrain generator.

export function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function makeNoise(seed) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
        const j = (rand() * (i + 1)) | 0;
        const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    const perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

    // 8 gradient directions
    const GX = [1, -1, 1, -1, 1, -1, 0, 0];
    const GY = [1, 1, -1, -1, 0, 0, 1, -1];
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

    function perlin2(x, y) {
        const xi = Math.floor(x), yi = Math.floor(y);
        const xf = x - xi, yf = y - yi;
        const X = xi & 255, Y = yi & 255;
        const g = (h, dx, dy) => { h &= 7; return GX[h] * dx + GY[h] * dy; };
        const aa = perm[perm[X] + Y], ab = perm[perm[X] + Y + 1];
        const ba = perm[perm[X + 1] + Y], bb = perm[perm[X + 1] + Y + 1];
        const u = fade(xf), v = fade(yf);
        const x1 = g(aa, xf, yf) + u * (g(ba, xf - 1, yf) - g(aa, xf, yf));
        const x2 = g(ab, xf, yf - 1) + u * (g(bb, xf - 1, yf - 1) - g(ab, xf, yf - 1));
        return (x1 + v * (x2 - x1)) * 0.7071 * 1.4;   // roughly -1..1
    }

    function fbm(x, y, octaves) {
        let sum = 0, amp = 1, freq = 1, norm = 0;
        for (let o = 0; o < octaves; o++) {
            sum += perlin2(x * freq, y * freq) * amp;
            norm += amp;
            amp *= 0.5; freq *= 2;
        }
        return sum / norm;
    }

    return { perlin2, fbm };
}

// cheap deterministic hash of two integers → 0..1 (tree placement etc.)
export function hash2(x, y, seed) {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}
