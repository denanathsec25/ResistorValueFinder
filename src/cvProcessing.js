// ─────────────────────────────────────────────────────────────────────────────
// cvProcessing.js
// Browser-native image processing using the Canvas 2D API.
//
// Strategy (no OpenCV.js dependency required):
//   1. Draw the live video frame onto a hidden canvas.
//   2. Read the pixel buffer with getImageData().
//   3. Define a Region of Interest (ROI) matching the on-screen target box
//      (center 70% wide × 40% tall of the frame).
//   4. Divide the ROI into N equal windows — one per colour band.
//   5. Average the RGB values in each window → representative band colour.
//   6. Match to the nearest standard resistor colour.
//
// Why not OpenCV.js?
//   The WASM binary is ~8 MB and takes 2-3 s to initialise on mobile.
//   For a fixed, small colour palette, averaging pixel blocks is faster,
//   simpler, and just as accurate under consistent lighting.
// ─────────────────────────────────────────────────────────────────────────────

import { matchColor } from "./resistorLogic";

// ── ROI constants (fraction of frame dimensions) ──────────────────────────────
const ROI_X      = 0.15;  // left edge of target box
const ROI_WIDTH  = 0.70;  // width of target box
const ROI_Y      = 0.30;  // top edge of target box
const ROI_HEIGHT = 0.40;  // height of target box

// Within each band window, sample the central 60% width × 80% height.
// This avoids noisy edges between bands.
const SAMPLE_WIDTH_FRACTION  = 0.60;
const SAMPLE_HEIGHT_FRACTION = 0.80;
const MIN_SAMPLE_PX          = 4;    // never sample fewer than 4 px wide

// ── Preprocessing ─────────────────────────────────────────────────────────────

/**
 * Apply a very light 3×3 box blur to reduce sensor noise before sampling.
 * Operates in-place on an ImageData buffer.
 *
 * @param {ImageData} imageData
 * @param {number}    width   – canvas pixel width
 * @param {number}    height  – canvas pixel height
 * @param {number}    x0      – ROI left
 * @param {number}    y0      – ROI top
 * @param {number}    w       – ROI width
 * @param {number}    h       – ROI height
 */
function blurRoi(imageData, width, height, x0, y0, w, h) {
  const d    = imageData.data;
  const copy = new Uint8ClampedArray(d); // work from a clean copy

  for (let y = y0 + 1; y < y0 + h - 1; y++) {
    for (let x = x0 + 1; x < x0 + w - 1; x++) {
      for (let c = 0; c < 3; c++) {          // R, G, B only (skip A)
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += copy[((y + dy) * width + (x + dx)) * 4 + c];
          }
        }
        d[(y * width + x) * 4 + c] = Math.round(sum / 9);
      }
    }
  }
}

// ── Band sampling ─────────────────────────────────────────────────────────────

/**
 * Average the RGB values of a rectangular block in the pixel buffer.
 *
 * @param {Uint8ClampedArray} data   – ImageData.data
 * @param {number} x                 – block left (pixels)
 * @param {number} y                 – block top  (pixels)
 * @param {number} w                 – block width
 * @param {number} h                 – block height
 * @param {number} imgWidth          – full canvas width (for stride calc)
 * @returns {[number, number, number]} [r, g, b]
 */
function averageBlock(data, x, y, w, h, imgWidth) {
  let rSum = 0, gSum = 0, bSum = 0, count = 0;

  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const idx = ((y + dy) * imgWidth + (x + dx)) * 4;
      rSum += data[idx];
      gSum += data[idx + 1];
      bSum += data[idx + 2];
      count++;
    }
  }

  return [
    Math.round(rSum / count),
    Math.round(gSum / count),
    Math.round(bSum / count),
  ];
}

// ── Main export ───────────────────────────────────────────────────────────────

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
  // ── 1. Read pixel data ────────────────────────────────────────────────────
  const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);

  // ── 2. Calculate ROI in pixels ────────────────────────────────────────────
  const roiX = Math.floor(canvasWidth  * ROI_X);
  const roiW = Math.floor(canvasWidth  * ROI_WIDTH);
  const roiY = Math.floor(canvasHeight * ROI_Y);
  const roiH = Math.floor(canvasHeight * ROI_HEIGHT);

  // ── 3. Light blur inside the ROI to reduce noise ──────────────────────────
  blurRoi(imageData, canvasWidth, canvasHeight, roiX, roiY, roiW, roiH);

  // ── 4. Divide ROI into band windows ───────────────────────────────────────
  //
  // The resistor body is modelled as alternating gaps and bands:
  //   gap | band | gap | band | gap | … | gap
  //
  // We use 2N+1 slots so bands land on odd indices.
  const slotW  = roiW / (numBands * 2 + 1);
  const sampW  = Math.max(MIN_SAMPLE_PX, Math.floor(slotW * SAMPLE_WIDTH_FRACTION));
  const sampH  = Math.floor(roiH * SAMPLE_HEIGHT_FRACTION);
  const sampY  = roiY + Math.floor(roiH * (1 - SAMPLE_HEIGHT_FRACTION) / 2);

  // ── 5. Sample each band ───────────────────────────────────────────────────
  const results = [];

  for (let i = 0; i < numBands; i++) {
    // Centre of the (i)-th band slot (odd slot index = 1, 3, 5, …)
    const slotCentre = roiX + slotW * (i * 2 + 1.5);
    const sampX      = Math.floor(slotCentre - sampW / 2);

    const [r, g, b] = averageBlock(
      imageData.data,
      sampX, sampY,
      sampW, sampH,
      canvasWidth
    );

    const band = matchColor(r, g, b);

    results.push({
      band,
      r, g, b,
      hex: `rgb(${r},${g},${b})`,   // actual sampled colour for the swatch UI
    });
  }

  return results;
}

// ── Debug helper (optional, call from DevTools) ───────────────────────────────

/**
 * Draw the sampling regions onto the canvas for visual debugging.
 * Call this instead of (or after) extractBands() during development.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {4 | 5} numBands
 */
export function debugDrawSamplingRegions(ctx, canvasWidth, canvasHeight, numBands) {
  const roiX = Math.floor(canvasWidth  * ROI_X);
  const roiW = Math.floor(canvasWidth  * ROI_WIDTH);
  const roiY = Math.floor(canvasHeight * ROI_Y);
  const roiH = Math.floor(canvasHeight * ROI_HEIGHT);

  // Draw ROI outline
  ctx.strokeStyle = "rgba(245,166,35,0.8)";
  ctx.lineWidth   = 2;
  ctx.strokeRect(roiX, roiY, roiW, roiH);

  const slotW = roiW / (numBands * 2 + 1);
  const sampW = Math.max(MIN_SAMPLE_PX, Math.floor(slotW * SAMPLE_WIDTH_FRACTION));
  const sampH = Math.floor(roiH * SAMPLE_HEIGHT_FRACTION);
  const sampY = roiY + Math.floor(roiH * (1 - SAMPLE_HEIGHT_FRACTION) / 2);

  ctx.fillStyle = "rgba(245,166,35,0.25)";
  for (let i = 0; i < numBands; i++) {
    const slotCentre = roiX + slotW * (i * 2 + 1.5);
    const sampX      = Math.floor(slotCentre - sampW / 2);
    ctx.fillRect(sampX, sampY, sampW, sampH);
  }
}
