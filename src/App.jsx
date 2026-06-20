import { useState, useRef, useEffect, useCallback } from "react";
import { COLOR_BANDS, matchColor, calcResistance, formatOhms } from "./resistorLogic";
import { extractBands } from "./cvProcessing";
import ResistorVisual from "./components/ResistorVisual";
import BandsDisplay from "./components/BandsDisplay";
import ColorReference from "./components/ColorReference";
import "./index.css";

export default function App() {
  const videoRef = useRef(null);
  const procCanvasRef = useRef(null);
  const rafRef = useRef(null);

  const [mode, setMode] = useState("camera"); // "camera" | "ref"
  const [numBands, setNumBands] = useState(4);
  const [streaming, setStreaming] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [status, setStatus] = useState("Idle — press Start");
  const [bands, setBands] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [facingMode, setFacingMode] = useState("environment");

  // ── Core frame-processing loop ──────────────────────────────────────────────
  const processFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = procCanvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    const ctx = canvas.getContext("2d");
    canvas.width = video.videoWidth || 320;
    canvas.height = video.videoHeight || 180;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    try {
      const detectedBands = extractBands(ctx, canvas.width, canvas.height, numBands);
      const res = calcResistance(detectedBands, numBands);
      setBands(detectedBands);
      setResult(res);
    } catch (e) {
      console.warn("Frame processing error:", e);
    }
  }, [numBands]);

  const startAnalysis = useCallback(() => {
    setAnalyzing(true);
    setStatus("Analyzing…");
    const loop = () => {
      processFrame();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [processFrame]);

  const stopAnalysis = useCallback(() => {
    setAnalyzing(false);
    setStatus("Paused");
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const startCamera = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setStreaming(true);
        setStatus("Camera active — press Analyze");
      }
    } catch (e) {
      setError("Camera access denied or unavailable. Check browser permissions.");
      setStatus("Error");
    }
  }, [facingMode]);

  const stopCamera = useCallback(() => {
    stopAnalysis();
    if (videoRef.current?.srcObject) {
      videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
      videoRef.current.srcObject = null;
    }
    setStreaming(false);
    setBands(null);
    setResult(null);
    setStatus("Idle — press Start");
  }, [stopAnalysis]);

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
            <div className="camera-wrap">
              <video ref={videoRef} playsInline muted className="video" />

              {streaming && (
                <div className="overlay">
                  <div className="target-box">
                    <span className="corner tl" />
                    <span className="corner tr" />
                    <span className="corner bl" />
                    <span className="corner br" />
                    {analyzing && <div className="scan-line" />}
                  </div>
                  <p className="hint-text">Align resistor within box</p>
                </div>
              )}

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
                  analyzing ? "analyzing" : streaming ? "active" : "idle"
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
                <button className="btn danger" onClick={stopCamera}>
                  ■ Stop
                </button>
              )}
              {streaming && (
                !analyzing ? (
                  <button className="btn primary" onClick={startAnalysis}>
                    ⟳ Analyze
                  </button>
                ) : (
                  <button className="btn secondary" onClick={stopAnalysis}>
                    ⏸ Pause
                  </button>
                )
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
