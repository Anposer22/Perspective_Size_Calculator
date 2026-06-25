// Stratified metric rectification of a plane from a single oblique photo.
//
// The user supplies two kinds of input, which are kept separate:
//
//   * PLANE LINES - segments drawn along straight features of the plane. Lines
//     that are parallel in the real world meet at a vanishing point in the
//     image. We auto-detect the families (no need to label directions, and they
//     need NOT be perpendicular), get >=2 vanishing points, and the line
//     through them is the plane's horizon (image of the line at infinity). That
//     fixes the projective distortion everywhere -> "where the plane is".
//
//   * SCALE LINES - segments of known real length. After the horizon removes
//     perspective, the plane is affine-rectified. A known length L of a segment
//     with affine displacement d satisfies  d^T S d = L^2  for a symmetric 2x2
//     matrix S (the metric). S is linear in its 3 entries, so >=3 scale lines in
//     varied directions determine it by least squares. Cholesky of S gives the
//     affine->metric upgrade. This sets "the size of the grid".
//
// Everything is done in Hartley-normalized image coordinates for stability.

export type Point = { x: number; y: number };
export type Matrix3 = number[]; // row-major length-9
type V3 = [number, number, number];

export const MIN_PLANE_LINES = 4; // >=2 families x >=2 lines
export const MIN_SCALE_LINES = 3;

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

// --- small linear algebra ---------------------------------------------------

