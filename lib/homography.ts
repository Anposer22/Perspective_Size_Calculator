// Homography (projective) calibration from known-length line segments.
//
// We map IMAGE pixel coordinates -> real-world plane coordinates (mm) with an
// 8-DOF homography. The user draws line segments anywhere on the image (they do
// NOT need to form a rectangle) and tells us the real length of each. The
// homography is fit by nonlinear least squares so that every segment, when
// reprojected to the world plane, matches its known length.
//
// Degrees of freedom: a homography has 8. Rigid motion of the world frame
// (rotation + translation = 3 DOF) does not affect any length, so it is an
// irrelevant gauge freedom. That leaves 5 meaningful DOF, i.e. at least 5
// length constraints are needed; we ask for a few more for stability and to get
// a meaningful residual. Levenberg-Marquardt damping handles the gauge freedom.

export type Point = { x: number; y: number };
export type Matrix3 = number[]; // row-major length-9

export const MIN_CALIBRATION_LINES = 6;

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

function matMul3(A: Matrix3, B: Matrix3): Matrix3 {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) C[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
  return C;
}

export type CalibLine = { a: Point; b: Point; length: number };

export type CalibrationResult = {
  H: Matrix3;
  rmsError: number; // RMS relative error (%) across all calibration lines
  maxError: number; // worst relative error (%)
};

// Build a homography (8 params, h33 = 1) from a flat parameter vector.
function paramsToH(p: number[]): Matrix3 {
  return [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], 1];
}

/**
 * Calibrate the image->world homography from known-length segments.
 * Returns null if there are too few lines or the fit fails.
 */
export function calibrateFromLengths(
  lines: CalibLine[]
): CalibrationResult | null {
  if (lines.length < MIN_CALIBRATION_LINES) return null;

  // --- Hartley normalization of image coordinates (improves conditioning) ---
  const pts: Point[] = [];
  for (const l of lines) {
    pts.push(l.a, l.b);
  }
  let cx = 0,
    cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let meanDist = 0;
  for (const p of pts) meanDist += Math.hypot(p.x - cx, p.y - cy);
  meanDist /= pts.length;
  if (meanDist < 1e-9) return null;
  const s = 1 / meanDist;
  const N: Matrix3 = [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];

  const norm = (p: Point): Point => ({
    x: s * (p.x - cx),
    y: s * (p.y - cy),
  });
  const nLines = lines.map((l) => ({
    a: norm(l.a),
    b: norm(l.b),
    length: l.length,
  }));

  // Residuals: relative length error of each segment (in normalized image
  // space mapped to world via Hprime).
  const residuals = (p: number[]): number[] => {
    const H = paramsToH(p);
    const r: number[] = [];
    for (const l of nLines) {
      const computed = dist(applyHomography(H, l.a), applyHomography(H, l.b));
      r.push((computed - l.length) / l.length);
    }
    return r;
  };

  // --- Initialization: pure similarity (scale only, no perspective) ---
  let scaleSum = 0;
  let scaleN = 0;
  for (const l of nLines) {
    const d = dist(l.a, l.b);
    if (d > 1e-9) {
      scaleSum += l.length / d;
      scaleN++;
    }
  }
  const alpha = scaleN ? scaleSum / scaleN : 1;

  const baseInit = [alpha, 0, 0, 0, alpha, 0, 0, 0];

  // Try the base init plus a few perspective-perturbed restarts; keep the best.
  const restarts: number[][] = [baseInit];
  const perturb = [0.05, -0.05, 0.1, -0.1];
  for (const a of perturb)
    for (const b of perturb) {
      restarts.push([alpha, 0, 0, 0, alpha, 0, a, b]);
    }

  let best: { p: number[]; cost: number } | null = null;
  for (const init of restarts) {
    const res = levenbergMarquardt(residuals, init, 120);
    if (!best || res.cost < best.cost) best = res;
  }
  if (!best) return null;

  const Hprime = paramsToH(best.p);
  const H = matMul3(Hprime, N); // image -> world

  // Error metrics in real (un-normalized) terms.
  let sumSq = 0;
  let max = 0;
  for (const l of lines) {
    const computed = measureLength(H, l.a, l.b);
    const rel = Math.abs(computed - l.length) / l.length;
    sumSq += rel * rel;
    if (rel > max) max = rel;
  }
  return {
    H,
    rmsError: Math.sqrt(sumSq / lines.length) * 100,
    maxError: max * 100,
  };
}

// --- Levenberg-Marquardt least squares -------------------------------------

function levenbergMarquardt(
  residualFn: (p: number[]) => number[],
  p0: number[],
  maxIter: number
): { p: number[]; cost: number } {
  const n = p0.length;
  let p = p0.slice();
  let r = residualFn(p);
  let cost = sumSq(r);
  let lambda = 1e-3;

  for (let iter = 0; iter < maxIter; iter++) {
    const J = numericJacobian(residualFn, p, r);
    const m = r.length;
    // A = JtJ (n x n), g = Jtr (n)
    const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const g: number[] = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      for (let a = 0; a < n; a++) {
        g[a] += J[i][a] * r[i];
        for (let b = 0; b < n; b++) A[a][b] += J[i][a] * J[i][b];
      }
    }

    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      // Damped normal equations: (A + lambda*diag(A)) d = -g
      const Ad = A.map((row, i) =>
        row.map((v, j) => (i === j ? v + lambda * (Math.abs(v) + 1e-9) : v))
      );
      const neg = g.map((v) => -v);
      const d = solveLinearSystem(Ad, neg);
      if (!d) {
        lambda *= 3;
        continue;
      }
      const pTry = p.map((v, i) => v + d[i]);
      const rTry = residualFn(pTry);
      const costTry = sumSq(rTry);
      if (costTry < cost) {
        p = pTry;
        r = rTry;
        const rel = (cost - costTry) / Math.max(cost, 1e-30);
        cost = costTry;
        lambda = Math.max(lambda * 0.5, 1e-12);
        improved = true;
        if (rel < 1e-8) return { p, cost };
        break;
      }
      lambda *= 3;
      if (lambda > 1e12) return { p, cost };
    }
    if (!improved) break;
  }
  return { p, cost };
}

function numericJacobian(
  residualFn: (p: number[]) => number[],
  p: number[],
  r0: number[]
): number[][] {
  const n = p.length;
  const m = r0.length;
  const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    const eps = 1e-6 * (Math.abs(p[j]) + 1e-3);
    const pj = p.slice();
    pj[j] += eps;
    const rj = residualFn(pj);
    for (let i = 0; i < m; i++) J[i][j] = (rj[i] - r0[i]) / eps;
  }
  return J;
}

function sumSq(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return s;
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
  const x = new Array(n);
  for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
  return x;
}
