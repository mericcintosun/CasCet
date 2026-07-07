"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (x: number) => x * x * (3 - 2 * x);

/**
 * A scroll-scrubbed cinematic section. The video is pinned full-screen and its playhead follows
 * scroll — but smoothed: a persistent rAF loop eases the playhead toward the scroll target and
 * drives caption opacity by writing styles directly (no per-frame React re-render), so scrubbing
 * stays buttery even with coarse scroll events. Degrades to the poster if the video can't scrub.
 */
export function ScrollVideo({
  src,
  poster,
  captions,
  heightVh = 300,
  videoClassName,
}: {
  src: string;
  poster: string;
  captions: React.ReactNode[];
  heightVh?: number;
  videoClassName?: string;
}) {
  const sectionRef = React.useRef<HTMLDivElement>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const capRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const hintRef = React.useRef<HTMLDivElement>(null);
  const target = React.useRef(0);
  const current = React.useRef(0);

  React.useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.pause();
      const decodeFirst = () => {
        try {
          v.currentTime = 0.01;
        } catch {
          /* ignore */
        }
      };
      if (v.readyState >= 1) decodeFirst();
      else v.addEventListener("loadedmetadata", decodeFirst, { once: true });
    }

    const n = captions.length;
    let raf = 0;

    const measure = () => {
      const el = sectionRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const scrollable = el.offsetHeight - window.innerHeight;
      target.current = scrollable > 0 ? clamp(-rect.top / scrollable, 0, 1) : 0;
    };

    const loop = () => {
      // ease the playhead toward the scroll target
      current.current += (target.current - current.current) * 0.085;
      const p = current.current;

      const vid = videoRef.current;
      if (vid && vid.duration && Number.isFinite(vid.duration)) {
        const t = p * (vid.duration - 0.05);
        // only seek on a meaningful delta — repeated tiny seeks stutter
        if (Math.abs(vid.currentTime - t) > 0.015) {
          try {
            vid.currentTime = t;
          } catch {
            /* seeking not ready */
          }
        }
      }

      for (let i = 0; i < n; i++) {
        const el = capRefs.current[i];
        if (!el) continue;
        // distribute across the full scroll: first caption crisp at the top, last at the bottom
        const center = n > 1 ? i / (n - 1) : 0.5;
        const band = n > 1 ? 0.62 / (n - 1) : 1;
        const o = clamp(1 - Math.abs(p - center) / band, 0, 1);
        el.style.opacity = String(smoothstep(o));
        el.style.transform = `translateY(${(p - center) * -34}px)`;
      }

      if (hintRef.current) hintRef.current.style.opacity = p < 0.05 ? "0.7" : "0";

      raf = requestAnimationFrame(loop);
    };

    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [captions.length]);

  return (
    <section ref={sectionRef} className="relative" style={{ height: `${heightVh}vh` }}>
      <div className="sticky top-0 flex h-screen items-center justify-center overflow-hidden bg-[hsl(228_16%_4%)]">
        {/* poster underlay — shown until the video decodes / if it never loads */}
        <div className="absolute inset-0 bg-cover bg-center opacity-70" style={{ backgroundImage: `url(${poster})` }} aria-hidden />
        <video
          ref={videoRef}
          muted
          playsInline
          preload="auto"
          poster={poster}
          className={cn("absolute inset-0 h-full w-full object-cover", videoClassName)}
          aria-hidden
        >
          <source src={src} type="video/mp4" />
        </video>

        {/* legibility scrims */}
        <div className="absolute inset-0 bg-gradient-to-b from-background/55 via-background/25 to-background" />
        <div className="grain absolute inset-0" />

        {/* pinned captions — full-width stage so lines don't collapse per-word */}
        {captions.map((c, i) => (
          <div
            key={i}
            ref={el => {
              capRefs.current[i] = el;
            }}
            className="absolute inset-0 flex items-center justify-center px-6 will-change-[opacity,transform]"
            style={{ opacity: 0 }}
          >
            <div className="w-full max-w-4xl text-center">{c}</div>
          </div>
        ))}

        <div
          ref={hintRef}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground"
          style={{ opacity: 0.7 }}
        >
          scroll ↓
        </div>
      </div>
    </section>
  );
}
