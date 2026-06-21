// ─────────────────────────────────────────────────────────────────────────────
// cvProcessing.js
// Browser-native image processing using the Canvas 2D API.
//
// v3 CHANGES (fixes "100% confidence, all bands read White"):
//
//   1. GEOMETRY-CORRECTED ROI (the primary fix) — sampling coordinates are
//      now mapped through getVisibleCropRect() from videoGeometry.js, so the
//      ROI matches the actual cropped window the user sees on screen, not
//      the full native camera frame. Previously these could diverge by
//      20-30%+ on phones, causing the algorithm to sample background pixels
//      instead of the resistor — deterministically, every frame, hence the
//      false 100% confidence.
//
//   2. GRAY-WORLD WHITE BALANCE — corrects color casts from ambient lighting
//      (warm indoor bulbs, cool LED, etc.) before classification, so genuine
//      Brown/Red/Gold bands aren't desaturated into the achromatic family.
//
//   3. EXPOSURE GATING — frames where too much of the ROI is sensor-clipped
//      (true glare/overexposure, not a geometry bug) are now REJECTED from
//      the burst vote rather than silently classified. If every frame in a
//      burst is overexposed, a CaptureQualityError is thrown instead of
//      returning a confident-but-wrong answer.
//
//   4. UNREADABLE_BAND sentinel — if an individual band window still has too
//      few valid (non-clipped, non-shadow) pixels after all of the above, it
//      is reported as "Unreadable" rather than guessed as a real color.
// ─────────────────────────────────────────────────────────────────────────────

import { matchColor, UNREADABLE_BAND } from "./resistorLogic";
import { getVisibleCropRect } from "./videoGeometry";

// ── ROI constants (fractions of the VISIBLE/displayed window) ─────────────────
// These match the on-screen amber target-box position — see .target-box in
// index.css (centered, 70% wide, 28% tall — these are intentionally a touch
// larger to give a small margin around it).
const ROI_X      = 0.15;
const ROI_WIDTH  = 0.70;
const ROI_Y      = 0.30;
const ROI_HEIGHT = 0.40;

const SAMPLE_WIDTH_FRACTION  = 0.60;
const SAMPLE_HEIGHT_FRACTION = 0.80;
const MIN_SAMPLE_PX          = 4;

// Glare / shadow rejection thresholds (0-1 normalized).
const GLARE_VALUE_MIN  = 0.92;
const GLARE_SAT_MAX    = 0.12;
const SHADOW_VALUE_MAX = 0.04;

// If fewer than this fraction of a band window's pixels survive glare/shadow
// rejection, the band is reported as UNREADABLE rather than guessed.
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
 * return the per-channel MEDIAN plus the fraction of pixels that were valid
 * (not rejected). A low validRatio signals the window was mostly glare.
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

  // Still compute a display-able color even on total rejection (for the
  // swatch UI) — but validRatio will correctly mark it unreliable.
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

/**
 * Estimate per-channel gain to neutralize a color cast from ambient
 * lighting, using the classic gray-world assumption (the average color of
 * a sufficiently varied scene should be neutral gray). Gains are clamped to
 * avoid amplifying noise when the assumption doesn't hold well.
 */
