"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Mobile navigation as a WAI-ARIA disclosure: a shadcn Button (aria-expanded /
 * aria-controls) toggles a panel of links under the header row. Escape closes
 * it and returns focus to the button; a click outside, a route change or
 * growing past the breakpoint closes it. No dialog dependency needed.
 */
type Breakpoint = "md" | "lg";

// Literal class names so Tailwind's scanner generates them.
const HIDE_FROM: Record<Breakpoint, string> = { md: "md:hidden", lg: "lg:hidden" };
const MIN_WIDTH: Record<Breakpoint, string> = { md: "(min-width: 768px)", lg: "(min-width: 1024px)" };

export interface MobileMenu {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  id: string;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  panelRef: React.RefObject<HTMLDivElement | null>;
  hideClass: string;
}

export function useMobileMenu(breakpoint: Breakpoint = "md"): MobileMenu {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  React.useEffect(() => {
    if (!open) return;
    const close = (refocus: boolean) => {
      setOpen(false);
      if (refocus) buttonRef.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && !panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) close(false);
    };
    const mq = window.matchMedia(MIN_WIDTH[breakpoint]);
    const onResize = () => {
      if (mq.matches) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    mq.addEventListener("change", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      mq.removeEventListener("change", onResize);
    };
  }, [open, breakpoint]);

  return { open, setOpen, id, buttonRef, panelRef, hideClass: HIDE_FROM[breakpoint] };
}

export function MobileMenuButton({ menu, className }: { menu: MobileMenu; className?: string }) {
  return (
    <Button
      ref={menu.buttonRef}
      type="button"
      variant="outline"
      size="icon"
      className={cn(menu.hideClass, className)}
      aria-expanded={menu.open}
      aria-controls={menu.id}
      aria-label={menu.open ? "Close menu" : "Open menu"}
      onClick={() => menu.setOpen((o) => !o)}
    >
      {menu.open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
    </Button>
  );
}

/** The collapsible panel; render it after the header row. Hidden (not just invisible) while closed. */
export function MobileMenuPanel({
  menu,
  label,
  children,
}: {
  menu: MobileMenu;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div id={menu.id} ref={menu.panelRef} hidden={!menu.open} className={cn("border-t border-border", menu.hideClass)}>
      {menu.open && (
        <nav aria-label={label} className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3 sm:px-6">
          {children}
        </nav>
      )}
    </div>
  );
}

/** One link row inside the mobile panel. */
export const mobileMenuLinkClass = (active: boolean): string =>
  cn(
    "rounded-md px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
  );
