"use client";

import Link from "next/link";

import StarBorder from "./StarBorder";

// The conversion CTA of the landing hero: fuchsia surface (the palette's 10%
// share) with a white star orbiting it. It lives in a client component because
// the marketing page is a server component and Next's Link — a function — may
// only be passed as a prop between client components.
export function HeroCta({ as: As = Link, href = "/sign-up", children, ...props }) {
  return (
    <StarBorder
      as={As}
      href={href}
      color="#ffffff"
      trailColor="#ffffff"
      duration={4}
      glow={0.6}
      theme="dark"
      backgroundColor="var(--primary)"
      textColor="var(--primary-foreground)"
      className="text-sm font-medium"
      {...props}
    >
      {children}
    </StarBorder>
  );
}
