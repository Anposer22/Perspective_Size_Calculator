# Calculadora de tamaños por perspectiva

Aplicación web (sin backend) para **medir el tamaño real de objetos en una foto**
a partir de un objeto de referencia de dimensiones conocidas.

It recovers the camera perspective using **vanishing points**: the user traces
edges along two perpendicular real-world directions on the flat surface. Those
lines determine the plane's **horizon** (line at infinity), which fixes the
projective distortion across the whole image. Because the two directions are
perpendicular, the plane is upgraded to a **metric** rectification, and one
known length per direction sets the scale. The result is accurate measurement
**everywhere on the plane**, even with an oblique camera — not just where the
calibration marks are.

## Usage

1. **Load an image**: paste with `Ctrl/Cmd+V` or upload a file.
2. **Calibrate**:
   - `+ Direction 1`: trace ≥2 edges that are parallel in the real world (e.g.
     the long edges of your objects).
   - `+ Direction 2`: trace ≥2 edges along the perpendicular direction.
   - Give at least one **known real length per direction**.
   - Make the lines **long and spread across the image** — short lines close
     together produce poor vanishing points and large errors.
3. **Measure**: trace segments anywhere on the same plane; the real length (mm)
   appears live.

### Controls

- **Click**: place a point (snaps to existing points to continue lines).
- **Drag a point**: move it (recalibrates/recomputes live).
- **Drag the image**: pan. Middle button or `Space` also pan.
- **Wheel**: zoom toward the cursor. A **magnifier loupe** aids sub-pixel aim.

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
