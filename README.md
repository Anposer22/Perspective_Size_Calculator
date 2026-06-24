# Calculadora de tamaños por perspectiva

Aplicación web (sin backend) para **medir el tamaño real de objetos en una foto**
a partir de un objeto de referencia de dimensiones conocidas.

Funciona corrigiendo la perspectiva del plano mediante una **homografía**: el
usuario marca las 4 esquinas de un objeto rectangular conocido e introduce su
ancho y alto reales; con eso se calibra todo el plano y se puede medir cualquier
otro objeto que esté **en el mismo plano**.

## Uso

1. **Carga una imagen**: pégala con `Ctrl/Cmd+V` desde el portapapeles o súbela.
2. **Calibra**: pulsa "Marcar esquinas" y haz clic en las 4 esquinas del objeto
   rectangular conocido (en orden: sup-izq, sup-der, inf-der, inf-izq).
   Introduce su ancho y alto reales en mm.
3. **(Opcional) Referencias extra**: añade más segmentos de longitud conocida
   para afinar la precisión. La homografía se reajusta por mínimos cuadrados.
4. **Mide**: traza segmentos entre dos puntos. La longitud real aparece en mm.

### Atajos

- Rueda del ratón: **zoom** (hacia el cursor).
- Arrastrar con `Espacio` o botón central: **mover** (pan).
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
