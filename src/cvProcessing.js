// ─────────────────────────────────────────────────────────────────────────────
// cvProcessing.js
// Browser-native image processing using the Canvas 2D API.
//
// v4 CHANGES — DYNAMIC BAND SEGMENTATION (replaces fixed equal-width slots):
//
//   Every prior version assumed bands were evenly spaced across the ROI
//   (`roiW / (numBands*2+1)` equal slots). That assumption breaks on ANY
//   resistor — real or illustrated — whose gap/band width ratio differs
//   from the assumed even rhythm. A clip-art resistor with wide body-color
//   gaps between bands is exactly the case that exposed this: band 1 and 2
//   sample positions landed on background color instead of the actual bands,
//   every single time, regardless of lighting.
//
//   The fix: stop guessing WHERE the bands are. Find them.
//
//     1. Scan a horizontal strip across the ROI and build a per-column
//        color profile (robust median + glare/shadow rejection per column,
//        white-balanced).
//     2. Light horizontal smoothing to suppress single-pixel noise.
//     3. Run-length encode the profile into contiguous same-color segments
//        — this is the 1D equivalent of contour detection.
//     4. Identify the resistor BODY color by sampling the ROI's left/right
//        edges (where the capture box is expected to show body, not bands).
//     5. Discard segments matching the body color and segments too thin to
//        be real bands (anti-aliasing/transition noise) — what's left are
//        the actual band positions, regardless of spacing irregularities.
//     6. If more candidates remain than numBands, keep the N widest (real
//        bands are wide; stray noise segments are thin) and re-sort
//        left-to-right.
//
//   If segmentation doesn't cleanly resolve to exactly `numBands` segments
//   on a given frame (rare — very low contrast, motion blur), that single
//   frame falls back to the old fixed-slot method as a safety net. Because
//   burst voting runs ~10 frames per Capture, an occasional fallback frame
//   just gets outvoted by the (now far more reliable) segmented frames.
//
//   Everything from v3 is retained on top of this: geometry-corrected ROI
//   (object-fit:cover crop math), gray-world white balance, glare/shadow
//   pixel rejection, frame-level exposure gating, and the UNREADABLE_BAND
//   sentinel for genuinely unusable regions.
// ─────────────────────────────────────────────────────────────────────────────

import { matchColor, UNREADABLE_BAND } from "./resistorLogic";
import { getVisibleCropRect } from "./videoGeometry";

// ── ROI constants (fractions of the VISIBLE/displayed window) ─────────────────
// Match the on-screen amber target-box position — see .target-box in index.css.
const ROI_X      = 0.15;
const ROI_WIDTH  = 0.70;
const ROI_Y      = 0.30;
const ROI_HEIGHT = 0.40;

const SAMPLE_HEIGHT_FRACTION = 0.80; // vertical strip used for the column profile
const SAMPLE_WIDTH_FRACTION  = 0.60; // used only by the fixed-slot fallback
const MIN_SAMPLE_PX          = 4;

// Glare / shadow rejection thresholds (0-1 normalized).
const GLARE_VALUE_MIN  = 0.92;
const GLARE_SAT_MAX    = 0.12;
const SHADOW_VALUE_MAX = 0.04;

// A run-length segment narrower than this fraction of the ROI width is
// treated as edge/transition noise, not a real band.
const MIN_BAND_WIDTH_FRACTION = 0.025;

// If fewer than this fraction of a sampled region's pixels survive
// glare/shadow rejection, that band is reported as UNREADABLE.
const MIN_VALID_PIXEL_RATIO = 0.15;

// If more than this fraction of the WHOLE ROI is clipped, the entire frame
// is discarded from the burst vote (true overexposure, not worth sampling).
const FRAME_CLIP_RATIO_THRESHOLD = 0.5;

// ── Custom error for capture-quality failures ──────────────────────────────────

export class CaptureQualityError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "CaptureQualityError";
    this.reason = reason; // "overexposed" | "video-not-ready"
  }
}

// ── Robust statistics helpers ──────────────────────────────────────────────────

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Sample a rectangular pixel block, rejecting glare/shadow outliers, then
 * return the per-channel MEDIAN plus the fraction of pixels that were valid.
 */
function robustSampleBlock(data, x, y, w, h, imgWidth) {
  const rs = [], gs = [], bs = [];
  let total = 0;

  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const idx = ((y + dy) * imgWidth + (x + dx)) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      total++;

      const max = Math.max(r, g, b) / 255;
      const min = Math.min(r, g, b) / 255;
      const v = max;
      const s = max === 0 ? 0 : (max - min) / max;

      if (v > GLARE_VALUE_MIN && s < GLARE_SAT_MAX) continue; // glare
      if (v < SHADOW_VALUE_MAX) continue;                      // shadow

      rs.push(r); gs.push(g); bs.push(b);
    }
  }

  const validRatio = total ? rs.length / total : 0;

  if (rs.length === 0) {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const idx = ((y + dy) * imgWidth + (x + dx)) * 4;
        rs.push(data[idx]); gs.push(data[idx + 1]); bs.push(data[idx + 2]);
      }
    }
  }

  return { r: median(rs), g: median(gs), b: median(bs), validRatio };
}

