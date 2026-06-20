// components/BandsDisplay.jsx
// Grid of colour swatches with band names, digit values, and a confidence
// bar (from the burst-vote in cvProcessing.js) so low-confidence reads are
// visually obvious — a dim/short bar means the burst frames disagreed a lot,
// usually due to glare, motion, or poor alignment.

export default function BandsDisplay({ bands }) {
  return (
    <div className="bands-display">
      {bands.map((b, i) => (
        <div className="band-chip" key={i}>
          <div className="band-swatch" style={{ background: b.hex }} />
          <span className="band-name">{b.band.name}</span>
          <span className="band-label">Band {i + 1}</span>
          {b.confidence != null && (
            <div className="confidence-bar-track" title={`${Math.round(b.confidence * 100)}% confidence`}>
              <div
                className="confidence-bar-fill"
                style={{
                  width: `${Math.round(b.confidence * 100)}%`,
                  background: b.confidence > 0.7 ? "var(--green)" : b.confidence > 0.4 ? "var(--amber)" : "var(--red)",
                }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
