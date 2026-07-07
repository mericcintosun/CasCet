"use client";

import * as React from "react";
import { Moon, Sun, Monitor } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

const ORDER = ["light", "dark", "system"] as const;
const ICON = { light: Sun, dark: Moon, system: Monitor };

/** Cycles light → dark → system. Avoids hydration mismatch by rendering after mount. */
export function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const current = (mounted ? theme : "system") as (typeof ORDER)[number];
  const Icon = ICON[current] ?? Monitor;

  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={`Theme: ${current}. Click to change.`}
      onClick={() => {
        const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
        setTheme(next);
      }}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
