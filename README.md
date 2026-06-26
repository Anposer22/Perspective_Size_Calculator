# Perspective Size Calculator

A web app (no backend) to **measure the real size of objects in a photo** of a
flat surface, using objects of known size as references. Runs entirely in the
browser and deploys as a static Next.js app.

## How it works

You draw segments whose **real length** you know, distributed across the area
you want to measure. The app fits the image→world (mm) homography by
**regularized least squares**:

- It initializes with the best **affine** map (no perspective) from the known
  lengths: a length `L` of an image segment with displacement `d` satisfies
  `dᵀ S d = L²` for a symmetric 2×2 metric `S`.
- It then refines the full 8-DOF homography (Levenberg–Marquardt) to match the
  lengths, with a regularizer that pulls the perspective terms toward zero.

That regularizer makes the model **adapt automatically**: a near top-down photo
has no perspective to estimate, so the fit stays affine instead of overfitting
noise into a fake perspective; an oblique photo recovers perspective when the
data supports it. The header shows whether the result is `flat/affine` or
`perspective`.

## Usage

1. **Load an image**: paste with `Ctrl/Cmd+V` or upload a file.
2. **Calibrate** (`+ Known length`): trace at least **5** segments of known
   real length. Two rules matter for accuracy:
   - **Varied directions** (not all parallel).
   - **Spread across the whole area** you want to measure — references clustered
     in one spot give poor results far away (a fundamental limit of single-photo
     measurement, not a bug).
3. **Measure**: trace segments anywhere on the same plane; the real length (mm)
   appears live. A measure whose centre falls outside the area covered by your
   references is marked `?` (lower confidence).

### Controls

- **Click**: place a point (snaps to existing points to continue lines).
- **Drag a point**: move it (recalibrates/recomputes live).
- **Drag the image**: pan. Middle button or `Space` also pan.
- **Wheel**: zoom toward the cursor. A **magnifier loupe** aids sub-pixel aim.
- **Esc**: cancel the line currently being drawn.

## Accuracy

On synthetic tests with 2px clicking noise and references spread across the
frame, full-image error is **~1%** at any camera angle (top-down to strongly
oblique). It degrades to several percent if references are clustered together or
far from what you measure, and is only valid for objects on the **same flat
plane** as the references (height differences cause parallax error). Lens
distortion near image edges is not corrected.

## Development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build
```

Stack: Next.js 14 + TypeScript, `<canvas>` rendering, fully client-side.
The calibration math lives in `lib/homography.ts`.
