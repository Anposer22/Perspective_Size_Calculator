// Metric rectification of a plane from a single oblique photo.
//
// The robust, photogrammetrically-correct way to measure on a plane seen at an
// angle is to recover the plane<->image homography from VANISHING POINTS:
//
//   1. The user draws >=2 lines along one real-world direction (they are
//      parallel in the world, e.g. the long edges of objects). Their image
//      lines intersect at vanishing point vp1.
//   2. >=2 lines along a second, perpendicular world direction -> vp2.
//   3. The line through vp1 and vp2 is the image of the plane's line at
//      infinity (the horizon). It determines the projective part of the
//      distortion, so we can "remove perspective" anywhere in the image.
//   4. Because the two directions are perpendicular in the world, we upgrade
//      from affine to metric (orthonormal) rectification.
//   5. Two known real lengths (one per direction) fix the scale in each axis,
//      resolving the remaining aspect-ratio ambiguity.
//
// Vanishing points are estimated from lines spread across the WHOLE image, so
// the perspective is captured globally and measurements are accurate everywhere
// on the plane - not just where the calibration marks happen to be.

export type Point = { x: number; y: number };
export type Matrix3 = number[]; // row-major length-9
type V3 = [number, number, number];

export const MIN_LINES_PER_DIRECTION = 2;

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

function matMul3(A: Matrix3, B: Matrix3): Matrix3 {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) C[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
  return C;
}

function lineOf(p: Point, q: Point): V3 {
  return cross([p.x, p.y, 1], [q.x, q.y, 1]);
}

// Jacobi eigendecomposition of a symmetric 3x3 matrix (row-major). Returns
// eigenvalues and their eigenvectors (as V3 columns). Robust and exact enough
// for our needs, with no conditioning issues.
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
      // Rotate rows/cols p,q of A.
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
      // Accumulate eigenvectors.
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

// Least-squares vanishing point: the point v minimizing sum (l_k . v)^2 over
// the (normalized) image lines l_k. That is the eigenvector of the smallest
// eigenvalue of M = sum l_k l_k^T.
function vanishingPoint(lines: { a: Point; b: Point }[]): V3 | null {
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let used = 0;
  for (const seg of lines) {
    let l = lineOf(seg.a, seg.b);
    const n = Math.hypot(l[0], l[1]);
    if (n < 1e-9) continue;
    l = [l[0] / n, l[1] / n, l[2] / n];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) M[i * 3 + j] += l[i] * l[j];
    used++;
  }
  if (used < 2) return null;
  const { val, vec } = symEig3(M);
  let mi = 0;
  if (val[1] < val[mi]) mi = 1;
  if (val[2] < val[mi]) mi = 2;
  return vec[mi];
}

function invert2x2(m: [number, number, number, number]): number[] | null {
  const [a, b, c, d] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det];
}

// --- calibration ------------------------------------------------------------

export type CalibLine = {
  a: Point;
  b: Point;
  dir: 1 | 2; // which real-world direction this line is parallel to
  length?: number; // known real length (mm), optional
};

export type CalibrationResult = {
  H: Matrix3; // image -> world (mm)
  rmsError: number; // RMS relative error (%) over known-length lines
  maxError: number;
  horizon: V3; // image of the plane's line at infinity (for visualization)
};

export type CalibrationStatus = {
  dir1Lines: number;
  dir2Lines: number;
  dir1HasLength: boolean;
  dir2HasLength: boolean;
  ready: boolean;
};

export function calibrationStatus(lines: CalibLine[]): CalibrationStatus {
  const d1 = lines.filter((l) => l.dir === 1);
  const d2 = lines.filter((l) => l.dir === 2);
  const dir1HasLength = d1.some((l) => (l.length ?? 0) > 0);
  const dir2HasLength = d2.some((l) => (l.length ?? 0) > 0);
  return {
    dir1Lines: d1.length,
    dir2Lines: d2.length,
    dir1HasLength,
    dir2HasLength,
    ready:
      d1.length >= MIN_LINES_PER_DIRECTION &&
      d2.length >= MIN_LINES_PER_DIRECTION &&
      dir1HasLength &&
      dir2HasLength,
  };
}

