import { CLI_SPEC, CLI_VERSION } from "@/lib/connect-config";
import { cn } from "@/lib/utils";

/**
 * Why the generated commands pin one exact @cascet/cli release (finding M13),
 * and what to do while that release is not on npm yet.
 */
export function CliPinNote({ className }: { className?: string }) {
  return (
    <p className={cn("text-[11px] leading-relaxed text-muted-foreground", className)}>
      These commands pin <code>{CLI_SPEC}</code>, the first release with the payment-path security fixes; 0.1.0 is unsupported
      and ignores the allowlists and caps. If npx finds no matching version, {CLI_VERSION} is not on npm yet: run{" "}
      <code>node packages/cli/dist/cli.js</code> from a built CasCet checkout instead.
    </p>
  );
}
