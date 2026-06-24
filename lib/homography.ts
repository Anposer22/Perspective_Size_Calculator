// Homography (projective) calibration utilities.
//
// We map IMAGE pixel coordinates -> real-world plane coordinates (mm).
// A single rectangle of known width/height fully determines the 8-DOF
// homography. Extra known-length segments are optional constraints used to
// refine the fit by least squares, averaging out clicking noise and lens
// distortion.

export type Point = { x: number; y: number };

// 3x3 matrix as a flat length-9 array, row-major.
export type Matrix3 = number[];

/** Apply a homography to a 2D point. */
export function applyHomography(H: Matrix3, p: Point): Point {
  const x = H[0] * p.x + H[1] * p.y + H[2];
  const y = H[3] * p.x + H[4] * p.y + H[5];
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: x / w, y: y / w };
}

/** Euclidean distance between two points. */
export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Solve the exact homography mapping 4 source points to 4 destination points.
 * Sets h33 = 1 and solves the resulting 8x8 linear system via Gaussian
 * elimination with partial pivoting.
 */
export function computeHomography4(src: Point[], dst: Point[]): Matrix3 | null {
  if (src.length !== 4 || dst.length !== 4) return null;

  // Build 8x8 system A h = b, with h = [h11..h32], h33 fixed to 1.
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }

  const h = solveLinearSystem(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Gaussian elimination with partial pivoting. Solves A x = b (n x n). */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  // Augmented matrix.
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Pivot.
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];

    // Eliminate.
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

export type LengthConstraint = {
  a: Point; // image-space endpoint
  b: Point; // image-space endpoint
  length: number; // known real-world length (mm)
};

export type CalibrationResult = {
  H: Matrix3;
  rmsError: number; // RMS relative error (%) across all known constraints
  maxError: number; // worst relative error (%) across all known constraints
};

/**
 * Refine a homography using extra known-length constraints (least squares).
 *
 * Starts from the exact 4-corner solution and runs a small gradient-descent
 * refinement that minimizes:
 *   - reprojection error of the 4 rectangle corners (kept tight), plus
 *   - squared relative error of each known-length segment.
 *
 * Returns the refined homography and residual error metrics.
 */
export function calibrate(
  corners: Point[], // 4 image-space corners: TL, TR, BR, BL
  rectWidth: number,
  rectHeight: number,
  extraConstraints: LengthConstraint[] = []
): CalibrationResult | null {
  const dst: Point[] = [
    { x: 0, y: 0 },
    { x: rectWidth, y: 0 },
    { x: rectWidth, y: rectHeight },
    { x: 0, y: rectHeight },
  ];

  const H0 = computeHomography4(corners, dst);
  if (!H0) return null;

  // All constraints used for scoring: the rectangle's own four edges plus any
  // user-supplied extra segments.
  const allConstraints: LengthConstraint[] = [
    { a: corners[0], b: corners[1], length: rectWidth },
    { a: corners[1], b: corners[2], length: rectHeight },
    { a: corners[2], b: corners[3], length: rectWidth },
    { a: corners[3], b: corners[0], length: rectHeight },
    ...extraConstraints,
  ];

  if (extraConstraints.length === 0) {
    return { H: H0, ...errorMetrics(H0, allConstraints) };
  }

  // Cost: corner reprojection error (anchors the world frame & scale) plus
  // relative length error over every constraint.
  const cost = (H: Matrix3): number => {
    let c = 0;
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(H, corners[i]);
      c += (p.x - dst[i].x) ** 2 + (p.y - dst[i].y) ** 2;
    }
    for (const k of allConstraints) {
      const la = applyHomography(H, k.a);
      const lb = applyHomography(H, k.b);
      const measured = dist(la, lb);
      const rel = (measured - k.length) / k.length;
      // Weight length constraints so they meaningfully shape the fit.
      c += (rel * Math.max(rectWidth, rectHeight)) ** 2;
    }
    return c;
  };

  let H = [...H0];
  let step = 1e-4;
  let prev = cost(H);
  for (let iter = 0; iter < 400; iter++) {
    const grad = numericGradient(cost, H);
    const norm = Math.hypot(...grad);
    if (norm < 1e-12) break;
    // Backtracking line search.
    let moved = false;
    for (let s = 0; s < 8; s++) {
      const trial = H.map((v, i) => v - (step * grad[i]) / norm);
      const c = cost(trial);
      if (c < prev) {
        H = trial;
        prev = c;
        step *= 1.5;
        moved = true;
        break;
      }
      step *= 0.5;
    }
    if (!moved && step < 1e-10) break;
  }

  return { H, ...errorMetrics(H, allConstraints) };
}

function numericGradient(f: (H: Matrix3) => number, H: Matrix3): number[] {
  const eps = 1e-6;
  const base = f(H);
  const g = new Array(9).fill(0);
  for (let i = 0; i < 9; i++) {
    const h2 = [...H];
    h2[i] += eps;
    g[i] = (f(h2) - base) / eps;
  }
  return g;
}

function errorMetrics(
  H: Matrix3,
  constraints: LengthConstraint[]
): { rmsError: number; maxError: number } {
  let sumSq = 0;
  let max = 0;
  for (const k of constraints) {
    const la = applyHomography(H, k.a);
    const lb = applyHomography(H, k.b);
    const measured = dist(la, lb);
    const rel = Math.abs(measured - k.length) / k.length;
    sumSq += rel * rel;
    if (rel > max) max = rel;
  }
  return {
    rmsError: Math.sqrt(sumSq / constraints.length) * 100,
    maxError: max * 100,
  };
}

/** Measure the real-world length (mm) of an image-space segment. */
export function measureLength(H: Matrix3, a: Point, b: Point): number {
  return dist(applyHomography(H, a), applyHomography(H, b));
}
