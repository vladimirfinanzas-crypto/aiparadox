"use client";

import Hyperspeed from "./Hyperspeed";

/**
 * Fondo cinematico Hyperspeed para toda la landing.
 * - fixed: una sola instancia WebGL cubre hero + secciones (smooth, sin cortes).
 * - Los props son los que pediste (winding, 4 carriles, boost x3...).
 * - roadOpacity 0.1 + velos de marca para que "belongs to the design":
 *   la animacion respira detras del contenido, nunca compite con el texto.
 * - interactive: el wrapper mantiene pointer-events; los velos no, para que
 *   mantener presionado sobre el hero (areas sin contenido) acelere la escena.
 */
export function LandingHyperspeedBackground() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-background">
      <div className="pointer-events-auto absolute inset-0">
        <Hyperspeed
          curve="winding"
          curvature={1.35}
          speed={1}
          boost={3}
          fov={70}
          boostFov={130}
          lanes={4}
          roadWidth={13}
          medianWidth={2}
          density={85}
          trailLength={2.15}
          lightSize={1}
          poles={30}
          dust={410}
          glow={0.85}
          reflections={0.7}
          roadOpacity={0.14}
          steer={1}
          tailColors={["#5926ff", "#6750a2", "#8b1af8"]}
          headColors={["#0353c3", "#0e5ea5", "#324555"]}
          poleColors={["#ffffff"]}
          interactive
        />
      </div>

      {/* Velo de marca: funde la autopista con el fondo space-gray + cobalt */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background/60 via-background/25 to-background/65" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_55%_at_50%_38%,transparent_0%,var(--background)_85%)]" />
      {/* Viñeta lateral para legibilidad del hero */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,var(--background)_0%,transparent_32%,transparent_68%,var(--background)_100%)] opacity-55" />
      {/* Tinte electric-blue muy sutil para que los trails violeta/azul pertenezcan a la paleta */}
      <div className="pointer-events-none absolute inset-0 bg-primary/[0.04] mix-blend-overlay" />
    </div>
  );
}
