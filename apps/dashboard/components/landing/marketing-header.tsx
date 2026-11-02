"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Github } from "lucide-react";
import { Logo } from "@/components/logo";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { MobileMenuButton, MobileMenuItem, MobileMenuPanel, useMobileMenu } from "@/components/mobile-menu";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#start", label: "Get started" },
  { href: "#cascade", label: "Cascade" },
  { href: "#agent", label: "Agent" },
  { href: "/playground", label: "Playground" },
  { href: "#roadmap", label: "Roadmap" },
];

/**
 * In-page anchors stay plain <a>; routes go through next/link (no full reload, I29).
 * Extra props (className, onClick from a Button rendered asChild) reach the element.
 */
function NavLink({ href, ...props }: { href: string } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return href.startsWith("#") ? <a href={href} {...props} /> : <Link href={href} {...props} />;
}

export function MarketingHeader() {
  const [scrolled, setScrolled] = React.useState(false);
  // The six-item nav needs ~840 px, so it is inline only from lg; below that it folds into the menu (L88).
  const menu = useMobileMenu("lg");
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
        scrolled || menu.open ? "glass border-b border-border" : "border-b border-transparent",
      )}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/" aria-label="CasCet home" className="shrink-0">
          <Logo />
        </Link>
        <nav aria-label="Sections" className="hidden items-center gap-1 lg:flex">
          {NAV.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="https://github.com/mericcintosun/CasCet"
            target="_blank"
            rel="noreferrer"
            className="hidden h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:flex"
            aria-label="GitHub"
          >
            <Github className="h-[18px] w-[18px]" />
          </Link>
          <ModeToggle />
          <Button asChild size="sm" className="gap-1 font-medium">
            <Link href="/dashboard">
              <span className="sm:hidden">Dashboard</span>
              <span className="hidden sm:inline">Launch dashboard</span>
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </Button>
          <MobileMenuButton menu={menu} />
        </div>
      </div>
      <MobileMenuPanel menu={menu} label="Sections">
        {NAV.map((item) => (
          <MobileMenuItem key={item.href} menu={menu}>
            <NavLink href={item.href}>{item.label}</NavLink>
          </MobileMenuItem>
        ))}
      </MobileMenuPanel>
    </header>
  );
}
