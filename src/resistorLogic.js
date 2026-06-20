// ─────────────────────────────────────────────────────────────────────────────
// resistorLogic.js
// Pure helper functions: color matching, resistance calculation, formatting.
// No DOM / canvas dependencies — easy to unit-test in isolation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Master color-band table.
 * digit  : positional digit value (null for multiplier-only bands)
 * mult   : multiplier value
 * tol    : tolerance % (null if not a valid tolerance band)
 */
export const COLOR_BANDS = [
  { name: "Black",  hex: "#1a1a1a", digit: 0, mult: 1,         tol: null },
  { name: "Brown",  hex: "#8B4513", digit: 1, mult: 10,        tol: 1    },
  { name: "Red",    hex: "#CC2020", digit: 2, mult: 100,       tol: 2    },
  { name: "Orange", hex: "#FF6600", digit: 3, mult: 1_000,     tol: null },
  { name: "Yellow", hex: "#FFD700", digit: 4, mult: 10_000,    tol: null },
  { name: "Green",  hex: "#228B22", digit: 5, mult: 100_000,   tol: 0.5  },
  { name: "Blue",   hex: "#1E5FA3", digit: 6, mult: 1_000_000, tol: 0.25 },
  { name: "Violet", hex: "#8B008B", digit: 7, mult: 1e7,       tol: 0.1  },
  { name: "Grey",   hex: "#808080", digit: 8, mult: 1e8,       tol: 0.05 },
  { name: "White",  hex: "#F0F0E8", digit: 9, mult: 1e9,       tol: null },
  { name: "Gold",   hex: "#C8A000", digit: null, mult: 0.1,    tol: 5    },
  { name: "Silver", hex: "#A8A8A8", digit: null, mult: 0.01,   tol: 10   },
  { name: "None",   hex: "#444444", digit: null, mult: null,   tol: 20   },
];

// ── Colour math utilities ─────────────────────────────────────────────────────

/** Parse "#RRGGBB" → [r, g, b] */
function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Euclidean distance in RGB space */
function colorDistance([r1, g1, b1], [r2, g2, b2]) {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

/**
 * Match an [r, g, b] triple to the nearest entry in COLOR_BANDS.
 * Uses Euclidean RGB distance; fast enough for the small, fixed palette.
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {object} Matched COLOR_BANDS entry
 */
export function matchColor(r, g, b) {
  const rgb = [r, g, b];
  let best = COLOR_BANDS[0];
  let bestDist = Infinity;

  for (const band of COLOR_BANDS) {
    if (band.name === "None") continue; // skip "no band" sentinel during matching
    const d = colorDistance(rgb, hexToRgb(band.hex));
    if (d < bestDist) {
      bestDist = d;
      best = band;
    }
  }
  return best;
}

// ── Resistance calculation ────────────────────────────────────────────────────

/**
 * Compute resistance from an array of detected band objects.
 *
 * Each element must have a `.band` property (a COLOR_BANDS entry).
 *
 * 4-band scheme: digit, digit, multiplier, tolerance
 * 5-band scheme: digit, digit, digit, multiplier, tolerance
 *
 * @param {Array}  bands    – output of extractBands()
 * @param {4 | 5} numBands
 * @returns {{ value: number, tol: number, min: number, max: number } | null}
 */
export function calcResistance(bands, numBands) {
  if (numBands === 4) {
    const [b1, b2, b3, b4] = bands;
    if (
      b1.band.digit == null ||
      b2.band.digit == null ||
      b3.band.mult == null
    ) return null;

    const value = (b1.band.digit * 10 + b2.band.digit) * b3.band.mult;
    const tol   = b4.band.tol ?? 20;
    return { value, tol, min: value * (1 - tol / 100), max: value * (1 + tol / 100) };
  }

  // 5-band
  const [b1, b2, b3, b4, b5] = bands;
  if (
    b1.band.digit == null ||
    b2.band.digit == null ||
    b3.band.digit == null ||
    b4.band.mult == null
  ) return null;

  const value = (b1.band.digit * 100 + b2.band.digit * 10 + b3.band.digit) * b4.band.mult;
  const tol   = b5.band.tol ?? 20;
  return { value, tol, min: value * (1 - tol / 100), max: value * (1 + tol / 100) };
}

// ── Display formatting ────────────────────────────────────────────────────────

/**
 * Format an ohm value into a human-readable [value, unit] pair.
 *
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
