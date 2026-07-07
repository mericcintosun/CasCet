import { ScrollVideo } from "@/components/scroll-video";
import { LogoMark } from "@/components/logo";

/** The homepage cinematic opener — a scroll-scrubbed <ScrollVideo> with CasCet copy. */
export function CinematicIntro() {
  return (
    <ScrollVideo
      src="/cascade-scrub.mp4"
      poster="/hero.png"
      heightVh={300}
      // Crop ~16% off the bottom (anchored to the top) to hide any generator watermark
      // baked into the lower edge of the source clip.
      videoClassName="absolute left-0 top-0 h-[120%] w-full object-cover object-top"
      captions={[
        <p key="c1" className="text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
          Thousands of AI tools. <span className="text-muted-foreground">Almost all of them free.</span>
        </p>,
        <p key="c2" className="text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
          Because nobody could charge an agent <span className="text-gradient">— per call.</span>
        </p>,
        <div key="c3" className="flex flex-col items-center gap-4">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/15 p-3 text-primary ring-1 ring-primary/25">
            <LogoMark />
          </span>
          <span className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">Introducing</span>
          <span className="text-6xl font-semibold tracking-tight lg:text-8xl">CasCet</span>
          <span className="max-w-md text-balance text-base text-muted-foreground lg:text-lg">
            Payments that cascade — x402 micropayments for MCP on Casper.
          </span>
        </div>,
      ]}
    />
  );
}