function computeGrayWorldGains(imageData) {
  const data = imageData.data;
  const STRIDE = 4 * 5; // sample every 5th pixel — plenty for a stable average, much faster
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

// ── ROI geometry resolution ────────────────────────────────────────────────────

/**
 * Resolve the ROI from DISPLAY-fraction space into NATIVE pixel coordinates,
 * correcting for the object-fit:cover crop between what's shown on screen
 * and the camera's native frame. Falls back to treating the full native
 * frame as visible (no crop) if geometry can't be determined yet.
 *
 * BUGFIX: getVisibleCropRect() requires the on-screen container element to
 * measure its rendered box (via getBoundingClientRect) and compute the
 * object-fit:cover crop math against it. Previously `container` was never
 * passed through from the call sites below, so it was always `undefined`
 * inside getVisibleCropRect() — every call threw a TypeError, which is what
 * produced the "Error processing frame — try again" status on literally
 * every Capture press, in both 4-band and 5-band modes, regardless of
 * lighting or resistor type.
 */
function resolveNativeROI(video, container, canvasWidth, canvasHeight) {
  if (video && !container) {
    // Don't fail silently — a missing container means ROI geometry is
    // wrong on any cropped (object-fit:cover) display, which is the exact
    // class of bug that caused the "Error processing frame" failures.
    console.warn(
      "[cvProcessing] resolveNativeROI called without a container element — " +
      "falling back to uncorrected ROI. Pass the .camera-wrap ref via " +
      "burstCaptureAndClassify(video, canvas, numBands, { container }) to fix sampling alignment."
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
  const STEP = 2; // every other pixel — fast, still representative

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

// ── Single-frame band extraction ───────────────────────────────────────────────

function extractBandsFromImageData(imageData, canvasWidth, canvasHeight, numBands, nativeROI) {
  const { x: roiX, y: roiY, w: roiW, h: roiH } = nativeROI;
  const gains = computeGrayWorldGains(imageData);

  const slotW = roiW / (numBands * 2 + 1);
  const sampW = Math.max(MIN_SAMPLE_PX, Math.floor(slotW * SAMPLE_WIDTH_FRACTION));
  const sampH = Math.floor(roiH * SAMPLE_HEIGHT_FRACTION);
  const sampY = roiY + Math.floor(roiH * (1 - SAMPLE_HEIGHT_FRACTION) / 2);

  const results = [];

  for (let i = 0; i < numBands; i++) {
    const slotCentre = roiX + slotW * (i * 2 + 1.5);
    const sampX = Math.floor(slotCentre - sampW / 2);

    const { r: rawR, g: rawG, b: rawB, validRatio } = robustSampleBlock(
      imageData.data, sampX, sampY, sampW, sampH, canvasWidth
    );

    const [r, g, b] = applyGains(rawR, rawG, rawB, gains);
    const unreliable = validRatio < MIN_VALID_PIXEL_RATIO;
    const band = unreliable ? UNREADABLE_BAND : matchColor(r, g, b);

    results.push({
      band,
      r: Math.round(r), g: Math.round(g), b: Math.round(b),
      hex: `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`,
      validRatio,
    });
  }

  return results;
}

/**
 * Public single-frame API. Pass the live `video` element when available so
 * the ROI can be geometry-corrected; omitting it falls back to treating the
 * full canvas as the visible window (fine for static images / testing).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {4 | 5} numBands
 * @param {HTMLVideoElement} [video]
 */
export function extractBands(ctx, canvasWidth, canvasHeight, numBands, video = null, container = null) {
  const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
  const nativeROI = resolveNativeROI(video, container, canvasWidth, canvasHeight);
  return extractBandsFromImageData(imageData, canvasWidth, canvasHeight, numBands, nativeROI);
}

// ── Temporal voting (burst capture) ─────────────────────────────────────────────

/**
 * Sample a burst of frames, geometry-correct and white-balance each, reject
 * any frame that's genuinely overexposed, then return the per-band majority
 * vote across the surviving frames.
 *
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} canvas
 * @param {4 | 5} numBands
 * @param {object} [opts]
 * @param {HTMLElement} [opts.container]  – the .camera-wrap element (object-fit:cover
 *                                          container) — REQUIRED for correct ROI geometry.
 *                                          Without it, ROI falls back to the full native
 *                                          frame, which is wrong whenever the displayed
 *                                          video is cropped (almost always on mobile).
 * @param {number} [opts.frameCount=10]   – good frames to collect
 * @param {number} [opts.intervalMs=40]   – delay between attempts
 * @param {number} [opts.maxAttempts=25]  – give up after this many tries total
 * @returns {Promise<Array<{ band, r, g, b, hex, confidence }>>}
 * @throws {CaptureQualityError} if no usable frames could be collected
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
      // Whole frame too blown-out to trust — skip it, try again.
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

/**
 * Per-band majority vote across burst samples. Returns the winning color,
 * the averaged RGB of just the winning samples, and a confidence score.
 */
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
 * Draw the geometry-corrected sampling regions onto a canvas for visual
 * debugging — overlay this on a frame to confirm the ROI actually lands on
 * the resistor body.
 */
export function debugDrawSamplingRegions(ctx, canvasWidth, canvasHeight, numBands, video = null, container = null) {
  const { x: roiX, y: roiY, w: roiW, h: roiH } = resolveNativeROI(video, container, canvasWidth, canvasHeight);

  ctx.strokeStyle = "rgba(245,166,35,0.8)";
  ctx.lineWidth = 2;
  ctx.strokeRect(roiX, roiY, roiW, roiH);

  const slotW = roiW / (numBands * 2 + 1);
  const sampW = Math.max(MIN_SAMPLE_PX, Math.floor(slotW * SAMPLE_WIDTH_FRACTION));
  const sampH = Math.floor(roiH * SAMPLE_HEIGHT_FRACTION);
  const sampY = roiY + Math.floor(roiH * (1 - SAMPLE_HEIGHT_FRACTION) / 2);

  ctx.fillStyle = "rgba(245,166,35,0.25)";
  for (let i = 0; i < numBands; i++) {
    const slotCentre = roiX + slotW * (i * 2 + 1.5);
    const sampX = Math.floor(slotCentre - sampW / 2);
    ctx.fillRect(sampX, sampY, sampW, sampH);
  }
}
