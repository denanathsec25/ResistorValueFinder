// ─────────────────────────────────────────────────────────────────────────────
// cvProcessing.js
// Browser-native image processing using the Canvas 2D API.
//
// v2 CHANGES (fixes color misclassification under glare/glossy resistors):
//   1. ROBUST SAMPLING — median instead of mean per band window, with
//      explicit rejection of specular-highlight pixels (blown-out glare)
//      and near-black shadow pixels before computing the median. A single
//      bright glint pixel can no longer drag an entire Yellow band toward
//      "White."
//   2. TEMPORAL VOTING — `burstCaptureAndClassify()` samples several frames
//      in quick succession and takes a per-band majority vote. This smooths
//      out motion blur, autofocus hunting, and momentary glare from a single
//      unlucky frame.
// ─────────────────────────────────────────────────────────────────────────────

import { matchColor } from "./resistorLogic";

// ── ROI constants (fraction of frame dimensions) ──────────────────────────────
const ROI_X      = 0.15;
const ROI_WIDTH  = 0.70;
const ROI_Y      = 0.30;
const ROI_HEIGHT = 0.40;

const SAMPLE_WIDTH_FRACTION  = 0.60;
const SAMPLE_HEIGHT_FRACTION = 0.80;
const MIN_SAMPLE_PX          = 4;

// Glare / shadow rejection thresholds (0-1 normalized).
// A pixel is rejected as "specular glare" if it's both very bright AND
// nearly colorless (the classic look of a reflected light source on a
// glossy resistor coating).
const GLARE_VALUE_MIN  = 0.92;
const GLARE_SAT_MAX    = 0.12;
// A pixel is rejected as "shadow/background" if it's almost black —
// these usually come from the gap between bands, not the bands themselves.
const SHADOW_VALUE_MAX = 0.04;

// ── Robust statistics helpers ──────────────────────────────────────────────────

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Sample a rectangular pixel block, rejecting glare/shadow outliers first,
 * then return the per-channel MEDIAN (robust to the outliers a simple mean
 * would still be skewed by).
 *
 * @param {Uint8ClampedArray} data    – ImageData.data
 * @param {number} x, y, w, h         – block in pixel coords
 * @param {number} imgWidth           – full canvas width (stride)
 * @returns {[number, number, number]} [r, g, b]
 */
function robustSampleBlock(data, x, y, w, h, imgWidth) {
  const rs = [], gs = [], bs = [];

  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const idx = ((y + dy) * imgWidth + (x + dx)) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];

      const max = Math.max(r, g, b) / 255;
      const min = Math.min(r, g, b) / 255;
      const v = max;
      const s = max === 0 ? 0 : (max - min) / max;

      if (v > GLARE_VALUE_MIN && s < GLARE_SAT_MAX) continue; // glare
      if (v < SHADOW_VALUE_MAX) continue;                      // shadow

      rs.push(r); gs.push(g); bs.push(b);
    }
  }

  // Fallback: if filtering rejected every pixel (e.g. the whole window is
  // blown out), redo without filtering rather than returning garbage.
  if (rs.length === 0) {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const idx = ((y + dy) * imgWidth + (x + dx)) * 4;
        rs.push(data[idx]); gs.push(data[idx + 1]); bs.push(data[idx + 2]);
      }
    }
  }

  return [median(rs), median(gs), median(bs)];
}

// ── Single-frame band extraction ───────────────────────────────────────────────

/**
 * Extract colour-band information from the current canvas frame.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {4 | 5} numBands
 * @returns {Array<{ band: object, r: number, g: number, b: number, hex: string }>}
 */
export function extractBands(ctx, canvasWidth, canvasHeight, numBands) {
  const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);

  const roiX = Math.floor(canvasWidth * ROI_X);
  const roiW = Math.floor(canvasWidth * ROI_WIDTH);
  const roiY = Math.floor(canvasHeight * ROI_Y);
  const roiH = Math.floor(canvasHeight * ROI_HEIGHT);

  const slotW = roiW / (numBands * 2 + 1);
  const sampW = Math.max(MIN_SAMPLE_PX, Math.floor(slotW * SAMPLE_WIDTH_FRACTION));
  const sampH = Math.floor(roiH * SAMPLE_HEIGHT_FRACTION);
  const sampY = roiY + Math.floor(roiH * (1 - SAMPLE_HEIGHT_FRACTION) / 2);

  const results = [];

  for (let i = 0; i < numBands; i++) {
    const slotCentre = roiX + slotW * (i * 2 + 1.5);
    const sampX = Math.floor(slotCentre - sampW / 2);

    const [r, g, b] = robustSampleBlock(
      imageData.data, sampX, sampY, sampW, sampH, canvasWidth
    );

    const band = matchColor(r, g, b);
    results.push({ band, r, g, b, hex: `rgb(${r},${g},${b})` });
  }

  return results;
}

// ── Temporal voting (burst capture) ─────────────────────────────────────────────

/**
 * Take a quick burst of frames from the live video and run extractBands()
 * on each, then return the per-band MAJORITY VOTE rather than trusting any
 * single frame. This is what stops results from "wildly fluctuating" —
 * a momentary glare flash or motion-blur frame gets outvoted by the other
 * 7-11 samples in the burst.
 *
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} canvas       – scratch canvas, reused each frame
 * @param {4 | 5} numBands
 * @param {object} [opts]
 * @param {number} [opts.frameCount=10]    – frames to sample
 * @param {number} [opts.intervalMs=40]    – delay between frames (ms)
 * @returns {Promise<Array<{ band, r, g, b, hex, confidence }>>}
 */
export async function burstCaptureAndClassify(
  video,
  canvas,
  numBands,
  { frameCount = 10, intervalMs = 40 } = {}
) {
  const ctx = canvas.getContext("2d");

  // perBand[i] accumulates every frame's reading for band slot i
  const perBand = Array.from({ length: numBands }, () => []);

  for (let f = 0; f < frameCount; f++) {
    canvas.width = video.videoWidth || 320;
    canvas.height = video.videoHeight || 180;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const frameBands = extractBands(ctx, canvas.width, canvas.height, numBands);
    frameBands.forEach((sample, i) => perBand[i].push(sample));

    if (f < frameCount - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  // Majority vote per band slot
  return perBand.map((samples) => majorityVote(samples));
}

/**
 * Given N classified samples for ONE band slot, return the most frequently
 * detected color, the averaged RGB of just the winning samples (for a clean
 * swatch), and a confidence score (winning count / total).
 *
 * @param {Array<{band, r, g, b, hex}>} samples
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
 * Draw the sampling regions onto the canvas for visual debugging.
 */
export function debugDrawSamplingRegions(ctx, canvasWidth, canvasHeight, numBands) {
  const roiX = Math.floor(canvasWidth * ROI_X);
  const roiW = Math.floor(canvasWidth * ROI_WIDTH);
  const roiY = Math.floor(canvasHeight * ROI_Y);
  const roiH = Math.floor(canvasHeight * ROI_HEIGHT);

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
