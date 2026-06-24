# Calculadora de tamaños por perspectiva

Aplicación web (sin backend) para **medir el tamaño real de objetos en una foto**
a partir de un objeto de referencia de dimensiones conocidas.

Funciona corrigiendo la perspectiva del plano mediante una **homografía**: el
usuario traza varias líneas sobre objetos de tamaño conocido e indica su
longitud real. Con esas medidas se calibra todo el plano (mínimos cuadrados no
lineales) y se puede medir cualquier otro objeto que esté **en el mismo plano**.

## Uso

1. **Carga una imagen**: pégala con `Ctrl/Cmd+V` desde el portapapeles o súbela.
2. **Calibra**: pulsa "Añadir línea" y traza segmentos sobre medidas conocidas,
   indicando la longitud real de cada uno. No hace falta que formen un
   rectángulo. Hace falta un **mínimo de 6 líneas**; cuantas más y más variadas
   (distintas orientaciones y zonas de la imagen), mayor precisión.
3. **Mide**: traza segmentos entre dos puntos. La longitud real aparece en mm.

### Controles

- **Clic**: colocar un punto (en modo añadir/medir).
- **Arrastrar un punto**: moverlo (recalibra/recalcula en vivo).
- **Arrastrar la imagen**: desplazarse (pan). También botón central o `Espacio`.
- **Rueda**: zoom hacia el cursor.
- Una **lupa** aparece al colocar puntos para precisión sub-píxel.

## Precisión y limitaciones

- Precisión típica **±1–3%** con objetos coplanares, buena resolución y clics
  cuidadosos. Puede degradarse a ±5–10% en bordes, ángulos extremos o con
  distorsión de lente.
- **Importante:** solo es válido para objetos en el **mismo plano** que la
  referencia. Diferencias de altura introducen error por paralaje.
- El indicador de "error de calibración" (RMS) muestra cómo de bien encaja el
  modelo con las longitudes conocidas: úsalo como medida de fiabilidad.

## Desarrollo

```bash
npm install
npm run dev      # http://localhost:3000
npm run build
```

Stack: Next.js 14 + TypeScript, renderizado en `<canvas>`, todo en cliente.
La matemática de calibración está en `lib/homography.ts`.
