"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  calibrate,
  calibrationStatus,
  convexHull,
  pointInPolygon,
  measureLength,
  MIN_SCALE_LINES,
  type CalibrationResult,
  type ScaleLine as ScaleLineT,
  type Point,
} from "@/lib/homography";

type Mode = "idle" | "scale" | "measure";

type ScaleLine = { id: number; a: Point; b: Point; length: number };
type Measurement = { id: number; a: Point; b: Point };

type DragRef =
  | { type: "scale"; id: number; end: "a" | "b" }
  | { type: "measure"; id: number; end: "a" | "b" }
  | { type: "pending"; index: number };

const HANDLE_HIT_RADIUS = 10;
const SCALE_COLOR = "#46c66a";
const MEAS_COLOR = "#ff8a3d";
const WARN_COLOR = "#ffcf4d";

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [hasImage, setHasImage] = useState(false);
  const [mode, setMode] = useState<Mode>("idle");

  const viewRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 });

  const [scaleLines, setScaleLines] = useState<ScaleLine[]>([]);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [pending, setPending] = useState<Point[]>([]);
  const [pendingLen, setPendingLen] = useState<string>("");

  const [calib, setCalib] = useState<CalibrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cursorRef = useRef<{
    img: Point;
    screen: Point;
    snap?: Point | null;
  } | null>(null);
  const idRef = useRef(1);

  const stateRef = useRef({ mode, scaleLines, measurements, pending, hasImage });
  useEffect(() => {
    stateRef.current = { mode, scaleLines, measurements, pending, hasImage };
  }, [mode, scaleLines, measurements, pending, hasImage]);

  // ---- Image loading -------------------------------------------------------

  const fitImage = useCallback(() => {
    const wrap = wrapRef.current;
    const img = imgRef.current;
    if (!wrap || !img) return;
    const cw = wrap.clientWidth;
    const ch = wrap.clientHeight;
    const scale = Math.min(cw / img.width, ch / img.height) * 0.92;
    viewRef.current = {
      scale,
      offsetX: (cw - img.width * scale) / 2,
      offsetY: (ch - img.height * scale) / 2,
    };
  }, []);

  const loadImageFromBlob = useCallback(
    (blob: Blob) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        imgRef.current = img;
        setHasImage(true);
        setError(null);
        setScaleLines([]);
        setMeasurements([]);
        setPending([]);
        setPendingLen("");
        setCalib(null);
        setMode("scale");
        fitImage();
        URL.revokeObjectURL(url);
      };
      img.onerror = () => setError("Could not load the image.");
      img.src = url;
    },
    [fitImage]
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith("image/")) {
          const blob = it.getAsFile();
          if (blob) {
            loadImageFromBlob(blob);
            e.preventDefault();
          }
          return;
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [loadImageFromBlob]);

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) loadImageFromBlob(f);
    e.target.value = "";
  };

  // ---- Coordinate helpers --------------------------------------------------

  const screenToImage = (sx: number, sy: number): Point => {
    const v = viewRef.current;
    return { x: (sx - v.offsetX) / v.scale, y: (sy - v.offsetY) / v.scale };
  };
  const imageToScreen = (p: Point): Point => {
    const v = viewRef.current;
    return { x: p.x * v.scale + v.offsetX, y: p.y * v.scale + v.offsetY };
  };

  // ---- Calibration recompute ----------------------------------------------

  useEffect(() => {
    const sl: ScaleLineT[] = scaleLines.map((l) => ({
      a: l.a,
      b: l.b,
      length: l.length,
    }));
    if (!calibrationStatus(sl).ready) {
      setCalib(null);
      return;
    }
    const result = calibrate(sl);
    if (!result) {
      setCalib(null);
      setError(
        "Calibration failed. Use known-length lines in more varied directions (avoid all-parallel)."
      );
    } else {
      setError(null);
      setCalib(result);
    }
  }, [scaleLines]);

  // ---- Hit testing & dragging ----------------------------------------------

  const hitTestHandle = (screen: Point): DragRef | null => {
    const { scaleLines, measurements, pending } = stateRef.current;
    const r2 = HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS;
    const near = (p: Point) => {
      const s = imageToScreen(p);
      const dx = s.x - screen.x;
      const dy = s.y - screen.y;
      return dx * dx + dy * dy <= r2;
    };
    for (let i = pending.length - 1; i >= 0; i--)
      if (near(pending[i])) return { type: "pending", index: i };
    for (let i = measurements.length - 1; i >= 0; i--) {
      if (near(measurements[i].b))
        return { type: "measure", id: measurements[i].id, end: "b" };
      if (near(measurements[i].a))
        return { type: "measure", id: measurements[i].id, end: "a" };
    }
    for (let i = scaleLines.length - 1; i >= 0; i--) {
      if (near(scaleLines[i].b))
        return { type: "scale", id: scaleLines[i].id, end: "b" };
      if (near(scaleLines[i].a))
        return { type: "scale", id: scaleLines[i].id, end: "a" };
    }
    return null;
  };

  const refToPoint = (ref: DragRef): Point | null => {
    const { scaleLines, measurements, pending } = stateRef.current;
    if (ref.type === "pending") return pending[ref.index] ?? null;
    if (ref.type === "scale") {
      const l = scaleLines.find((x) => x.id === ref.id);
      return l ? l[ref.end] : null;
    }
    const m = measurements.find((x) => x.id === ref.id);
    return m ? m[ref.end] : null;
  };

  const moveHandle = (ref: DragRef, img: Point) => {
    if (ref.type === "pending")
      setPending((prev) => prev.map((p, i) => (i === ref.index ? img : p)));
    else if (ref.type === "scale")
      setScaleLines((prev) =>
        prev.map((l) => (l.id === ref.id ? { ...l, [ref.end]: img } : l))
      );
    else
      setMeasurements((prev) =>
        prev.map((m) => (m.id === ref.id ? { ...m, [ref.end]: img } : m))
      );
  };

  // ---- Pointer interaction -------------------------------------------------

  const gestureRef = useRef<{
    decided: "none" | "pan" | "movehandle";
    handleHit: DragRef | null;
    startScreen: Point;
    startImg: Point;
    startOffset: { x: number; y: number };
    forcePan: boolean;
  } | null>(null);
  const spaceDown = useRef(false);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown.current = true;
      if (e.code === "Escape") {
        setPending([]);
        setPendingLen("");
        draw();
      }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown.current = false;
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getLocal = (e: React.PointerEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!stateRef.current.hasImage) return;
    const local = getLocal(e);
    (e.target as Element).setPointerCapture(e.pointerId);
    const forcePan = e.button === 1 || spaceDown.current;
    if (e.button !== 0 && e.button !== 1) return;
    const hit = forcePan ? null : hitTestHandle(local);
    const v = viewRef.current;
    gestureRef.current = {
      decided: "none",
      handleHit: hit,
      startScreen: local,
      startImg: screenToImage(local.x, local.y),
      startOffset: { x: v.offsetX, y: v.offsetY },
      forcePan,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!stateRef.current.hasImage) return;
    const local = getLocal(e);
    const img = screenToImage(local.x, local.y);
    const g = gestureRef.current;
    if (g) {
      const dx = local.x - g.startScreen.x;
      const dy = local.y - g.startScreen.y;
      if (g.decided === "none") {
        if (g.forcePan) g.decided = "pan";
        else if (dx * dx + dy * dy > 16)
          g.decided = g.handleHit ? "movehandle" : "pan";
      }
      if (g.decided === "movehandle" && g.handleHit) {
        moveHandle(g.handleHit, img);
        cursorRef.current = { img, screen: local, snap: null };
        draw();
        return;
      }
      if (g.decided === "pan") {
        viewRef.current.offsetX = g.startOffset.x + dx;
        viewRef.current.offsetY = g.startOffset.y + dy;
        cursorRef.current = null;
        draw();
        return;
      }
    }
    const hover = hitTestHandle(local);
    const snapPt = hover ? refToPoint(hover) : null;
    cursorRef.current = {
      img,
      screen: local,
      snap: snapPt ? imageToScreen(snapPt) : null,
    };
    draw();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {}
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g) return;
    if (g.decided === "none" && !g.forcePan) {
      const snapped = g.handleHit ? refToPoint(g.handleHit) : null;
      placePoint(snapped ?? g.startImg);
    }
  };

  const onPointerLeave = () => {
    cursorRef.current = null;
    draw();
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!hasImage) return;
    const local = getLocal(e as unknown as React.PointerEvent);
    const v = viewRef.current;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = Math.max(0.05, Math.min(60, v.scale * factor));
    const imgX = (local.x - v.offsetX) / v.scale;
    const imgY = (local.y - v.offsetY) / v.scale;
    v.scale = newScale;
    v.offsetX = local.x - imgX * newScale;
    v.offsetY = local.y - imgY * newScale;
    draw();
  };

  const placePoint = (p: Point) => {
    const m = stateRef.current.mode;
    if (m === "idle") return;
    if (m === "scale" && stateRef.current.pending.length >= 2) return;
    setPending((prev) => {
      const next = [...prev, p];
      if (next.length === 2 && m === "measure") {
        setMeasurements((arr) => [
          ...arr,
          { id: idRef.current++, a: next[0], b: next[1] },
        ]);
        return [];
      }
      return next;
    });
  };

  const confirmScaleLine = () => {
    const len = parseFloat(pendingLen);
    if (pending.length !== 2 || !(len > 0)) return;
    setScaleLines((prev) => [
      ...prev,
      { id: idRef.current++, a: pending[0], b: pending[1], length: len },
    ]);
    setPending([]);
    setPendingLen("");
  };

  const cancelPending = () => {
    setPending([]);
    setPendingLen("");
  };

  // ---- Rendering -----------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const img = imgRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = wrap.clientWidth;
    const ch = wrap.clientHeight;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
      canvas.style.width = cw + "px";
      canvas.style.height = ch + "px";
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!img) return;

    const v = viewRef.current;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      img,
      v.offsetX,
      v.offsetY,
      img.width * v.scale,
      img.height * v.scale
    );

    const hull =
      calib && scaleLines.length >= 3
        ? convexHull(scaleLines.flatMap((l) => [l.a, l.b]))
        : [];

    // Scale lines (green) with known length.
    scaleLines.forEach((l) => {
      const a = imageToScreen(l.a);
      const b = imageToScreen(l.b);
      drawSegment(ctx, a, b, SCALE_COLOR);
      drawHandle(ctx, a, SCALE_COLOR);
      drawHandle(ctx, b, SCALE_COLOR);
      drawLabel(ctx, midpoint(a, b), `${l.length} mm`, SCALE_COLOR);
    });

    // Measurements. Amber if the midpoint is outside the calibrated span.
    measurements.forEach((m) => {
      const mid = { x: (m.a.x + m.b.x) / 2, y: (m.a.y + m.b.y) / 2 };
      const outside = hull.length >= 3 && !pointInPolygon(mid, hull);
      const color = outside ? WARN_COLOR : MEAS_COLOR;
      const a = imageToScreen(m.a);
      const b = imageToScreen(m.b);
      drawSegment(ctx, a, b, color);
      drawHandle(ctx, a, color);
      drawHandle(ctx, b, color);
      if (calib) {
        const mm = measureLength(calib.H, m.a, m.b);
        const txt = outside ? `${mm.toFixed(1)} mm ?` : `${mm.toFixed(1)} mm`;
        drawLabel(ctx, midpoint(a, b), txt, color);
      }
    });

    // Pending line + guide.
    const cur = cursorRef.current;
    const penColor = mode === "scale" ? SCALE_COLOR : MEAS_COLOR;
    if (pending.length === 1) {
      const a = imageToScreen(pending[0]);
      drawHandle(ctx, a, penColor);
      if (cur) {
        drawExtendedLine(ctx, a, cur.screen, cw, ch);
        drawSegment(ctx, a, cur.screen, penColor);
      }
    } else if (pending.length === 2) {
      const a = imageToScreen(pending[0]);
      const b = imageToScreen(pending[1]);
      drawExtendedLine(ctx, a, b, cw, ch);
      drawSegment(ctx, a, b, penColor);
      drawHandle(ctx, a, penColor);
      drawHandle(ctx, b, penColor);
    }

    if (cur?.snap && gestureRef.current?.decided !== "movehandle") {
      ctx.beginPath();
      ctx.arc(cur.snap.x, cur.snap.y, 9, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffd24d";
      ctx.stroke();
    }

    const placing = mode !== "idle";
    if (cur && placing && gestureRef.current?.decided !== "movehandle") {
      drawCrosshair(ctx, cur.screen, cw, ch);
      drawLoupe(ctx, img, v, cur, cw, ch);
    }
  }, [scaleLines, measurements, pending, calib, mode]);

  useEffect(() => {
    draw();
  }, [draw, hasImage]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  // ---- Derived UI ----------------------------------------------------------

  const status = calibrationStatus(
    scaleLines.map((l) => ({ a: l.a, b: l.b, length: l.length }))
  );
  const calibrated = !!calib;

  const hullImg =
    calib && scaleLines.length >= 3
      ? convexHull(scaleLines.flatMap((l) => [l.a, l.b]))
      : [];
  const anyOutside =
    calibrated &&
    hullImg.length >= 3 &&
    measurements.some(
      (m) =>
        !pointInPolygon(
          { x: (m.a.x + m.b.x) / 2, y: (m.a.y + m.b.y) / 2 },
          hullImg
        )
    );

  const toggleMode = (m: Mode) => {
    setPending([]);
    setPendingLen("");
    setMode((cur) => (cur === m ? "idle" : m));
  };

  const scaleHint =
    mode === "scale"
      ? pending.length === 0
        ? "Click the first point of a segment whose real length you know."
        : pending.length === 1
        ? "Click the second point. (Esc cancels.)"
        : "Enter its real length, then add."
      : "";

  // -------------------------------------------------------------------------

  return (
    <div className="app">
      <header className="header">
        <div className="logo" />
        <h1>Perspective Size Calculator</h1>
        <div className="spacer" />
        {calibrated ? (
          <span className={`pill ${calib!.rmsError < 3 ? "good" : "warn"}`}>
            Calibrated · fit {calib!.rmsError.toFixed(1)}% ·{" "}
            {calib!.perspective > 0.04 ? "perspective" : "flat/affine"}
          </span>
        ) : (
          <span className="pill">Not calibrated</span>
        )}
      </header>

      <aside className="sidebar">
        {error && <div className="error-banner">{error}</div>}

        {/* Step 1 */}
        <div className="card">
          <div className={`step ${hasImage ? "done" : "active"}`}>
            <div className="num">1</div>
            <div className="body">
              <div className="title">Load an image</div>
              <div className="desc">
                Paste with <kbd>Ctrl/Cmd</kbd>+<kbd>V</kbd> or upload a file.
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <label className="btn">
                  Upload file
                  <input
                    type="file"
                    accept="image/*"
                    onChange={onFileInput}
                    style={{ display: "none" }}
                  />
                </label>
                {hasImage && (
                  <button className="btn ghost" onClick={fitImage}>
                    Fit
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Step 2: calibrate */}
        <div className="card">
          <div
            className={`step ${
              calibrated ? "done" : scaleLines.length > 0 ? "active" : ""
            }`}
          >
            <div className="num">2</div>
            <div className="body">
              <div className="title">Calibrate with known sizes</div>
              <div className="desc">
                Trace segments whose <b>real length</b> you know. Use at least{" "}
                <b>{MIN_SCALE_LINES}</b>, in <b>varied directions</b> and{" "}
                <b>spread across the whole area</b> you want to measure. The
                model adapts automatically (flat vs perspective).
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className={`btn ${mode === "scale" ? "active" : ""}`}
                  style={{ borderColor: SCALE_COLOR }}
                  onClick={() => toggleMode("scale")}
                  disabled={!hasImage}
                >
                  {mode === "scale" ? "Tracing…" : "+ Known length"}
                </button>
                <button
                  className="btn ghost"
                  onClick={() => {
                    setScaleLines([]);
                    cancelPending();
                  }}
                  disabled={scaleLines.length === 0}
                >
                  Clear
                </button>
              </div>
              <div className="progress-text">
                {status.scaleLines}/{MIN_SCALE_LINES} known-length lines
              </div>
              {scaleHint && (
                <div className="hint" style={{ marginTop: 6 }}>
                  {scaleHint}
                </div>
              )}
              {mode === "scale" && pending.length === 2 && (
                <div className="row" style={{ marginTop: 8 }}>
                  <label className="field">
                    Real length (mm)
                    <input
                      type="number"
                      autoFocus
                      placeholder="e.g. 60"
                      value={pendingLen}
                      onChange={(e) => setPendingLen(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && confirmScaleLine()}
                    />
                  </label>
                  <button
                    className="btn primary stretch-end"
                    onClick={confirmScaleLine}
                  >
                    Add
                  </button>
                  <button
                    className="btn ghost stretch-end"
                    onClick={cancelPending}
                  >
                    ✕
                  </button>
                </div>
              )}
              {scaleLines.length > 0 && (
                <div className="measure-list" style={{ marginTop: 10 }}>
                  {scaleLines.map((l, i) => (
                    <div className="measure-item" key={l.id}>
                      <span>Ref {i + 1}</span>
                      <span className="val" style={{ color: SCALE_COLOR }}>
                        {l.length} mm
                      </span>
                      <button
                        onClick={() =>
                          setScaleLines((x) => x.filter((y) => y.id !== l.id))
                        }
                        title="Delete"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {!calibrated && status.reason && scaleLines.length > 0 && (
                <div className="hint" style={{ marginTop: 8 }}>
                  {status.reason}
                </div>
              )}
              {calib && (
                <div style={{ marginTop: 10, display: "grid", gap: 4 }}>
                  <div className="metric">
                    Fit error (RMS): <b>{calib.rmsError.toFixed(2)}%</b>
                  </div>
                  <div className="metric">
                    Max fit error: <b>{calib.maxError.toFixed(2)}%</b>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Step 3: measure */}
        <div className="card">
          <div className={`step ${calibrated ? "active" : ""}`}>
            <div className="num">3</div>
            <div className="body">
              <div className="title">Measure</div>
              <div className="desc">
                Trace segments anywhere on the same flat plane.
              </div>
              {anyOutside && (
                <div className="hint" style={{ marginTop: 8, color: WARN_COLOR }}>
                  ⚠ Measures marked “?” fall outside the area covered by your
                  reference lines — accuracy there is lower. Add a known length
                  nearer them for a reliable result.
                </div>
              )}
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className={`btn primary ${mode === "measure" ? "active" : ""}`}
                  onClick={() => toggleMode("measure")}
                  disabled={!calibrated}
                >
                  {mode === "measure" ? "Measuring…" : "Measure"}
                </button>
                <button
                  className="btn ghost"
                  onClick={() => setMeasurements([])}
                  disabled={measurements.length === 0}
                >
                  Clear
                </button>
              </div>
              {measurements.length > 0 && (
                <div className="measure-list" style={{ marginTop: 10 }}>
                  {measurements.map((m, i) => (
                    <div className="measure-item" key={m.id}>
                      <span>Measure {i + 1}</span>
                      <span className="val">
                        {calib
                          ? measureLength(calib.H, m.a, m.b).toFixed(1)
                          : "—"}{" "}
                        mm
                      </span>
                      <button
                        onClick={() =>
                          setMeasurements((x) => x.filter((y) => y.id !== m.id))
                        }
                        title="Delete"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="hint">
          <b>Controls:</b> click = place point · drag a point = move it · drag
          the image = pan · wheel = zoom · <kbd>Esc</kbd> = cancel the current
          line. Measure only objects on the same flat plane as the references.
        </div>
      </aside>

      <div className="canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            cursor: !hasImage
              ? "default"
              : mode === "idle"
              ? "grab"
              : "crosshair",
          }}
        />
        {!hasImage && (
          <div className="empty-state">
            <div>
              <div className="big">Paste or upload an image to start</div>
              <div>
                <kbd>Ctrl/Cmd</kbd>+<kbd>V</kbd> to paste from the clipboard
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Canvas drawing helpers -----------------------------------------------

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function drawHandle(ctx: CanvasRenderingContext2D, p: Point, color: string) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.stroke();
}

function drawSegment(
  ctx: CanvasRenderingContext2D,
  a: Point,
  b: Point,
  color: string
) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  p: Point,
  text: string,
  color: string
) {
  ctx.font = "bold 13px sans-serif";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(10,12,16,0.85)";
  ctx.fillRect(p.x - w / 2 - 6, p.y - 22, w + 12, 18);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, p.x, p.y - 13);
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function drawExtendedLine(
  ctx: CanvasRenderingContext2D,
  a: Point,
  b: Point,
  cw: number,
  ch: number
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const far = cw + ch;
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.beginPath();
  ctx.moveTo(a.x - ux * far, a.y - uy * far);
  ctx.lineTo(a.x + ux * far, a.y + uy * far);
  ctx.stroke();
  ctx.restore();
}

function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  p: Point,
  cw: number,
  ch: number
) {
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.beginPath();
  ctx.moveTo(0, p.y);
  ctx.lineTo(cw, p.y);
  ctx.moveTo(p.x, 0);
  ctx.lineTo(p.x, ch);
  ctx.stroke();
  ctx.restore();
}

function drawLoupe(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  v: { scale: number; offsetX: number; offsetY: number },
  cur: { img: Point; screen: Point },
  cw: number,
  ch: number
) {
  const R = 70;
  const zoom = 6;
  const margin = 16;
  const lx = cur.screen.x < cw / 2 ? cw - R - margin : R + margin;
  const ly = cur.screen.y < ch / 2 ? ch - R - margin : R + margin;
  const center = { x: lx, y: ly };

  ctx.save();
  ctx.beginPath();
  ctx.arc(center.x, center.y, R, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = "#000";
  ctx.fillRect(center.x - R, center.y - R, R * 2, R * 2);
  const srcW = (R * 2) / zoom;
  const srcX = cur.img.x - srcW / 2;
  const srcY = cur.img.y - srcW / 2;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    img,
    srcX,
    srcY,
    srcW,
    srcW,
    center.x - R,
    center.y - R,
    R * 2,
    R * 2
  );
  ctx.imageSmoothingEnabled = true;
  ctx.strokeStyle = "rgba(255,138,61,0.9)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(center.x - 12, center.y);
  ctx.lineTo(center.x + 12, center.y);
  ctx.moveTo(center.x, center.y - 12);
  ctx.lineTo(center.x, center.y + 12);
  ctx.stroke();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(center.x, center.y, R, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.stroke();
}
