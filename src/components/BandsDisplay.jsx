// components/BandsDisplay.jsx
// Grid of colour swatches with band names and digit values.

export default function BandsDisplay({ bands }) {
  return (
    <div className="bands-display">
      {bands.map((b, i) => (
        <div className="band-chip" key={i}>
          <div className="band-swatch" style={{ background: b.hex }} />
          <span className="band-name">{b.band.name}</span>
          <span className="band-label">Band {i + 1}</span>
        </div>
      ))}
    </div>
  );
}
