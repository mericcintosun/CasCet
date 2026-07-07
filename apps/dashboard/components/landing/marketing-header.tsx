"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Github } from "lucide-react";
import { Logo } from "@/components/logo";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#cascade", label: "Cascade" },
  { href: "#agent", label: "Agent" },
  { href: "/playground", label: "Playground" },
  { href: "#roadmap", label: "Roadmap" },
];

export function MarketingHeader() {
  const [scrolled, setScrolled] = React.useState(false);
  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-30 transition-colors duration-300",
        scrolled ? "glass border-b border-border" : "border-b border-transparent",
      )}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Link href="/" aria-label="CasCet home">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map(item => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link
            href="https://github.com/mericcintosun/CasCet"
            target="_blank"
            className="hidden h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:flex"
            aria-label="GitHub"
          >
            <Github className="h-[18px] w-[18px]" />
          </Link>
          <ModeToggle />
          <Button asChild size="sm" className="gap-1 font-medium">
            <Link href="/dashboard">
              Launch dashboard <ArrowUpRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
