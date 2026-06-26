// Adaptive metric calibration of a plane from a single photo.
//
// The user draws segments of known real length, distributed across the area to
// be measured. We fit the image->world(mm) homography by regularized least
// squares:
//
//   * Initialize with the best AFFINE map (no perspective) from the known
//     lengths: a length L of an image segment with displacement d satisfies
//     d^T S d = L^2 for a symmetric 2x2 metric S (linear in its 3 entries).
//   * Refine the full 8-DOF homography with Levenberg-Marquardt to minimize the
//     relative length errors, plus a regularizer that pulls the perspective
//     terms toward zero.
//
// The regularizer is the key to robustness: when the camera is near top-down
// there is essentially no perspective to estimate (parallel world lines stay
// parallel), so the fit stays affine instead of overfitting noise into a fake
// perspective. When the camera is oblique and the data supports it, perspective
// emerges. Accuracy requires the known-length lines to SPAN the measured area
// and to point in varied directions; references clustered in one spot give poor
// results far away (a fundamental limit, not a bug).

export type Point = { x: number; y: number };
export type Matrix3 = number[]; // row-major length-9

export const MIN_SCALE_LINES = 5;
const PERSPECTIVE_LAMBDA = 0.05;

export function applyHomography(H: Matrix3, p: Point): Point {
  const x = H[0] * p.x + H[1] * p.y + H[2];
  const y = H[3] * p.x + H[4] * p.y + H[5];
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: x / w, y: y / w };
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function measureLength(H: Matrix3, a: Point, b: Point): number {
  return dist(applyHomography(H, a), applyHomography(H, b));
}

// --- types ------------------------------------------------------------------

export type ScaleLine = { a: Point; b: Point; length: number };

export type CalibrationResult = {
  H: Matrix3; // image -> world (mm)
  rmsError: number; // RMS relative error (%) over the known lengths
  maxError: number;
  perspective: number; // magnitude of the recovered perspective (0 = affine)
};

export type CalibrationStatus = {
  scaleLines: number;
  ready: boolean;
  reason?: string;
};

export function calibrationStatus(scaleLines: ScaleLine[]): CalibrationStatus {
  const n = scaleLines.filter((l) => l.length > 0).length;
  if (n < MIN_SCALE_LINES)
    return {
      scaleLines: n,
      ready: false,
      reason: `Add at least ${MIN_SCALE_LINES} known-length lines, in varied directions and spread across the area you want to measure.`,
    };
  return { scaleLines: n, ready: true };
}

// --- linear algebra ---------------------------------------------------------

function matMul3(A: Matrix3, B: Matrix3): Matrix3 {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) C[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
  return C;
}

function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-15) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// --- Hartley normalization --------------------------------------------------

function normalization(pts: Point[]): {
  T: Matrix3;
  apply: (p: Point) => Point;
} | null {
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let md = 0;
  for (const p of pts) md += Math.hypot(p.x - cx, p.y - cy);
  md /= pts.length;
  if (md < 1e-9) return null;
  const s = Math.SQRT2 / md;
  return {
    T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
    apply: (p: Point) => ({ x: s * (p.x - cx), y: s * (p.y - cy) }),
  };
}

// --- calibration ------------------------------------------------------------

