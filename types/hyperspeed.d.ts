import type { CSSProperties } from "react";

declare module "@/components/Hyperspeed" {
  interface HyperspeedProps {
    curve?: string;
    curvature?: number;
    speed?: number;
    boost?: number;
    fov?: number;
    boostFov?: number;
    lanes?: number;
    roadWidth?: number;
    medianWidth?: number;
    density?: number;
    trailLength?: number;
    lightSize?: number;
    poles?: number;
    poleHeight?: number;
    dust?: number;
    glow?: number;
    reflections?: number;
    steer?: number;
    tailColors?: string[];
    headColors?: string[];
    poleColors?: string[];
    roadColor?: string;
    roadOpacity?: number;
    lineColor?: string;
    background?: string;
    theme?: "dark" | "light";
    interactive?: boolean;
    boosting?: boolean;
    onBoostStart?: () => void;
    onBoostEnd?: () => void;
    className?: string;
    style?: CSSProperties;
  }

  export default function Hyperspeed(props: HyperspeedProps): JSX.Element;
}
