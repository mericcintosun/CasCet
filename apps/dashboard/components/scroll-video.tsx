"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A scroll-scrubbed cinematic section: the video is pinned full-screen and its playhead is driven
 * by scroll position over a tall (`heightVh`) container, while `captions` cross-fade across the
 * scroll. Degrades gracefully to the poster image if the video is missing or can't scrub.
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
  const [progress, setProgress] = React.useState(0);
  const rafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.pause();
      // Ensure the first frame is decoded so scrubbing has something to show.
      video.currentTime = 0.001;
    }

    const update = () => {
      rafRef.current = null;
      const el = sectionRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const total = el.offsetHeight - window.innerHeight;
      const p = total > 0 ? Math.min(1, Math.max(0, -rect.top / total)) : 0;
      setProgress(p);
      const v = videoRef.current;
      if (v && v.duration && Number.isFinite(v.duration)) {
        const t = p * v.duration;
        if (Math.abs(v.currentTime - t) > 0.03) v.currentTime = t;
      }
    };

    const onScroll = () => {
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const n = captions.length;

  return (
    <section ref={sectionRef} className="relative" style={{ height: `${heightVh}vh` }}>
      <div className="sticky top-0 flex h-screen items-center justify-center overflow-hidden bg-[hsl(228_16%_4%)]">
        {/* poster underlay — visible before the video decodes or if it never loads */}
        <div
          className="absolute inset-0 bg-cover bg-center opacity-70"
          style={{ backgroundImage: `url(${poster})` }}
          aria-hidden
        />
        <video
          ref={videoRef}
          muted
          playsInline
          preload="auto"
          poster={poster}
          className={cn("absolute inset-0 h-full w-full object-cover opacity-90", videoClassName)}
          aria-hidden
        >
          <source src={src} type="video/mp4" />
        </video>

        {/* legibility scrims */}
        <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/30 to-background" />
        <div className="grain absolute inset-0" />

        {/* pinned captions */}
        <div className="relative mx-auto max-w-3xl px-6 text-center">
          {captions.map((c, i) => {
            const center = (i + 0.5) / n;
            const dist = Math.abs(progress - center);
            const opacity = Math.max(0, 1 - dist / (0.5 / n));
            const y = (progress - center) * -40;
            return (
              <div
                key={i}
                className="absolute inset-x-0 top-1/2 -translate-y-1/2"
                style={{ opacity, transform: `translateY(calc(-50% + ${y}px))`, pointerEvents: opacity > 0.5 ? "auto" : "none" }}
              >
                {c}
              </div>
            );
          })}
        </div>

        {/* scroll hint */}
        <div
          className="absolute bottom-8 left-1/2 -translate-x-1/2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground transition-opacity"
          style={{ opacity: progress < 0.06 ? 0.7 : 0 }}
        >
          scroll ↓
        </div>
      </div>
    </section>
  );
}
