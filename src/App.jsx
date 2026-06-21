import { useState, useRef, useEffect, useCallback } from "react";
import { calcResistance, formatOhms } from "./resistorLogic";
import { burstCaptureAndClassify, CaptureQualityError } from "./cvProcessing";
import ResistorVisual from "./components/ResistorVisual";
import BandsDisplay from "./components/BandsDisplay";
import ColorReference from "./components/ColorReference";
import "./index.css";

export default function App() {
  const videoRef = useRef(null);
  const procCanvasRef = useRef(null);
  const cameraWrapRef = useRef(null); // .camera-wrap element — needed for object-fit:cover geometry correction

  const [mode, setMode] = useState("camera"); // "camera" | "ref"
  const [numBands, setNumBands] = useState(4);
  const [streaming, setStreaming] = useState(false);
  const [capturing, setCapturing] = useState(false); // brief flash while processing
  const [status, setStatus] = useState("Idle — press Start");
  const [bands, setBands] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [captureWarning, setCaptureWarning] = useState(null);
  const [facingMode, setFacingMode] = useState("environment");

  // ── Burst capture & majority-vote analyze ───────────────────────────────────
  const handleCapture = useCallback(async () => {
    const video = videoRef.current;
    const canvas = procCanvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    setCapturing(true);
    setCaptureWarning(null);
    setStatus("Capturing burst…");

    try {
      // Samples ~10 frames over ~400ms, geometry-corrected against the
      // actual visible camera window, white-balanced, and majority-voted —
      // this is what stops single-frame glare/motion-blur/sampling-offset
      // from producing wildly wrong reads.
      const votedBands = await burstCaptureAndClassify(video, canvas, numBands, {
        frameCount: 10,
        intervalMs: 40,
        container: cameraWrapRef.current,
      });
      const res = calcResistance(votedBands, numBands);
      setBands(votedBands);
      setResult(res);

      const avgConfidence =
        votedBands.reduce((sum, b) => sum + b.confidence, 0) / votedBands.length;
      const confidencePct = Math.round(avgConfidence * 100);
      const hasUnreadable = votedBands.some((b) => b.band.name === "Unreadable");

      if (hasUnreadable) {
        setCaptureWarning(
          "One or more bands couldn't be read reliably (too much glare on that section). Try tilting the resistor slightly or softening the light."
        );
      }

      setStatus(
        res
          ? `Capture complete — ${confidencePct}% confidence`
          : `Capture complete — check alignment (${confidencePct}% confidence)`
      );
    } catch (e) {
      if (e instanceof CaptureQualityError && e.reason === "overexposed") {
        setCaptureWarning(
          "Too much glare — the camera is overexposed and can't read true colors right now. Try: moving away from direct light, angling the resistor away from reflections, or turning off camera flash/torch."
        );
        setStatus("Capture failed — overexposed");
      } else {
        console.warn("Capture processing error:", e);
        setStatus("Error processing frame — try again");
      }
    } finally {
      setCapturing(false);
    }
  }, [numBands]);

  const startCamera = useCallback(async () => {
    setError(null);
    setCaptureWarning(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      });

      // Defensive: make sure torch/flash isn't on — some mobile browsers
      // have enabled it unexpectedly in the past, and a torch pointed at a
      // glossy resistor is a near-guaranteed overexposure source.
      const track = stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.();
      if (capabilities?.torch) {
        try {
          await track.applyConstraints({ advanced: [{ torch: false }] });
        } catch {
          // Not all devices allow this — safe to ignore.
        }
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setStreaming(true);
        setStatus("Camera active — align resistor and press Capture");
      }
    } catch (e) {
      setError("Camera access denied or unavailable. Check browser permissions.");
      setStatus("Error");
    }
  }, [facingMode]);

  const stopCamera = useCallback(() => {
    if (videoRef.current?.srcObject) {
      videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
      videoRef.current.srcObject = null;
    }
    setStreaming(false);
    setCapturing(false);
    setCaptureWarning(null);
    setBands(null);
    setResult(null);
    setStatus("Idle — press Start");
  }, []);

  // Cleanup on unmount
  useEffect(() => () => stopCamera(), []);

  const flipCamera = () => {
    stopCamera();
    setFacingMode((f) => (f === "environment" ? "user" : "environment"));
  };

  const [ohmsVal, ohmsUnit] = formatOhms(result?.value);

  return (
    <div className="app">
      {/* Hidden processing canvas */}
      <canvas ref={procCanvasRef} className="proc-canvas" />

      {/* Header */}
      <header className="header">
        <div className="logo">Ω</div>
        <div>
          <div className="title">ResiBand</div>
          <div className="subtitle">Color Band Decoder</div>
        </div>
      </header>

      <main className="main">
        {/* Mode tabs */}
        <div className="mode-toggle">
          <button
            className={`mode-btn ${mode === "camera" ? "active" : ""}`}
            onClick={() => setMode("camera")}
          >
            Camera
          </button>
          <button
            className={`mode-btn ${mode === "ref" ? "active" : ""}`}
            onClick={() => setMode("ref")}
          >
            Color Ref
          </button>
        </div>

        {/* ── Camera Mode ─────────────────────────────────────────────────── */}
        {mode === "camera" && (
          <>
            {/* Camera viewfinder */}
            <div className="camera-wrap" ref={cameraWrapRef}>
              <video ref={videoRef} playsInline muted className="video" />

              {streaming && (
                <div className="overlay">
                  <div className="target-box">
                    <span className="corner tl" />
                    <span className="corner tr" />
                    <span className="corner bl" />
                    <span className="corner br" />
                    {capturing && <div className="scan-line" />}
                  </div>
                  <p className="hint-text">Align resistor within box</p>
                </div>
              )}

              {capturing && <div className="flash-overlay" />}

              {!streaming && (
                <div className="camera-placeholder">
                  <span className="camera-icon">📷</span>
                  <p>Press Start to activate camera</p>
                </div>
              )}
            </div>

            {/* Status bar */}
            <div className="status-bar">
              <span
                className={`dot ${
                  capturing ? "analyzing" : streaming ? "active" : "idle"
                }`}
              />
              <span>{status}</span>
              {streaming && (
                <button className="flip-btn" onClick={flipCamera}>
                  ⟳ Flip
                </button>
              )}
            </div>

            {error && <p className="error-msg">{error}</p>}
            {captureWarning && <p className="warning-msg">⚠️ {captureWarning}</p>}

            {/* Band count selector */}
            <div className="band-selector">
              <button
                className={`seg-btn ${numBands === 4 ? "active" : ""}`}
                onClick={() => setNumBands(4)}
              >
                4-Band
              </button>
              <button
                className={`seg-btn ${numBands === 5 ? "active" : ""}`}
                onClick={() => setNumBands(5)}
              >
                5-Band
              </button>
            </div>

            {/* Controls */}
            <div className="btn-row">
              {!streaming ? (
                <button className="btn primary" onClick={startCamera}>
                  ▶ Start Camera
                </button>
              ) : (
                <>
                  <button className="btn danger" onClick={stopCamera}>
                    ■ Stop
                  </button>
                  <button
                    className="btn primary capture-btn"
                    onClick={handleCapture}
                    disabled={capturing}
                  >
                    {capturing ? "● Capturing…" : "📸 Capture"}
                  </button>
                </>
              )}
            </div>
          </>
        )}

        {/* ── Color Reference Mode ─────────────────────────────────────────── */}
        {mode === "ref" && (
          <div className="result-card">
            <p className="card-label">Standard Color Codes</p>
            <ColorReference />
          </div>
        )}

        {/* ── Results ─────────────────────────────────────────────────────── */}
        {bands && mode === "camera" && (
          <div className="results scan-result-anim">
            {/* Detected bands */}
            <div className="result-card">
              <p className="card-label">Detected Bands</p>
              <ResistorVisual bands={bands} />
              <BandsDisplay bands={bands} />
            </div>

            {/* Calculated value */}
            <div className="result-card">
              <p className="card-label">Calculated Value</p>
              <div className="ohms-display">
                <div className="ohms-val">{ohmsVal}</div>
                <div className="ohms-unit">{ohmsUnit} (Ohms)</div>
              </div>

              {result && (
                <div className="tol-row">
                  <div className="tol-box">
                    <p className="tol-label">Tolerance</p>
                    <p className="tol-val amber">±{result.tol}%</p>
                  </div>
                  <div className="tol-box">
                    <p className="tol-label">Min</p>
                    <p className="tol-val small">
                      {formatOhms(result.min).join("")}
                    </p>
                  </div>
                  <div className="tol-box">
                    <p className="tol-label">Max</p>
                    <p className="tol-val small">
                      {formatOhms(result.max).join("")}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
