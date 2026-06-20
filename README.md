# ResiBand — Resistor Color Band Decoder

Real-time resistor colour band decoder using your device's camera. No native apps, no
heavy libraries — pure React + Canvas 2D API, runs at 30 fps on mid-range mobile.

## Quick start

```bash
npm install
npm run dev
```

Then open `http://localhost:5173` in your browser (or scan the QR code / LAN URL for mobile).

> **Mobile testing tip:** Vite exposes the dev server on your LAN (`host: true` in vite.config.js).
> Open the LAN address on your phone while on the same Wi-Fi network.

## Project structure

```
src/
├── main.jsx              # React entry point
├── App.jsx               # Root component — camera control, state, layout
├── index.css             # Global styles (dark industrial theme)
├── resistorLogic.js      # Pure functions: colour table, matching, math, formatting
├── cvProcessing.js       # Canvas 2D image processing (band sampling)
└── components/
    ├── ResistorVisual.jsx # Schematic illustration of resistor body
    ├── BandsDisplay.jsx   # Colour swatches + band name chips
    └── ColorReference.jsx # Quick-reference colour-code grid
```

## How it works

### Camera layer
`MediaDevices.getUserMedia()` streams video into a `<video>` element.
A `requestAnimationFrame` loop copies each frame to a hidden `<canvas>`.

### Image processing (`cvProcessing.js`)
1. `getImageData()` reads raw RGBA pixels from the canvas.
2. A lightweight 3×3 box blur smooths sensor noise inside the ROI.
3. The Region of Interest (centre 70% × 40% of the frame) is divided into
   `2N + 1` slots — gaps between odd slots, bands on odd slots.
4. Each band slot is averaged to a single [R, G, B] triple.

### Colour matching (`resistorLogic.js → matchColor`)
Euclidean distance in RGB space against the 12 standard resistor colours.
Fast for a fixed palette; no HSV conversion needed.

### Resistance calculation (`resistorLogic.js → calcResistance`)
| Scheme | Formula |
|--------|---------|
| 4-band | `(d1×10 + d2) × multiplier` |
| 5-band | `(d1×100 + d2×10 + d3) × multiplier` |

Outputs value, tolerance %, min, and max.

## Build for production

```bash
npm run build
# outputs to dist/
```

Deploy `dist/` to any static host (Vercel, Netlify, GitHub Pages, etc.).
Camera access requires **HTTPS** in production — all major static hosts provide this.

## Extending

- **Better colour accuracy under variable lighting:** Apply histogram equalisation
  or convert to LAB colour space before matching. OpenCV.js can be dropped in as
  a WASM module if needed; replace `extractBands` in `cvProcessing.js`.
- **Edge detection:** Use Canny on the grayscale frame to auto-locate the resistor
  body and skip the manual "align in box" step.
- **PWA / offline:** Add a Vite PWA plugin and a service worker to cache assets.

## Author

**Denanath S**

Electronics and Communication Engineering (ECE)

Bannari Amman Institute of Technology

📧 Email: [denanathshanmugasundaram@gmail.com](mailto:denanathshanmugasundaram@gmail.com)

🔗 GitHub: https://github.com/denanathsec25

## Support

If you find this repository useful for learning Verilog, FPGA Design, or Digital Electronics:

⭐ Star the repository

🍴 Fork it for your own experiments

📢 Share it with fellow students and FPGA enthusiasts

Contributions, suggestions, and feedback are always welcome.
