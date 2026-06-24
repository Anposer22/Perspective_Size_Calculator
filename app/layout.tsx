import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Calculadora de tamaños por perspectiva",
  description:
    "Calibra una imagen con un objeto de dimensiones conocidas y mide otros objetos en el mismo plano.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