// ── Gray-world white balance ───────────────────────────────────────────────────

function computeGrayWorldGains(imageData) {
  const data = imageData.data;
  const STRIDE = 4 * 5;
  let sumR = 0, sumG = 0, sumB = 0, count = 0;

  for (let i = 0; i < data.length; i += STRIDE) {
    sumR += data[i]; sumG += data[i + 1]; sumB += data[i + 2]; count++;
  }
  if (count === 0) return { gainR: 1, gainG: 1, gainB: 1 };

  const avgR = sumR / count, avgG = sumG / count, avgB = sumB / count;
  const avgGray = (avgR + avgG + avgB) / 3 || 1;

  const MAX_GAIN = 1.5;
  const MIN_GAIN = 1 / MAX_GAIN;
  const clamp = (g) => Math.min(MAX_GAIN, Math.max(MIN_GAIN, g));

  return {
    gainR: clamp(avgGray / (avgR || 1)),
    gainG: clamp(avgGray / (avgG || 1)),
    gainB: clamp(avgGray / (avgB || 1)),
  };
}

function applyGains(r, g, b, gains) {
  return [
    Math.min(255, r * gains.gainR),
    Math.min(255, g * gains.gainG),
    Math.min(255, b * gains.gainB),
  ];
}

// ── Sample + classify a single band region (shared by both paths below) ───────

function sampleAndClassifySegment(imageData, x, y, w, h, canvasWidth, gains) {
  const { r, g, b, validRatio } = robustSampleBlock(imageData.data, x, y, w, h, canvasWidth);
  const [wr, wg, wb] = applyGains(r, g, b, gains);
  const unreliable = validRatio < MIN_VALID_PIXEL_RATIO;
  const band = unreliable ? UNREADABLE_BAND : matchColor(wr, wg, wb);
  return {
    band,
    r: Math.round(wr), g: Math.round(wg), b: Math.round(wb),
    hex: `rgb(${Math.round(wr)},${Math.round(wg)},${Math.round(wb)})`,
    validRatio,
  };
}

// ── Dynamic band-boundary segmentation (primary method) ────────────────────────

/**
 * Build a per-column color profile across the ROI's horizontal strip.
 * Each column is itself a robust (glare/shadow-rejected, median) sample
 * over the vertical sampling height — not a single noisy pixel.
 */
function buildColumnProfile(imageData, roiX, sampY, roiW, sampH, canvasWidth, gains) {
  const profile = [];
  for (let dx = 0; dx < roiW; dx++) {
    const x = roiX + dx;
    const { r, g, b } = robustSampleBlock(imageData.data, x, sampY, 1, sampH, canvasWidth);
    const [wr, wg, wb] = applyGains(r, g, b, gains);
    profile.push({ x, r: wr, g: wg, b: wb });
  }
  return profile;
}

/** Light horizontal moving-average to suppress single-column pixel noise. */
function smoothProfile(profile, windowSize = 3) {
  const half = Math.floor(windowSize / 2);
  return profile.map((_, i) => {
    let rs = 0, gs = 0, bs = 0, n = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < profile.length) {
        rs += profile[j].r; gs += profile[j].g; bs += profile[j].b; n++;
      }
    }
    return { x: profile[i].x, r: rs / n, g: gs / n, b: bs / n };
  });
}

/**
 * Estimate the resistor's BODY color (not a band color) by sampling the
 * extreme left/right edges of the ROI, where the capture box is expected
 * to show body, not a color band — regardless of how wide the gaps between
 * bands are elsewhere.
 */
function estimateBodyColor(profile) {
  const edgeCount = Math.max(3, Math.floor(profile.length * 0.06));
  const samples = [...profile.slice(0, edgeCount), ...profile.slice(-edgeCount)];
  const r = median(samples.map((p) => p.r));
  const g = median(samples.map((p) => p.g));
  const b = median(samples.map((p) => p.b));
  return matchColor(r, g, b).name;
}

/** Run-length encode the column profile into contiguous same-color segments. */
function runLengthEncode(profile) {
  const runs = [];
  let current = null;

  for (const p of profile) {
    const name = matchColor(p.r, p.g, p.b).name;
    if (current && current.name === name) {
      current.endX = p.x;
      current.width += 1;
    } else {
      if (current) runs.push(current);
      current = { name, startX: p.x, endX: p.x, width: 1 };
    }
  }
  if (current) runs.push(current);
  return runs;
}