export function calibrate(scaleLines: ScaleLine[]): CalibrationResult | null {
  const lines = scaleLines.filter((l) => l.length > 0);
  if (lines.length < MIN_SCALE_LINES) return null;

  const norm = normalization(lines.flatMap((l) => [l.a, l.b]));
  if (!norm) return null;
  const nLines = lines.map((l) => ({
    a: norm.apply(l.a),
    b: norm.apply(l.b),
    length: l.length,
  }));

  // --- Affine initialization: fit S (2x2 metric) from d^T S d = L^2 ---
  const A: number[][] = [];
  const rhs: number[] = [];
  for (const l of nLines) {
    const dx = l.a.x - l.b.x;
    const dy = l.a.y - l.b.y;
    A.push([dx * dx, 2 * dx * dy, dy * dy]);
    rhs.push(l.length * l.length);
  }
  const AtA = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const Atb = [0, 0, 0];
  for (let r = 0; r < A.length; r++)
    for (let i = 0; i < 3; i++) {
      Atb[i] += A[r][i] * rhs[r];
      for (let j = 0; j < 3; j++) AtA[i][j] += A[r][i] * A[r][j];
    }
  const Svec = solveLinearSystem(AtA, Atb);
  if (!Svec) return null;
  const [S11, S12, S22] = Svec;
  if (!(S11 > 0) || !(S11 * S22 - S12 * S12 > 0)) return null;
  const L11 = Math.sqrt(S11);
  const L12 = S12 / L11;
  const L22sq = S22 - L12 * L12;
  if (!(L22sq > 0)) return null;
  const L22 = Math.sqrt(L22sq);

  // 8 parameters of the normalized-image -> world homography (h33 = 1).
  let h = [L11, L12, 0, 0, L22, 0, 0, 0];

  const residuals = (hh: number[]): number[] => {
    const H = [...hh, 1];
    const r: number[] = [];
    for (const l of nLines)
      r.push((measureLength(H, l.a, l.b) - l.length) / l.length);
    // Regularize the perspective terms (h31, h32) toward zero -> prefer affine.
    r.push(Math.sqrt(PERSPECTIVE_LAMBDA) * hh[6]);
    r.push(Math.sqrt(PERSPECTIVE_LAMBDA) * hh[7]);
    return r;
  };

  // --- Levenberg-Marquardt refinement ---
  let lam = 1e-3;
  let r = residuals(h);
  let cost = r.reduce((s, x) => s + x * x, 0);
  for (let iter = 0; iter < 200; iter++) {
    const m = r.length;
    const n = 8;
    const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const eps = 1e-6 * (Math.abs(h[j]) + 1e-3);
      const h2 = [...h];
      h2[j] += eps;
      const r2 = residuals(h2);
      for (let i = 0; i < m; i++) J[i][j] = (r2[i] - r[i]) / eps;
    }
    const N = Array.from({ length: n }, () => new Array(n).fill(0));
    const g = new Array(n).fill(0);
    for (let i = 0; i < m; i++)
      for (let a = 0; a < n; a++) {
        g[a] += J[i][a] * r[i];
        for (let b = 0; b < n; b++) N[a][b] += J[i][a] * J[i][b];
      }
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const Nd = N.map((row, i) =>
        row.map((v, j) => (i === j ? v + lam * (Math.abs(v) + 1e-9) : v))
      );
      const d = solveLinearSystem(
        Nd,
        g.map((v) => -v)
      );
      if (!d) {
        lam *= 3;
        continue;
      }
      const h2 = h.map((v, i) => v + d[i]);
      const r2 = residuals(h2);
      const c2 = r2.reduce((s, x) => s + x * x, 0);
      if (c2 < cost) {
        const rel = (cost - c2) / Math.max(cost, 1e-30);
        h = h2;
        r = r2;
        cost = c2;
        lam = Math.max(lam * 0.5, 1e-12);
        improved = true;
        if (rel < 1e-9) iter = 999;
        break;
      }
      lam *= 3;
    }
    if (!improved) break;
  }

  const Hn = [...h, 1];
  const H = matMul3(Hn, norm.T); // image -> world
  if (H.some((x) => !Number.isFinite(x))) return null;

  let sumSq = 0;
  let max = 0;
  for (const l of lines) {
    const mm = measureLength(H, l.a, l.b);
    const rel = Math.abs(mm - l.length) / l.length;
    sumSq += rel * rel;
    if (rel > max) max = rel;
  }

  return {
    H,
    rmsError: Math.sqrt(sumSq / lines.length) * 100,
    maxError: max * 100,
    perspective: Math.hypot(h[6], h[7]),
  };
}

// --- region helpers (for a soft "outside calibrated area" hint) -------------

export function convexHull(points: Point[]): Point[] {
  const pts = points
    .slice()
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (pts.length < 3) return pts;
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    )
      lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    )
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y,
      xj = poly[j].x,
      yj = poly[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
