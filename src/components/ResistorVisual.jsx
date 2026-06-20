// components/ResistorVisual.jsx
// Renders a schematic illustration of a resistor with coloured bands.

export default function ResistorVisual({ bands }) {
  return (
    <div className="resistor-visual">
      <div className="wire" />
      <div className="resistor-body">
        {bands.map((b, i) => (
          <div key={i} className="r-band" style={{ background: b.hex }} />
        ))}
      </div>
      <div className="wire" />
    </div>
  );
}
