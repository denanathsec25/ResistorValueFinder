// ─────────────────────────────────────────────────────────────────────────────
// resistorLogic.js
// Pure helper functions: color space conversion, color classification,
// resistance math, formatting. No DOM / canvas dependencies.
//
// COLOR CLASSIFICATION STRATEGY (v2 — HSV-based)
// ─────────────────────────────────────────────────────────────────────────────
// The original implementation matched raw RGB via Euclidean distance. That
// approach fails under glare / exposure shifts because brightness changes
// push ALL three RGB channels toward white, which drags the nearest-neighbour
// match toward White/Silver/Grey regardless of the band's true hue.
//
// Fix: convert to HSV first.
//   - Hue is (mostly) invariant to lighting intensity — a yellow band stays
//     yellow-hued whether dim or blown out.
//   - Saturation tells us whether hue is even trustworthy. Glare/blowout
//     drives saturation toward 0, which is exactly when hue becomes noisy.
//
// So classification branches in two:
//   1. LOW SATURATION  → achromatic family (Black/Grey/Silver/White),
//                         decided by Value (brightness) alone.
//   2. NORMAL SATURATION → chromatic family (Brown/Red/Orange/Yellow/Gold/
//                         Green/Blue/Violet), decided by weighted distance
//                         in (Hue, Saturation, Value) space, with Hue
//                         weighted heavily and S/V weighted lightly since
//                         those are the lighting-sensitive axes.
//
// A CIELAB + Delta-E76 path is also included below as a documented
// alternative — swap `classifyColor` to call `classifyLab` if you prefer
// perceptual-uniformity over the cheaper HSV approach. HSV is recommended
// for mobile/real-time use: no matrix math, runs comfortably at 30fps.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Master color-band table.
 * digit  : positional digit value (null for multiplier-only bands)
 * mult   : multiplier value
 * tol    : tolerance % (null if not a valid tolerance band)
 * family : "achromatic" (no reliable hue) or "chromatic" (hue-based)
 */
export const COLOR_BANDS = [
  { name: "Black",  hex: "#1a1a1a", digit: 0, mult: 1,         tol: null, family: "achromatic" },
  { name: "Brown",  hex: "#8B4513", digit: 1, mult: 10,        tol: 1,    family: "chromatic"  },
  { name: "Red",    hex: "#CC2020", digit: 2, mult: 100,       tol: 2,    family: "chromatic"  },
  { name: "Orange", hex: "#FF6600", digit: 3, mult: 1_000,     tol: null, family: "chromatic"  },
  { name: "Yellow", hex: "#FFD700", digit: 4, mult: 10_000,    tol: null, family: "chromatic"  },
  { name: "Green",  hex: "#228B22", digit: 5, mult: 100_000,   tol: 0.5,  family: "chromatic"  },
  { name: "Blue",   hex: "#1E5FA3", digit: 6, mult: 1_000_000, tol: 0.25, family: "chromatic"  },
  { name: "Violet", hex: "#8B008B", digit: 7, mult: 1e7,       tol: 0.1,  family: "chromatic"  },
  { name: "Grey",   hex: "#808080", digit: 8, mult: 1e8,       tol: 0.05, family: "achromatic" },
  { name: "White",  hex: "#F0F0E8", digit: 9, mult: 1e9,       tol: null, family: "achromatic" },
  { name: "Gold",   hex: "#C8A000", digit: null, mult: 0.1,    tol: 5,    family: "chromatic"  },
  { name: "Silver", hex: "#A8A8A8", digit: null, mult: 0.01,   tol: 10,   family: "achromatic" },
];

const COLOR_BY_NAME = Object.fromEntries(COLOR_BANDS.map((c) => [c.name, c]));

/**
 * Sentinel used by cvProcessing.js when a band window has too few valid
 * (non-glare, non-shadow) pixels to trust a real classification. Its digit
 * and mult are both null, so calcResistance() automatically returns null
 * instead of silently computing a bogus value — no special-casing needed
 * downstream.
 */
