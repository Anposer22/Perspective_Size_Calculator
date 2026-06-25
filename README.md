# Calculadora de tamaños por perspectiva

Aplicación web (sin backend) para **medir el tamaño real de objetos en una foto**
a partir de un objeto de referencia de dimensiones conocidas.

It uses **stratified metric rectification**, splitting calibration into two
independent steps:

- **Fix the plane (perspective).** Trace lines along straight edges of the
  surface. Lines that are parallel in the real world meet at a vanishing point;
  the app auto-detects these families (no labelling, and they need **not** be
  perpendicular). Two or more vanishing points give the plane's **horizon**,
  which removes the projective distortion across the whole image.
- **Set the scale (size).** Trace segments of known real length. After the
  horizon the plane is affine-rectified; a known length L of a segment with
  affine displacement `d` satisfies `dᵀ S d = L²` for a symmetric metric matrix
  `S`. Three+ lengths in varied directions determine `S` by least squares; its
  Cholesky factor upgrades the plane to true metric.

The result is accurate measurement **everywhere on the plane**, even with an
oblique camera.

## Usage

1. **Load an image**: paste with `Ctrl/Cmd+V` or upload a file.
2. **Fix the plane** (`+ Plane line`): trace lines along straight edges of the
   surface, giving at least **two different directions** (auto-detected; need
   not be perpendicular). Longer, well-separated lines are best.
3. **Set the scale** (`+ Scale line`): trace at least **3 known-length
   segments in varied directions**. For rectangular objects, include a
   **diagonal** so the metric is fully pinned (two perpendicular directions
   alone leave it underdetermined).
4. **Measure**: trace segments anywhere on the same plane; the real length (mm)
   appears live.

### Controls

- **Click**: place a point (snaps to existing points to continue lines).
- **Drag a point**: move it (recalibrates/recomputes live).
- **Drag the image**: pan. Middle button or `Space` also pan.
- **Wheel**: zoom toward the cursor. A **magnifier loupe** aids sub-pixel aim.
- **Esc**: cancel the line currently being drawn.

## Accuracy

On synthetic oblique-camera tests with 2px clicking noise and calibration lines
spread across the frame, full-image measurement error is **~0.3–1%** (median),
including diagonals far from the calibration marks. Errors grow if the
calibration lines for a direction are short and clustered together.

## Limitations

- Valid only for objects on the **same flat plane** as the calibration lines.
  Height differences introduce parallax error.
- Lens distortion (especially phone wide-angle near image edges) is not
  corrected and adds a few percent.
- The "fit error" (RMS) shows how well the model matches the known lengths; it
  is a useful but partial reliability indicator.

## Development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build
```

Stack: Next.js 14 + TypeScript, `<canvas>` rendering, fully client-side.
The calibration math lives in `lib/homography.ts`.