export function calibrate(lines: CalibLine[]): CalibrationResult | null {
  const status = calibrationStatus(lines);
  if (!status.ready) return null;

  // Hartley-normalize image coordinates for numerical stability, then do all of
  // the construction in normalized space and compose the normalization back in.
  const pts: Point[] = lines.flatMap((l) => [l.a, l.b]);
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
  const s0 = Math.SQRT2 / md;
  const T: Matrix3 = [s0, 0, -s0 * cx, 0, s0, -s0 * cy, 0, 0, 1];
  const nrm = (p: Point): Point => ({
    x: s0 * (p.x - cx),
    y: s0 * (p.y - cy),
  });
  const nLines: CalibLine[] = lines.map((l) => ({
    a: nrm(l.a),
    b: nrm(l.b),
    dir: l.dir,
    length: l.length,
  }));

  const d1 = nLines.filter((l) => l.dir === 1);
  const d2 = nLines.filter((l) => l.dir === 2);

  const vp1 = vanishingPoint(d1);
  const vp2 = vanishingPoint(d2);
  if (!vp1 || !vp2) return null;

  // Horizon (image of the line at infinity).
  const horizon = cross(vp1, vp2);

  // Projective rectification: send the horizon to infinity.
  const Hp: Matrix3 = [1, 0, 0, 0, 1, 0, horizon[0], horizon[1], horizon[2]];

  // After Hp the vanishing points become pure directions d1,d2 (their image
  // is [vp_x, vp_y, 0] because horizon . vp = 0). Normalize them.
  const dir1: [number, number] = [vp1[0], vp1[1]];
  const dir2: [number, number] = [vp2[0], vp2[1]];
  const n1 = Math.hypot(dir1[0], dir1[1]);
  const n2 = Math.hypot(dir2[0], dir2[1]);
  if (n1 < 1e-12 || n2 < 1e-12) return null;
  const u1: [number, number] = [dir1[0] / n1, dir1[1] / n1];
  const u2: [number, number] = [dir2[0] / n2, dir2[1] / n2];

  // Metric upgrade: map direction 1 -> x-axis and direction 2 -> y-axis, which
  // makes the (perpendicular) world directions orthonormal in the rectified
  // frame. A = inv([u1 u2]).
  const A = invert2x2([u1[0], u2[0], u1[1], u2[1]]);
  if (!A) return null; // directions collinear -> not two distinct directions
  const embedA: Matrix3 = [A[0], A[1], 0, A[2], A[3], 0, 0, 0, 1];

  // H0 maps image -> orthonormal-rectified plane (unknown per-axis scale).
  const H0 = matMul3(embedA, Hp);

  // Scales from known lengths: dir-1 lines lie along x after H0, dir-2 along y.
  const scaleFrom = (segs: CalibLine[]) => {
    let sum = 0;
    let n = 0;
    for (const s of segs) {
      if (!(s.length! > 0)) continue;
      const rect = dist(applyHomography(H0, s.a), applyHomography(H0, s.b));
      if (rect > 1e-9) {
        sum += s.length! / rect;
        n++;
      }
    }
    return n ? sum / n : null;
  };
  const sx = scaleFrom(d1);
  const sy = scaleFrom(d2);
  if (sx == null || sy == null) return null;

  const S: Matrix3 = [sx, 0, 0, 0, sy, 0, 0, 0, 1];
  // H0 and S work in normalized image space; compose normalization back so H
  // maps ORIGINAL image pixels -> world (mm).
  const H = matMul3(matMul3(S, H0), T);

  // Sanity: reject degenerate/non-finite results.
  if (H.some((x) => !Number.isFinite(x))) return null;

  // Error metrics over all known-length lines.
  let sumSq = 0;
  let max = 0;
  let count = 0;
  for (const l of lines) {
    if (!(l.length! > 0)) continue;
    const m = measureLength(H, l.a, l.b);
    const rel = Math.abs(m - l.length!) / l.length!;
    sumSq += rel * rel;
    if (rel > max) max = rel;
    count++;
  }

  // Transform the horizon line back to original image space (l_img = T^T l).
  const horizonImg: V3 = [
    T[0] * horizon[0] + T[3] * horizon[1] + T[6] * horizon[2],
    T[1] * horizon[0] + T[4] * horizon[1] + T[7] * horizon[2],
    T[2] * horizon[0] + T[5] * horizon[1] + T[8] * horizon[2],
  ];

  return {
    H,
    rmsError: count ? Math.sqrt(sumSq / count) * 100 : 0,
    maxError: max * 100,
    horizon: horizonImg,
  };
}