export const UNREADABLE_BAND = {
  name: "Unreadable",
  hex: "#3a3f4d",
  digit: null,
  mult: null,
  tol: null,
  family: "unknown",
};

// ── Color space conversions ───────────────────────────────────────────────────

/** Parse "#RRGGBB" → [r, g, b] (0-255 each) */
function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Convert RGB (0-255) to HSV.
 * @returns {[number, number, number]} [hue 0-360, saturation 0-100, value 0-100]
 */
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : (d / max) * 100;
  const v = max * 100;

  return [h, s, v];
}

/**
 * Convert RGB (0-255) to CIELAB. Standard sRGB → XYZ (D65) → Lab pipeline.
 * Provided as an alternative classification space — see `classifyLab` below.
 * @returns {[number, number, number]} [L 0-100, a, b]
 */
export function rgbToLab(r, g, b) {
  // sRGB → linear RGB
  let [rl, gl, bl] = [r, g, b].map((c) => {
    c /= 255;
    return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
  });

  // linear RGB → XYZ (D65 illuminant)
  const x = rl * 0.4124 + gl * 0.3576 + bl * 0.1805;
  const y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  const z = rl * 0.0193 + gl * 0.1192 + bl * 0.9505;

  // Normalize by D65 reference white
  const [xn, yn, zn] = [x / 0.95047, y / 1.0, z / 1.08883];
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(xn), f(yn), f(zn)];

  const L = 116 * fy - 16;
  const A = 500 * (fx - fy);
  const B = 200 * (fy - fz);
  return [L, A, B];
}

