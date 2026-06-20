// components/ColorReference.jsx
// Quick-reference grid for the standard resistor colour code.

import { COLOR_BANDS } from "../resistorLogic";

export default function ColorReference() {
  const displayBands = COLOR_BANDS.filter((c) => c.name !== "None");

  return (
    <div className="color-ref">
      {displayBands.map((c) => (
        <div className="ref-item" key={c.name}>
          <div className="ref-dot" style={{ background: c.hex }} />
          <div className="ref-info">
            <p className="ref-name">{c.name}</p>
            <p className="ref-num">
              {c.digit !== null ? c.digit : "—"}
              {c.tol ? ` ±${c.tol}%` : ""}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