function cross(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function det3(a: V3, b: V3, c: V3): number {
  return (
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    a[1] * (b[0] * c[2] - b[2] * c[0]) +
    a[2] * (b[0] * c[1] - b[1] * c[0])
  );
}

function matMul3(A: Matrix3, B: Matrix3): Matrix3 {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) C[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
  return C;
}

function normalize3(v: V3): V3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

// Jacobi eigendecomposition of a symmetric 3x3 (row-major).
function symEig3(M: number[]): { val: number[]; vec: V3[] } {
  const a = [
    [M[0], M[1], M[2]],
    [M[3], M[4], M[5]],
    [M[6], M[7], M[8]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 100; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-18) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      const apq = a[p][q];
      if (Math.abs(apq) < 1e-20) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * apq);
      const t =
        (theta >= 0 ? 1 : -1) /
        (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      a[p][p] -= t * apq;
      a[q][q] += t * apq;
      a[p][q] = a[q][p] = 0;
      for (let k = 0; k < 3; k++) {
        if (k === p || k === q) continue;
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = a[p][k] = c * akp - s * akq;
        a[k][q] = a[q][k] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return {
    val: [a[0][0], a[1][1], a[2][2]],
    vec: [
      [v[0][0], v[1][0], v[2][0]],
      [v[0][1], v[1][1], v[2][1]],
      [v[0][2], v[1][2], v[2][2]],
    ],
  };
}

function smallestEigvec(M: number[]): V3 {
  const { val, vec } = symEig3(M);
  let mi = 0;
  if (val[1] < val[mi]) mi = 1;
  if (val[2] < val[mi]) mi = 2;
  return vec[mi];
}

// Best-fit vanishing point of a set of lines: smallest eigenvector of sum l l^T.
function vanishingOf(lines: V3[]): V3 {
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const l of lines)
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) M[i * 3 + j] += l[i] * l[j];
  return smallestEigvec(M);
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

// --- types ------------------------------------------------------------------

export type PlaneLine = { a: Point; b: Point };
export type ScaleLine = { a: Point; b: Point; length: number };

export type CalibrationResult = {
  H: Matrix3; // image -> world (mm)
  rmsError: number;
  maxError: number;
  vanishingPoints: number; // how many families were detected
  horizon: V3; // image-space line, for visualization
};

export type CalibrationStatus = {
  planeLines: number;
  vanishingPoints: number;
  scaleLines: number;
  ready: boolean;
  reason?: string;
};

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

// --- vanishing-point families + horizon -------------------------------------

// Greedy consensus: repeatedly find the largest set of mutually-concurrent
// lines, take its vanishing point, remove it, repeat. Lines must already be in
// normalized coordinates. Returns vanishing points (homogeneous, normalized).
function detectVanishingPoints(linesN: V3[]): V3[] {
  const CONCURRENCY_T = 0.02; // |det| of three unit line vectors
  const remaining = linesN.map((_, i) => i);
  const vps: V3[] = [];
  const unit = linesN.map(normalize3);

  while (remaining.length >= 2 && vps.length < 6) {
    let bestSet: number[] = [];
    for (let ii = 0; ii < remaining.length; ii++) {
      for (let jj = ii + 1; jj < remaining.length; jj++) {
        const i = remaining[ii];
        const j = remaining[jj];
        const set = [i, j];
        for (const k of remaining) {
          if (k === i || k === j) continue;
          if (Math.abs(det3(unit[i], unit[j], unit[k])) < CONCURRENCY_T)
            set.push(k);
        }
        if (set.length > bestSet.length) bestSet = set;
      }
    }
    if (bestSet.length < 2) break;
    vps.push(normalize3(vanishingOf(bestSet.map((i) => linesN[i]))));
    const inSet = new Set(bestSet);
    for (let r = remaining.length - 1; r >= 0; r--)
      if (inSet.has(remaining[r])) remaining.splice(r, 1);
  }
  return vps;
}

function lineOfN(a: Point, b: Point): V3 {
  return cross([a.x, a.y, 1], [b.x, b.y, 1]);
}

// --- status -----------------------------------------------------------------

export function calibrationStatus(
  planeLines: PlaneLine[],
  scaleLines: ScaleLine[]
): CalibrationStatus {
  const base: CalibrationStatus = {
    planeLines: planeLines.length,
    vanishingPoints: 0,
    scaleLines: scaleLines.length,
    ready: false,
  };
  if (planeLines.length < 2) {
    base.reason = "Draw plane lines along straight edges of the surface.";
    return base;
  }
  const norm = normalization(planeLines.flatMap((l) => [l.a, l.b]));
  if (!norm) return base;
  const linesN = planeLines.map((l) =>
    lineOfN(norm.apply(l.a), norm.apply(l.b))
  );
  const vps = detectVanishingPoints(linesN);
  base.vanishingPoints = vps.length;
  if (vps.length < 2) {
    base.reason =
      "Need at least two sets of parallel plane lines (in different directions).";
    return base;
  }
  if (scaleLines.length < MIN_SCALE_LINES) {
    base.reason = `Add at least ${MIN_SCALE_LINES} known-length lines, in varied directions.`;
    return base;
  }
  base.ready = true;
  return base;
}

// --- calibration ------------------------------------------------------------

export function calibrate(
  planeLines: PlaneLine[],
  scaleLines: ScaleLine[]
): CalibrationResult | null {
  if (planeLines.length < 2 || scaleLines.length < MIN_SCALE_LINES) return null;

  const allPts = [
    ...planeLines.flatMap((l) => [l.a, l.b]),
    ...scaleLines.flatMap((l) => [l.a, l.b]),
  ];
  const norm = normalization(allPts);
  if (!norm) return null;

  // Horizon from plane-line vanishing points (in normalized space).
  const linesN = planeLines.map((l) =>
    lineOfN(norm.apply(l.a), norm.apply(l.b))
  );
  const vps = detectVanishingPoints(linesN);
  if (vps.length < 2) return null;
  // Fit the horizon as the line minimizing sum (l . vp)^2 over vanishing points.
  const Mh = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const vp of vps)
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) Mh[i * 3 + j] += vp[i] * vp[j];
  const horizon = smallestEigvec(Mh);

  // Projective rectification (normalized image -> affine).
  const Hp: Matrix3 = [1, 0, 0, 0, 1, 0, horizon[0], horizon[1], horizon[2]];

  // Fit the metric S from known lengths: row [dx^2, 2 dx dy, dy^2] . S = L^2.
  const A: number[][] = [];
  const rhs: number[] = [];
  for (const s of scaleLines) {
    if (!(s.length > 0)) continue;
    const pa = applyHomography(Hp, norm.apply(s.a));
    const pb = applyHomography(Hp, norm.apply(s.b));
    const dx = pa.x - pb.x;
    const dy = pa.y - pb.y;
    A.push([dx * dx, 2 * dx * dy, dy * dy]);
    rhs.push(s.length * s.length);
  }
  if (A.length < 3) return null;

  // Normal equations (A^T A) s = A^T b (least squares).
  const AtA = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const Atb = [0, 0, 0];
  for (let r = 0; r < A.length; r++) {
    for (let i = 0; i < 3; i++) {
      Atb[i] += A[r][i] * rhs[r];
      for (let j = 0; j < 3; j++) AtA[i][j] += A[r][i] * A[r][j];
    }
  }
  // Reject if the scale-line directions are not varied enough to pin all three
  // entries of S (e.g. all lengths lie along only two directions): the normal
  // matrix becomes rank-deficient and the metric would be arbitrary.
  const eig = symEig3(AtA.flat());
  const maxEv = Math.max(...eig.val.map(Math.abs));
  const minEv = Math.min(...eig.val.map(Math.abs));
  if (maxEv < 1e-12 || minEv / maxEv < 1e-4) return null;

  const Svec = solveLinearSystem(AtA, Atb);
  if (!Svec) return null;
  const [S11, S12, S22] = Svec;

  // S must be positive definite to be a valid metric.
  if (!(S11 > 0) || !(S11 * S22 - S12 * S12 > 0)) return null;

  // Cholesky-style upper factor M with M^T M = S (affine -> metric).
  const L11 = Math.sqrt(S11);
  const L12 = S12 / L11;
  const L22sq = S22 - L12 * L12;
  if (!(L22sq > 0)) return null;
  const L22 = Math.sqrt(L22sq);
  const embedM: Matrix3 = [L11, L12, 0, 0, L22, 0, 0, 0, 1];

  // Compose: image -> world(mm).
  const H = matMul3(matMul3(embedM, Hp), norm.T);
  if (H.some((x) => !Number.isFinite(x))) return null;

  // Error metrics over known-length lines.
  let sumSq = 0;
  let max = 0;
  let count = 0;
  for (const s of scaleLines) {
    if (!(s.length > 0)) continue;
    const m = measureLength(H, s.a, s.b);
    const rel = Math.abs(m - s.length) / s.length;
    sumSq += rel * rel;
    if (rel > max) max = rel;
    count++;
  }

  // Horizon back to image space (l_img = T^T l).
  const T = norm.T;
  const horizonImg: V3 = [
    T[0] * horizon[0] + T[3] * horizon[1] + T[6] * horizon[2],
    T[1] * horizon[0] + T[4] * horizon[1] + T[7] * horizon[2],
    T[2] * horizon[0] + T[5] * horizon[1] + T[8] * horizon[2],
  ];

  return {
    H,
    rmsError: count ? Math.sqrt(sumSq / count) * 100 : 0,
    maxError: max * 100,
    vanishingPoints: vps.length,
    horizon: horizonImg,
  };
}
