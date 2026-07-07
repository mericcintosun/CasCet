"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Boxes } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ModeToggle } from "@/components/mode-toggle";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/explorer", label: "Explorer" },
];

export function SiteHeader({ connected }: { connected?: boolean }) {
  const pathname = usePathname();
  return (
    <header className="glass sticky top-0 z-10 border-b">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Boxes className="h-5 w-5" />
            </div>
            <div>
              <div className="font-semibold leading-tight">CasCet</div>
              <div className="text-[11px] leading-tight text-muted-foreground">Paid MCP · Casper Testnet</div>
            </div>
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
          <ModeToggle />
        </div>
      </div>
    </header>
  );
}
