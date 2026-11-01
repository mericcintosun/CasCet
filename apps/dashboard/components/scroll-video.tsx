"use client";

import * as React from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (x: number) => x * x * (3 - 2 * x);

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const prefersReducedMotion = (): boolean => typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION).matches;

/** True when the visitor asked the OS for reduced motion; follows live changes. False during SSR. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia(REDUCED_MOTION);
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

/**
 * A scroll-scrubbed cinematic section: the video is pinned full-screen and its
 * playhead follows scroll, eased by a rAF loop that writes styles directly (no
 * per-frame React render).
 *
 * Cost control (finding M31):
 * - nothing of the 7.5 MB clip is downloaded on load: the video gets its source
 *   only once the section is near the viewport AND the visitor scrolls (the
 *   scrub needs the clip only then). Until then the optimised poster image is
 *   the visual. Even preload="metadata" made Chrome fetch ~1.6 MB up front;
 * - the rAF loop runs only while the section is on screen AND the playhead is
 *   still easing toward the scroll target; it stops when idle or offscreen;
 * - with prefers-reduced-motion the section is static: poster plus the captions
 *   stacked, no video download, no 450vh scroll track (CSS handles the first
 *   paint, the effect skips the video).
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
  const sectionRef = React.useRef<HTMLElement>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const capRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const reducedMotion = usePrefersReducedMotion();
  const [videoSrc, setVideoSrc] = React.useState<string | null>(null);

  // 1. Attach the source once the section is within a viewport of the screen and the visitor scrolls.
  React.useEffect(() => {
    if (reducedMotion || videoSrc) return;
    const el = sectionRef.current;
    if (!el) return;
    let near = false;
    const maybeLoad = () => {
      // Read the media query directly: the hook's state may not have caught up on the first frame.
      if (near && window.scrollY > 0 && !prefersReducedMotion()) setVideoSrc(src);
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        near = Boolean(entry?.isIntersecting);
        maybeLoad();
      },
      { rootMargin: "100% 0px" },
    );
    io.observe(el);
    window.addEventListener("scroll", maybeLoad, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", maybeLoad);
    };
  }, [src, reducedMotion, videoSrc]);

  // 2. Scrub loop, only while visible and moving.
  React.useEffect(() => {
    if (reducedMotion || prefersReducedMotion()) return;
    const section = sectionRef.current;
    if (!section) return;
    const n = captions.length;
    let target = 0;
    let current = 0;
    let raf = 0;
    let visible = false;

    const measure = () => {
      const rect = section.getBoundingClientRect();
      const scrollable = section.offsetHeight - window.innerHeight;
      target = scrollable > 0 ? clamp(-rect.top / scrollable, 0, 1) : 0;
    };

    const apply = (p: number) => {
      const vid = videoRef.current;
      if (vid && vid.duration && Number.isFinite(vid.duration)) {
        const t = p * (vid.duration - 0.05);
        // only seek on a meaningful delta: repeated tiny seeks stutter
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
        // first caption crisp at the top of the track, last at the bottom
        const center = n > 1 ? i / (n - 1) : 0.5;
        const band = n > 1 ? 0.62 / (n - 1) : 1;
        const o = clamp(1 - Math.abs(p - center) / band, 0, 1);
        el.style.opacity = String(smoothstep(o));
        el.style.transform = `translateY(${(p - center) * -34}px)`;
      }
    };

    const frame = () => {
      raf = 0;
      current += (target - current) * 0.085;
      if (Math.abs(target - current) < 0.0005) current = target;
      apply(current);
      if (visible && current !== target) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (visible && !raf) raf = requestAnimationFrame(frame);
    };
    const onScroll = () => {
      if (!visible) return;
      measure();
      kick();
    };

    const io = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible) {
        measure();
        kick();
      } else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    });
    io.observe(section);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    // Once metadata arrives, show the frame for the current scroll position.
    const vid = videoRef.current;
    const onMeta = () => apply(current);
    vid?.addEventListener("loadedmetadata", onMeta);

    measure();
    current = target;
    apply(current);

    return () => {
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      vid?.removeEventListener("loadedmetadata", onMeta);
    };
  }, [captions.length, reducedMotion, videoSrc]);

  return (
    <section
      ref={sectionRef}
      className="relative h-[var(--sv-height)] motion-reduce:!h-auto"
      style={{ "--sv-height": `${heightVh}vh` } as React.CSSProperties}
    >
      <div className="sticky top-0 flex h-screen items-center justify-center overflow-hidden bg-[hsl(228_16%_4%)] motion-reduce:static motion-reduce:h-auto motion-reduce:min-h-[70vh] motion-reduce:flex-col motion-reduce:gap-16 motion-reduce:py-24">
        {/* optimised poster underlay (the LCP image): shown until the video decodes, and the only visual with reduced motion */}
        <div className="absolute inset-0">
          <Image src={poster} alt="" fill priority sizes="100vw" className="object-cover object-center opacity-70" />
        </div>
        {!reducedMotion && (
          <video
            ref={videoRef}
            muted
            playsInline
            // No source (and nothing fetched) until the visitor scrolls; then buffer the clip for scrubbing.
            preload={videoSrc ? "auto" : "none"}
            src={videoSrc ?? undefined}
            className={cn("absolute inset-0 h-full w-full bg-transparent object-cover motion-reduce:hidden", videoClassName)}
            aria-hidden
          />
        )}

        {/* legibility scrims: the stage is dark in both themes (dark clip, light captions), and its
            bottom edge fades into the page background */}
        <div className="absolute inset-0 bg-gradient-to-b from-[hsl(228_16%_5%/0.55)] via-[hsl(228_16%_5%/0.35)] to-[hsl(228_16%_5%/0.7)]" />
        <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-background" />
        <div className="grain absolute inset-0" />

        {/* pinned captions; full-width stage so lines don't collapse per-word. Static and stacked with reduced motion. */}
        {captions.map((c, i) => (
          <div
            key={i}
            ref={(el) => {
              capRefs.current[i] = el;
            }}
            className="absolute inset-0 flex items-center justify-center px-6 will-change-[opacity,transform] motion-reduce:relative motion-reduce:inset-auto motion-reduce:!transform-none motion-reduce:!opacity-100"
            // The first caption is the one visible at scroll position 0, so it is
            // rendered visible (no blank hero before JS runs, L100).
            style={{ opacity: i === 0 ? 1 : 0 }}
          >
            {/* `dark` scopes the dark-theme tokens to the captions, so they stay light on the dark stage in light mode too */}
            <div className="dark w-full max-w-4xl text-center text-foreground">{c}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
