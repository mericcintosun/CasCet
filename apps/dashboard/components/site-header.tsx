"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ModeToggle } from "@/components/mode-toggle";
import { WalletConnectButton } from "@/components/wallet-connect-button";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/build", label: "Build" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/explorer", label: "Explorer" },
  { href: "/playground", label: "Playground" },
  { href: "/withdraw", label: "Withdraw" },
];

export function SiteHeader({ connected, showWallet }: { connected?: boolean; showWallet?: boolean }) {
  const pathname = usePathname();
  return (
    <header className="glass sticky top-0 z-20 border-b">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-6">
          <Link href="/">
            <Logo subtitle="Paid MCP · Testnet" />
          </Link>
          <nav className="flex items-center gap-1">
            {NAV.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  pathname === item.href
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {connected !== undefined && (
            <Badge variant={connected ? "success" : "secondary"} className="gap-1.5">
              <Activity className="h-3 w-3" />
              {connected ? "live" : "connecting…"}
            </Badge>
          )}
          {showWallet && <WalletConnectButton />}
          <ModeToggle />
        </div>
      </div>
    </header>
  );
}
