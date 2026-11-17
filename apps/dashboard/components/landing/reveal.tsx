"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Fades + lifts children into view on first scroll intersection.
 *
 * The content is server-rendered visible (L100). Only once this effect runs is
 * an element that is still below the fold hidden ("reveal-armed") until it
 * scrolls in. Without JavaScript, or when hydration fails, every section stays
 * readable. An element already on screen at hydration is left alone, so nothing
 * the visitor is looking at flashes out and back in.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  as?: React.ElementType;
}) {
  const ref = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) return;
    el.classList.add("reveal-armed");
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.classList.add("in");
          io.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag ref={ref} className={cn("reveal", className)} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </Tag>
  );
}
