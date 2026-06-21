// ─────────────────────────────────────────────────────────────────────────────
// videoGeometry.js
//
// THE BUG THIS FIXES:
// .camera-wrap uses CSS `object-fit: cover` so the camera feed fills its box
// without stretching. That means the browser visually CROPS part of the
// native video frame — the user only ever sees, and aligns the resistor
// within, that cropped window.
//
// But extractBands() in cvProcessing.js was sampling ROI percentages against
// the FULL native video resolution (video.videoWidth / video.videoHeight),
// not the cropped window actually shown on screen. If the camera's native
// aspect ratio doesn't match the CSS box's aspect ratio (extremely common —
// most phone cameras stream 16:9 or portrait 9:16, while the box is forced
// to 4:3), the sampled pixels land OUTSIDE the resistor — on background,
// table, or wall — consistently, every frame. That produces exactly the
// symptom reported: 100% confidence, every band reads "White", because the
// algorithm is reliably sampling the same wrong (bright) region every time.
//
// getVisibleCropRect() computes the same crop math the browser performs for
// `object-fit: cover`, so the pixel-sampling ROI can be aligned to match
// what the user actually sees in the amber target box.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the visible (cropped) rectangle of a video element when displayed
 * with CSS `object-fit: cover` inside a container, expressed in the video's
 * own native pixel coordinates.
 *
 * @param {HTMLVideoElement} video      – must have a loaded stream (videoWidth/Height > 0)
 * @param {HTMLElement} container       – the element with `object-fit: cover` styling applied to the video
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 *          Native-pixel crop rect, or null if the video isn't ready yet.
 */
export function getVisibleCropRect(video, container) {
  const videoW = video.videoWidth;
  const videoH = video.videoHeight;
  if (!videoW || !videoH) return null;

  const rect = container.getBoundingClientRect();
  const containerW = rect.width;
  const containerH = rect.height;
  if (!containerW || !containerH) return null;

  const videoRatio = videoW / videoH;
  const containerRatio = containerW / containerH;

  let cropX, cropY, cropW, cropH;

  if (videoRatio > containerRatio) {
    // Video is relatively WIDER than the container → browser crops left/right,
    // keeps full height.
    cropH = videoH;
    cropW = videoH * containerRatio;
    cropX = (videoW - cropW) / 2;
    cropY = 0;
  } else {
    // Video is relatively TALLER than the container → browser crops top/bottom,
    // keeps full width. This is the common case for portrait phone cameras
    // inside a landscape-ish 4:3 box.
    cropW = videoW;
    cropH = videoW / containerRatio;
    cropX = 0;
    cropY = (videoH - cropH) / 2;
  }

  return { x: cropX, y: cropY, width: cropW, height: cropH };
}