/**
 * Filter run-length segments down to real band candidates: drop anything
 * matching the body color, drop anything too thin to be a real band, then
 * — if still more than numBands survive — keep the N WIDEST (real bands
 * are wide; leftover noise segments are thin), re-sorted left-to-right.
 */
function extractBandSegments(runs, bodyColorName, numBands, roiW) {
  const minWidth = Math.max(2, Math.floor(roiW * MIN_BAND_WIDTH_FRACTION));
  let candidates = runs.filter((r) => r.name !== bodyColorName && r.width >= minWidth);

  if (candidates.length > numBands) {
    candidates = [...candidates].sort((a, b) => b.width - a.width).slice(0, numBands);
  }
  candidates.sort((a, b) => a.startX - b.startX);
  return candidates;
}

// ── Fixed-slot fallback (used only if segmentation can't resolve numBands) ────

function extractBandsFixedSlots(imageData, canvasWidth, nativeROI, numBands, gains) {
  const { x: roiX, y: roiY, w: roiW, h: roiH } = nativeROI;
  const slotW = roiW / (numBands * 2 + 1);
  const sampW = Math.max(MIN_SAMPLE_PX, Math.floor(slotW * SAMPLE_WIDTH_FRACTION));
  const sampH = Math.floor(roiH * SAMPLE_HEIGHT_FRACTION);
  const sampY = roiY + Math.floor(roiH * (1 - SAMPLE_HEIGHT_FRACTION) / 2);

  const results = [];
  for (let i = 0; i < numBands; i++) {
    const slotCentre = roiX + slotW * (i * 2 + 1.5);
    const sampX = Math.floor(slotCentre - sampW / 2);
    results.push(sampleAndClassifySegment(imageData, sampX, sampY, sampW, sampH, canvasWidth, gains));
  }
  return results;
}

// ── ROI geometry resolution ────────────────────────────────────────────────────

function resolveNativeROI(video, container, canvasWidth, canvasHeight) {
  if (video && !container) {
    console.warn(
      "[cvProcessing] resolveNativeROI called without a container element — " +
      "falling back to uncorrected ROI. Pass the .camera-wrap ref via " +
      "burstCaptureAndClassify(video, canvas, numBands, { container })."
    );
  }
  const crop = video && container ? getVisibleCropRect(video, container) : null;
  const visible = crop || { x: 0, y: 0, width: canvasWidth, height: canvasHeight };

  return {
    x: Math.floor(visible.x + ROI_X * visible.width),
    y: Math.floor(visible.y + ROI_Y * visible.height),
    w: Math.floor(ROI_WIDTH * visible.width),
    h: Math.floor(ROI_HEIGHT * visible.height),
  };
}

// ── Frame-level exposure check ──────────────────────────────────────────────────

