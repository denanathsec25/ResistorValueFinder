// components/BandsDisplay.jsx
// Grid of colour swatches with band names, digit values, and a confidence
// bar (from the burst-vote in cvProcessing.js) so low-confidence reads are
// visually obvious — a dim/short bar means the burst frames disagreed a lot,
// usually due to glare, motion, or poor alignment.

export default function BandsDisplay({ bands }) {
  return (
    <div className="bands-display">
      {bands.map((b, i) => {
        const unreadable = b.band.name === "Unreadable";
        return (
          <div className="band-chip" key={i}>
            <div
              className={`band-swatch ${unreadable ? "unreadable" : ""}`}
              style={{ background: b.hex }}
            >
              {unreadable && <span className="unreadable-mark">?</span>}
            </div>
            <span className={`band-name ${unreadable ? "muted-italic" : ""}`}>
              {b.band.name}
            </span>
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
        );
      })}
    </div>
  );
}