/** Simple perceptual distance in Lab space (Delta-E 1976) */
function deltaE76(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  return Math.sqrt((L1 - L2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

// ── HSV-based classification (recommended, default) ───────────────────────────

// Below this saturation, hue is too noisy to trust — fall into the
// achromatic branch instead. Tune this between 12-20 depending on your
// camera's sensor noise; lower = more colors get treated as chromatic.
const ACHROMATIC_SAT_THRESHOLD = 18;

// Value (brightness) cut points for the achromatic branch, calibrated
// against the four COLOR_BANDS achromatic hex values.
const V_BLACK_MAX  = 22; // 0-22%   → Black
const V_GREY_MAX   = 45; // 22-45%  → Grey
const V_SILVER_MAX = 75; // 45-75%  → Silver
// > 75%                  → White

// Precompute HSV reference centroids for chromatic colors from their hex values.
const CHROMATIC_REFS = COLOR_BANDS
  .filter((c) => c.family === "chromatic")
  .map((c) => ({ band: c, hsv: rgbToHsv(...hexToRgb(c.hex)) }));

/** Circular hue distance (0-180), since hue wraps at 360°/0° */
function hueDistance(h1, h2) {
  const d = Math.abs(h1 - h2);
  return Math.min(d, 360 - d);
}

/**
 * Weighted distance in HSV space. Hue dominates; S and V are weighted low
 * because they are the axes lighting conditions distort most.
 */
function hsvDistance([h1, s1, v1], [h2, s2, v2]) {
  const HUE_WEIGHT = 1.0;
  const SAT_WEIGHT = 0.25;
  const VAL_WEIGHT = 0.15;
  return (
    HUE_WEIGHT * hueDistance(h1, h2) +
    SAT_WEIGHT * Math.abs(s1 - s2) +
    VAL_WEIGHT * Math.abs(v1 - v2)
  );
}

/**
 * Classify an RGB sample using the HSV achromatic/chromatic hybrid strategy.
 * This is the function that fixes the "Yellow read as Silver" bug.
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {{ band: object, hsv: [number,number,number] }}
 */
export function classifyHSV(r, g, b) {
  const hsv = rgbToHsv(r, g, b);
  const [, s, v] = hsv;

  // ── Achromatic branch: saturation too low for hue to be meaningful ──────
  if (s < ACHROMATIC_SAT_THRESHOLD) {
    let band;
    if (v < V_BLACK_MAX) band = COLOR_BY_NAME.Black;
    else if (v < V_GREY_MAX) band = COLOR_BY_NAME.Grey;
    else if (v < V_SILVER_MAX) band = COLOR_BY_NAME.Silver;
    else band = COLOR_BY_NAME.White;
    return { band, hsv };
  }

  // ── Chromatic branch: nearest hue-weighted match ─────────────────────────
  let best = CHROMATIC_REFS[0].band;
  let bestDist = Infinity;
  for (const ref of CHROMATIC_REFS) {
    const d = hsvDistance(hsv, ref.hsv);
    if (d < bestDist) {
      bestDist = d;
      best = ref.band;
    }
  }
  return { band: best, hsv };
}

// ── CIELAB-based classification (alternative, optional) ───────────────────────

const LAB_REFS = COLOR_BANDS.map((c) => ({ band: c, lab: rgbToLab(...hexToRgb(c.hex)) }));

/**
 * Alternative classifier using perceptually-uniform Lab distance instead of
 * the HSV hybrid above. More accurate in theory (Delta-E is designed to
 * match human color perception) but costs more per-pixel math — fine for
 * single-frame capture, possibly too slow for continuous live-preview
 * classification on low-end mobile devices.
 *
 * Swap this in by changing the `matchColor` export below.
 */
export function classifyLab(r, g, b) {
  const lab = rgbToLab(r, g, b);
  let best = LAB_REFS[0].band;
  let bestDist = Infinity;
  for (const ref of LAB_REFS) {
    const d = deltaE76(lab, ref.lab);
    if (d < bestDist) {
      bestDist = d;
      best = ref.band;
    }
  }
  return { band: best, lab };
}

/**
 * Public entry point used by cvProcessing.js — change this one line to
 * switch the whole pipeline between HSV (default, fast) and Lab (slower,
 * marginally more perceptually accurate).
 */
export function matchColor(r, g, b) {
  const result = classifyHSV(r, g, b);   // ← swap to classifyLab(r, g, b) to A/B test
  return result.band;
}

// ── Resistance calculation ────────────────────────────────────────────────────

/**
 * Compute resistance from an array of detected band objects.
 * Each element must have a `.band` property (a COLOR_BANDS entry).
 *
 * 4-band: digit, digit, multiplier, tolerance
 * 5-band: digit, digit, digit, multiplier, tolerance
 *
 * @param {Array}  bands
 * @param {4 | 5} numBands
 * @returns {{ value: number, tol: number, min: number, max: number } | null}
 */
export function calcResistance(bands, numBands) {
  if (numBands === 4) {
    const [b1, b2, b3, b4] = bands;
    if (b1.band.digit == null || b2.band.digit == null || b3.band.mult == null) return null;
    const value = (b1.band.digit * 10 + b2.band.digit) * b3.band.mult;
    const tol = b4.band.tol ?? 20;
    return { value, tol, min: value * (1 - tol / 100), max: value * (1 + tol / 100) };
  }

  const [b1, b2, b3, b4, b5] = bands;
  if (
    b1.band.digit == null || b2.band.digit == null ||
    b3.band.digit == null || b4.band.mult == null
  ) return null;
  const value = (b1.band.digit * 100 + b2.band.digit * 10 + b3.band.digit) * b4.band.mult;
  const tol = b5.band.tol ?? 20;
  return { value, tol, min: value * (1 - tol / 100), max: value * (1 + tol / 100) };
}

// ── Display formatting ────────────────────────────────────────────────────────

/**
 * @param {number | null | undefined} v
 * @returns {[string, string]}  e.g. ["4.70", "kΩ"]
 */
export function formatOhms(v) {
  if (v == null || isNaN(v)) return ["---", "Ω"];
  if (v >= 1e9) return [(v / 1e9).toFixed(2), "GΩ"];
  if (v >= 1e6) return [(v / 1e6).toFixed(2), "MΩ"];
  if (v >= 1e3) return [(v / 1e3).toFixed(2), "kΩ"];
  return [v.toFixed(0), "Ω"];
}
