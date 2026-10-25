'use client';

import { useEffect, useRef, type ReactNode, type CSSProperties } from 'react';

import './gradient-text.css';

type GradientTextProps = {
  children: ReactNode;
  colors?: string[];
  animationSpeed?: number;
  variant?: 'linear' | 'flow' | 'conic';
  angle?: number;
  scale?: number;
  yoyo?: boolean;
  glow?: number;
  className?: string;
  style?: CSSProperties;
};

export default function GradientText({
  children,
  colors = ['#5227FF', '#FF9FFC', '#B497CF'],
  animationSpeed = 8,
  variant = 'linear',
  angle = 90,
  scale = 3,
  yoyo = true,
  glow = 0,
  className = '',
  style,
}: GradientTextProps) {
  const colorsList = colors.length > 1 ? colors : [colors[0] ?? '#ffffff', colors[0] ?? '#ffffff'];

  return (
    <span
      className={`gradient-text gradient-text--${variant}${className ? ` ${className}` : ''}`}
      style={{
        '--gt-colors': colorsList.join(', '),
        '--gt-speed': `${Math.max(0.2, animationSpeed)}s`,
        '--gt-angle': `${angle}deg`,
        '--gt-scale': `${Math.max(1, Math.min(6, scale)) * 100}%`,
        '--gt-glow': Math.max(0, Math.min(1, glow)),
        ...style,
      } as React.CSSProperties}
    >
      {children}
    </span>
  );
}