function computeROIClipRatio(imageData, roiX, roiY, roiW, roiH, canvasWidth) {
  const data = imageData.data;
  let clipped = 0, total = 0;
  const STEP = 2;

  for (let y = roiY; y < roiY + roiH; y += STEP) {
    for (let x = roiX; x < roiX + roiW; x += STEP) {
      const idx = (y * canvasWidth + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const max = Math.max(r, g, b) / 255;
      const min = Math.min(r, g, b) / 255;
      const v = max;
      const s = max === 0 ? 0 : (max - min) / max;
      total++;
      if (v > GLARE_VALUE_MIN && s < GLARE_SAT_MAX) clipped++;
    }
  }
  return total ? clipped / total : 0;
}

// ── Single-frame band extraction (segmentation-first, slot-fallback) ───────────

function extractBandsFromImageData(imageData, canvasWidth, canvasHeight, numBands, nativeROI) {
  const { x: roiX, y: roiY, w: roiW, h: roiH } = nativeROI;
  const gains = computeGrayWorldGains(imageData);

  const sampH = Math.floor(roiH * SAMPLE_HEIGHT_FRACTION);
  const sampY = roiY + Math.floor(roiH * (1 - SAMPLE_HEIGHT_FRACTION) / 2);

  // 1-3. Build the column profile, smooth it, run-length encode it.
  const profile = buildColumnProfile(imageData, roiX, sampY, roiW, sampH, canvasWidth, gains);
  const smoothed = smoothProfile(profile, 3);
  const bodyColorName = estimateBodyColor(smoothed);
  const runs = runLengthEncode(smoothed);

  // 4-6. Filter down to the real band segments, found dynamically.
  const segments = extractBandSegments(runs, bodyColorName, numBands, roiW);

  if (segments.length === numBands) {
    return segments.map((seg) =>
      sampleAndClassifySegment(imageData, seg.startX, sampY, seg.width, sampH, canvasWidth, gains)
    );
  }

  // Segmentation didn't cleanly resolve to numBands this frame — fall back
  // to fixed equal-width slots so the burst loop still gets a usable
  // (if less precise) reading rather than a gap in the array.
  return extractBandsFixedSlots(imageData, canvasWidth, nativeROI, numBands, gains);
}

/**
 * Public single-frame API.
 */
export function extractBands(ctx, canvasWidth, canvasHeight, numBands, video = null, container = null) {
  const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
  const nativeROI = resolveNativeROI(video, container, canvasWidth, canvasHeight);
  return extractBandsFromImageData(imageData, canvasWidth, canvasHeight, numBands, nativeROI);
}

// ── Temporal voting (burst capture) ─────────────────────────────────────────────

/**
 * Sample a burst of frames, geometry-correct + white-balance + dynamically
 * segment each, reject any frame that's genuinely overexposed, then return
 * the per-band majority vote across the surviving frames.
 *
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} canvas
 * @param {4 | 5} numBands
 * @param {object} [opts]
 * @param {HTMLElement} [opts.container]  – the .camera-wrap element — REQUIRED
 *                                          for correct ROI geometry.
 * @param {number} [opts.frameCount=10]
 * @param {number} [opts.intervalMs=40]
 * @param {number} [opts.maxAttempts=25]
 * @returns {Promise<Array<{ band, r, g, b, hex, confidence }>>}
 * @throws {CaptureQualityError}
 */
export async function burstCaptureAndClassify(
  video,
  canvas,
  numBands,
  { frameCount = 10, intervalMs = 40, maxAttempts = 25, container = null } = {}
) {
  if (!video || video.readyState < 2) {
    throw new CaptureQualityError("Camera feed isn't ready yet.", "video-not-ready");
  }

  const ctx = canvas.getContext("2d");
  const perBand = Array.from({ length: numBands }, () => []);
  let goodFrames = 0;
  let attempts = 0;

  while (goodFrames < frameCount && attempts < maxAttempts) {
    attempts++;

    canvas.width = video.videoWidth || 320;
    canvas.height = video.videoHeight || 180;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const nativeROI = resolveNativeROI(video, container, canvas.width, canvas.height);
    const clipRatio = computeROIClipRatio(
      imageData, nativeROI.x, nativeROI.y, nativeROI.w, nativeROI.h, canvas.width
    );

    if (clipRatio > FRAME_CLIP_RATIO_THRESHOLD) {
      if (attempts < maxAttempts) await sleep(intervalMs);
      continue;
    }

    const frameBands = extractBandsFromImageData(
      imageData, canvas.width, canvas.height, numBands, nativeROI
    );
    frameBands.forEach((sample, i) => perBand[i].push(sample));
    goodFrames++;

    if (goodFrames < frameCount && attempts < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  if (goodFrames === 0) {
    throw new CaptureQualityError(
      "Every sampled frame was overexposed — the camera sensor is clipping to white. Reduce glare and try again.",
      "overexposed"
    );
  }

  return perBand.map((samples) => majorityVote(samples));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function majorityVote(samples) {
  const counts = new Map();
  for (const s of samples) {
    counts.set(s.band.name, (counts.get(s.band.name) || 0) + 1);
  }

  let winningName = null;
  let winningCount = -1;
  for (const [name, count] of counts) {
    if (count > winningCount) {
      winningCount = count;
      winningName = name;
    }
  }

  const winners = samples.filter((s) => s.band.name === winningName);
  const avg = (key) => Math.round(winners.reduce((sum, s) => sum + s[key], 0) / winners.length);
  const r = avg("r"), g = avg("g"), b = avg("b");

  return {
    band: winners[0].band,
    r, g, b,
    hex: `rgb(${r},${g},${b})`,
    confidence: winningCount / samples.length,
  };
}

// ── Debug helper ────────────────────────────────────────────────────────────────

/**
 * Draw the geometry-corrected ROI bounding box for visual debugging. Exact
 * band positions now vary per-frame (dynamic segmentation), so this only
 * shows the search region, not fixed slot positions.
 */
export function debugDrawROI(ctx, canvasWidth, canvasHeight, video = null, container = null) {
  const { x: roiX, y: roiY, w: roiW, h: roiH } = resolveNativeROI(video, container, canvasWidth, canvasHeight);
  ctx.strokeStyle = "rgba(245,166,35,0.8)";
  ctx.lineWidth = 2;
  ctx.strokeRect(roiX, roiY, roiW, roiH);
}
