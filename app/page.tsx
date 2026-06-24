"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  calibrate,
  measureLength,
  type CalibrationResult,
  type LengthConstraint,
  type Point,
} from "@/lib/homography";

type Mode = "calibrate" | "addref" | "measure";

type Measurement = { id: number; a: Point; b: Point };
type RefSegment = { id: number; a: Point; b: Point; length: number };

const CORNER_LABELS = ["sup. izq.", "sup. der.", "inf. der.", "inf. izq."];

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [hasImage, setHasImage] = useState(false);
  const [mode, setMode] = useState<Mode>("calibrate");

  // View transform (CSS pixels): screen = image * scale + offset.
  const viewRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 });

  // Calibration inputs.
  const [corners, setCorners] = useState<Point[]>([]);
  const [rectW, setRectW] = useState<string>("");
  const [rectH, setRectH] = useState<string>("");

  // Extra reference segments (optional, improve precision).
  const [refs, setRefs] = useState<RefSegment[]>([]);

  // Measurements.
  const [measurements, setMeasurements] = useState<Measurement[]>([]);

  // In-progress point collection (image coords).
  const [pending, setPending] = useState<Point[]>([]);
  const [pendingRefLen, setPendingRefLen] = useState<string>("");

  const [calib, setCalib] = useState<CalibrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Live cursor (image coords) + whether over canvas, for guide line + loupe.
  const cursorRef = useRef<{ img: Point; screen: Point } | null>(null);
  const idRef = useRef(1);

  // ---- Image loading -------------------------------------------------------

  const loadImageFromBlob = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setHasImage(true);
      setError(null);
      // Reset everything tied to the previous image.
      setCorners([]);
      setRefs([]);
      setMeasurements([]);
      setPending([]);
      setCalib(null);
      setMode("calibrate");
      fitImage();
      URL.revokeObjectURL(url);
    };
    img.onerror = () => setError("No se pudo cargar la imagen.");
    img.src = url;
  }, []);

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

  // Paste from clipboard.
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
    const w = parseFloat(rectW);
    const h = parseFloat(rectH);
    if (corners.length !== 4 || !(w > 0) || !(h > 0)) {
      setCalib(null);
      return;
    }
    const constraints: LengthConstraint[] = refs.map((r) => ({
      a: r.a,
      b: r.b,
      length: r.length,
    }));
    const result = calibrate(corners, w, h, constraints);
    if (!result) {
      setError("La calibración falló: revisa que las esquinas no estén alineadas.");
      setCalib(null);
    } else {
      setError(null);
      setCalib(result);
    }
  }, [corners, rectW, rectH, refs]);

  // ---- Pointer interaction -------------------------------------------------

  const panState = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    ox: number;
    oy: number;
  } | null>(null);
  const spaceDown = useRef(false);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown.current = true;
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
  }, []);

  const getLocal = (e: React.PointerEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!hasImage) return;
    const local = getLocal(e);
    const isPan = e.button === 1 || (e.button === 0 && spaceDown.current);
    if (isPan) {
      const v = viewRef.current;
      panState.current = {
        active: true,
        startX: local.x,
        startY: local.y,
        ox: v.offsetX,
        oy: v.offsetY,
      };
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    placePoint(screenToImage(local.x, local.y));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!hasImage) return;
    const local = getLocal(e);
    if (panState.current?.active) {
      const p = panState.current;
      viewRef.current.offsetX = p.ox + (local.x - p.startX);
      viewRef.current.offsetY = p.oy + (local.y - p.startY);
      draw();
      return;
    }
    cursorRef.current = { img: screenToImage(local.x, local.y), screen: local };
    draw();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (panState.current?.active) {
      panState.current.active = false;
      try {
        (e.target as Element).releasePointerCapture(e.pointerId);
      } catch {}
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
    const newScale = Math.max(0.05, Math.min(40, v.scale * factor));
    // Zoom toward cursor: keep the image point under the cursor fixed.
    const imgX = (local.x - v.offsetX) / v.scale;
    const imgY = (local.y - v.offsetY) / v.scale;
    v.scale = newScale;
    v.offsetX = local.x - imgX * newScale;
    v.offsetY = local.y - imgY * newScale;
    draw();
  };

  const placePoint = (p: Point) => {
    if (mode === "calibrate") {
      if (corners.length >= 4) return;
      setCorners((c) => [...c, p]);
      return;
    }
    // addref / measure collect 2 points.
    setPending((prev) => {
      const next = [...prev, p];
      if (next.length === 2) {
        if (mode === "measure") {
          setMeasurements((m) => [
            ...m,
            { id: idRef.current++, a: next[0], b: next[1] },
          ]);
          return [];
        }
        // addref: keep the 2 points pending until length is confirmed.
      }
      return next;
    });
  };

  const confirmRef = () => {
    const len = parseFloat(pendingRefLen);
    if (pending.length !== 2 || !(len > 0)) return;
    setRefs((r) => [
      ...r,
      { id: idRef.current++, a: pending[0], b: pending[1], length: len },
    ]);
    setPending([]);
    setPendingRefLen("");
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

    // Reference rectangle (calibration corners).
    if (corners.length > 0) {
      const sc = corners.map(imageToScreen);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#4da3ff";
      ctx.fillStyle = "rgba(77,163,255,0.12)";
      ctx.beginPath();
      sc.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (corners.length === 4) ctx.closePath();
      if (corners.length === 4) ctx.fill();
      ctx.stroke();
      sc.forEach((p, i) => drawHandle(ctx, p, "#4da3ff", String(i + 1)));
    }

    // Reference segments (extra).
    refs.forEach((r) => {
      const a = imageToScreen(r.a);
      const b = imageToScreen(r.b);
      drawSegment(ctx, a, b, "#46c66a");
      drawHandle(ctx, a, "#46c66a");
      drawHandle(ctx, b, "#46c66a");
      drawLabel(ctx, midpoint(a, b), `${r.length} mm`, "#46c66a");
    });

    // Measurements.
    measurements.forEach((m) => {
      const a = imageToScreen(m.a);
      const b = imageToScreen(m.b);
      drawSegment(ctx, a, b, "#ff8a3d");
      drawHandle(ctx, a, "#ff8a3d");
      drawHandle(ctx, b, "#ff8a3d");
      if (calib) {
        const mm = measureLength(calib.H, m.a, m.b);
        drawLabel(ctx, midpoint(a, b), `${mm.toFixed(1)} mm`, "#ff8a3d");
      }
    });

    // Pending points + guide line that extends across the canvas.
    const cur = cursorRef.current;
    if (pending.length > 0) {
      const a = imageToScreen(pending[0]);
      drawHandle(ctx, a, "#ffffff");
      if (cur) {
        const b = cur.screen;
        drawExtendedLine(ctx, a, b, cw, ch);
        drawSegment(ctx, a, b, "#ffffff");
      }
    }

    // Crosshair + loupe in placement modes.
    if (cur && !panState.current?.active) {
      drawCrosshair(ctx, cur.screen, cw, ch);
      drawLoupe(ctx, img, v, cur, cw, ch);
    }
  }, [corners, refs, measurements, pending, calib]);

  useEffect(() => {
    draw();
  }, [draw, hasImage]);

  // Redraw on resize.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      if (imgRef.current && corners.length === 0 && refs.length === 0) {
        // Only re-fit before the user starts marking, to avoid moving points.
      }
      draw();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw, corners.length, refs.length]);

  // ---- Derived UI state ----------------------------------------------------

  const calibrated = !!calib;
  const cornersDone = corners.length === 4;
  const dimsDone = parseFloat(rectW) > 0 && parseFloat(rectH) > 0;

  const resetCalibration = () => {
    setCorners([]);
    setRefs([]);
    setPending([]);
    setCalib(null);
  };

  // -------------------------------------------------------------------------

  return (
    <div className="app">
      <header className="header">
        <div className="logo" />
        <h1>Calculadora de tamaños por perspectiva</h1>
        <div className="spacer" />
        {calibrated ? (
          <span className={`pill ${calib!.rmsError < 3 ? "good" : "warn"}`}>
            Calibrado · error {calib!.rmsError.toFixed(1)}%
          </span>
        ) : (
          <span className="pill">Sin calibrar</span>
        )}
      </header>

      <aside className="sidebar">
        {error && <div className="error-banner">{error}</div>}

        {/* Step 1: image */}
        <div className="card">
          <div className={`step ${hasImage ? "done" : "active"}`}>
            <div className="num">1</div>
            <div className="body">
              <div className="title">Carga una imagen</div>
              <div className="desc">
                Pega con <kbd>Ctrl/Cmd</kbd>+<kbd>V</kbd> o sube un archivo.
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <label className="btn">
                  Subir archivo
                  <input
                    type="file"
                    accept="image/*"
                    onChange={onFileInput}
                    style={{ display: "none" }}
                  />
                </label>
                {hasImage && (
                  <button className="btn ghost" onClick={fitImage}>
                    Encajar
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Step 2: calibration */}
        <div className="card">
          <div
            className={`step ${
              calibrated ? "done" : cornersDone || dimsDone ? "active" : ""
            }`}
          >
            <div className="num">2</div>
            <div className="body">
              <div className="title">Calibra con el objeto conocido</div>
              <div className="desc">
                Marca las <b>4 esquinas</b> del objeto rectangular (en orden) e
                introduce su tamaño real.
              </div>

              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className={`btn ${mode === "calibrate" ? "active" : ""}`}
                  onClick={() => setMode("calibrate")}
                  disabled={!hasImage}
                >
                  Marcar esquinas ({corners.length}/4)
                </button>
                <button
                  className="btn ghost"
                  onClick={resetCalibration}
                  disabled={corners.length === 0 && refs.length === 0}
                >
                  Reiniciar
                </button>
              </div>

              {mode === "calibrate" && hasImage && (
                <div className="hint" style={{ marginTop: 8 }}>
                  {corners.length < 4
                    ? `Haz clic en la esquina ${CORNER_LABELS[corners.length]}.`
                    : "4 esquinas marcadas. Introduce las dimensiones reales."}
                </div>
              )}

              <div className="row" style={{ marginTop: 10 }}>
                <label className="field">
                  Ancho (mm)
                  <input
                    type="number"
                    value={rectW}
                    onChange={(e) => setRectW(e.target.value)}
                    placeholder="ej. 24.5"
                  />
                </label>
                <label className="field">
                  Alto (mm)
                  <input
                    type="number"
                    value={rectH}
                    onChange={(e) => setRectH(e.target.value)}
                    placeholder="ej. 18.0"
                  />
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Step 3: optional extra references */}
        <div className="card">
          <div className={`step ${refs.length > 0 ? "done" : ""}`}>
            <div className="num">+</div>
            <div className="body">
              <div className="title">Referencias extra (opcional)</div>
              <div className="desc">
                Añade más segmentos de longitud conocida para afinar la
                precisión. Reduce el error promediando el ruido.
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className={`btn ${mode === "addref" ? "active" : ""}`}
                  onClick={() => {
                    setMode("addref");
                    setPending([]);
                  }}
                  disabled={!cornersDone}
                >
                  Añadir referencia
                </button>
              </div>
              {mode === "addref" && (
                <div className="hint" style={{ marginTop: 8 }}>
                  {pending.length === 0 && "Marca el primer punto del segmento."}
                  {pending.length === 1 && "Marca el segundo punto."}
                  {pending.length === 2 && "Introduce su longitud real:"}
                </div>
              )}
              {mode === "addref" && pending.length === 2 && (
                <div className="row" style={{ marginTop: 8 }}>
                  <label className="field">
                    Longitud (mm)
                    <input
                      type="number"
                      autoFocus
                      value={pendingRefLen}
                      onChange={(e) => setPendingRefLen(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && confirmRef()}
                    />
                  </label>
                  <button
                    className="btn primary"
                    style={{ alignSelf: "flex-end" }}
                    onClick={confirmRef}
                  >
                    Añadir
                  </button>
                </div>
              )}
              {refs.length > 0 && (
                <div className="measure-list" style={{ marginTop: 10 }}>
                  {refs.map((r) => (
                    <div className="measure-item" key={r.id}>
                      <span>Referencia</span>
                      <span className="val" style={{ color: "#46c66a" }}>
                        {r.length} mm
                      </span>
                      <button
                        onClick={() =>
                          setRefs((x) => x.filter((y) => y.id !== r.id))
                        }
                        title="Eliminar"
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

        {/* Step 4: measure */}
        <div className="card">
          <div className={`step ${calibrated ? "active" : ""}`}>
            <div className="num">3</div>
            <div className="body">
              <div className="title">Mide objetos</div>
              <div className="desc">
                Con la imagen calibrada, traza segmentos entre dos puntos.
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className={`btn primary ${mode === "measure" ? "active" : ""}`}
                  onClick={() => {
                    setMode("measure");
                    setPending([]);
                  }}
                  disabled={!calibrated}
                >
                  Medir
                </button>
                <button
                  className="btn ghost"
                  onClick={() => setMeasurements([])}
                  disabled={measurements.length === 0}
                >
                  Limpiar
                </button>
              </div>

              {calib && (
                <div style={{ marginTop: 10, display: "grid", gap: 4 }}>
                  <div className="metric">
                    Error de calibración (RMS):{" "}
                    <b>{calib.rmsError.toFixed(2)}%</b>
                  </div>
                  <div className="metric">
                    Error máximo: <b>{calib.maxError.toFixed(2)}%</b>
                  </div>
                </div>
              )}

              {measurements.length > 0 && (
                <div className="measure-list" style={{ marginTop: 10 }}>
                  {measurements.map((m, i) => (
                    <div className="measure-item" key={m.id}>
                      <span>Medida {i + 1}</span>
                      <span className="val">
                        {calib
                          ? measureLength(calib.H, m.a, m.b).toFixed(1)
                          : "—"}{" "}
                        mm
                      </span>
                      <button
                        onClick={() =>
                          setMeasurements((x) =>
                            x.filter((y) => y.id !== m.id)
                          )
                        }
                        title="Eliminar"
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
          <b>Atajos:</b> rueda = zoom · arrastrar con <kbd>Espacio</kbd> o botón
          central = mover. Asegúrate de que los objetos a medir están en el
          mismo plano que la referencia.
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
          style={{ cursor: hasImage ? "crosshair" : "default" }}
        />
        {!hasImage && (
          <div className="empty-state">
            <div>
              <div className="big">Pega o sube una imagen para empezar</div>
              <div>
                <kbd>Ctrl/Cmd</kbd>+<kbd>V</kbd> para pegar desde el
                portapapeles
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

function drawHandle(
  ctx: CanvasRenderingContext2D,
  p: Point,
  color: string,
  label?: string
) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.stroke();
  if (label) {
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText(label, p.x + 8, p.y - 8);
  }
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

// Draw the line through a->b extended to the canvas edges.
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
  const p1 = { x: a.x - ux * far, y: a.y - uy * far };
  const p2 = { x: a.x + ux * far, y: a.y + uy * far };
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
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

// Magnifier loupe for sub-pixel point placement.
function drawLoupe(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  v: { scale: number; offsetX: number; offsetY: number },
  cur: { img: Point; screen: Point },
  cw: number,
  ch: number
) {
  const R = 70; // loupe radius
  const zoom = 6; // magnification relative to image native px
  const margin = 16;
  // Place loupe in the corner away from the cursor.
  const lx = cur.screen.x < cw / 2 ? cw - R - margin : R + margin;
  const ly = cur.screen.y < ch / 2 ? ch - R - margin : R + margin;
  const center = { x: lx, y: ly };

  ctx.save();
  ctx.beginPath();
  ctx.arc(center.x, center.y, R, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  // Background.
  ctx.fillStyle = "#000";
  ctx.fillRect(center.x - R, center.y - R, R * 2, R * 2);
  // Draw the image magnified around the cursor's image coordinate.
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
  // Crosshair at center.
  ctx.strokeStyle = "rgba(255,138,61,0.9)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(center.x - 12, center.y);
  ctx.lineTo(center.x + 12, center.y);
  ctx.moveTo(center.x, center.y - 12);
  ctx.lineTo(center.x, center.y + 12);
  ctx.stroke();
  ctx.restore();
  // Border ring.
  ctx.beginPath();
  ctx.arc(center.x, center.y, R, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.stroke();
}
