"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ModeToggle } from "@/components/mode-toggle";
import { WalletConnectButton } from "@/components/wallet-connect-button";
import { Logo } from "@/components/logo";
import { OnchainStatusBadge } from "@/components/onchain-status";
import { MobileMenuButton, MobileMenuPanel, mobileMenuLinkClass, useMobileMenu } from "@/components/mobile-menu";
import type { OnchainStatus } from "@/lib/onchain";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/build", label: "Build" },
  { href: "/connect", label: "Connect" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/explorer", label: "Explorer" },
  { href: "/playground", label: "Playground" },
  { href: "/withdraw", label: "Withdraw" },
];

/**
 * App header. From `md` up the nav sits inline; below `md` it collapses into a
 * disclosure menu so logo, status, wallet and theme toggle always fit a 375 px
 * screen (finding M28).
 */
export function SiteHeader({ status, showWallet }: { status?: OnchainStatus; showWallet?: boolean }) {
  const pathname = usePathname();
  const menu = useMobileMenu("md");

  return (
    <header className="glass sticky top-0 z-20 border-b">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-6">
          <Link href="/" aria-label="CasCet home" className="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Logo subtitle="Paid MCP · Testnet" subtitleClassName="hidden sm:block" />
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {status && <OnchainStatusBadge status={status} />}
          {showWallet && <WalletConnectButton />}
          <ModeToggle />
          <MobileMenuButton menu={menu} />
        </div>
      </div>
      <MobileMenuPanel menu={menu} label="Main">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={mobileMenuLinkClass(active)}
              onClick={() => menu.setOpen(false)}
            >
              {item.label}
            </Link>
          );
        })}
      </MobileMenuPanel>
    </header>
  );
}
