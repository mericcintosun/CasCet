import {
  DEFAULT_FACILITATOR_URL,
  DEFAULT_SELF_HOSTED_FACILITATOR_URL,
  isKnownCep3009Asset,
  type CascetConfig,
} from "@cascet/core";

/** Config issues reported by zod, one per line with its path. */
export function formatConfigIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues
    .map(issue => `  - ${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

/**
 * Startup warnings about the facilitator (M03): the hosted facilitator only
 * settles CEP-3009 `value` tokens, so pairing it with any other asset makes
 * every settlement revert.
 */
export function facilitatorWarnings(cfg: Pick<CascetConfig, "network" | "asset" | "facilitator">): string[] {
  let host: string;
  try {
    host = new URL(cfg.facilitator.url).hostname.toLowerCase();
  } catch {
    return [];
  }
  if (host !== new URL(DEFAULT_FACILITATOR_URL).hostname) return [];
  const warnings: string[] = [];
  if (!isKnownCep3009Asset(cfg.network, cfg.asset.packageHash)) {
    warnings.push(
      `WARNING: facilitator.url is the hosted facilitator (${DEFAULT_FACILITATOR_URL}), which only settles CEP-3009 ` +
        `tokens whose transfer_with_authorization takes \`value\` (e.g. the official Wrapped CSPR). asset ` +
        `${cfg.asset.packageHash} on ${cfg.network} is not known to be one. CasCet's own x402 token takes \`amount\`, ` +
        "so every settlement there reverts (User error: 64658). Point facilitator.url at a self-hosted facilitator " +
        `(default ${DEFAULT_SELF_HOSTED_FACILITATOR_URL}) or switch to a CEP-3009 asset.`,
    );
  }
  if (!cfg.facilitator.apiKey) {
    warnings.push("WARNING: the hosted facilitator needs a CSPR.cloud access token in facilitator.apiKey.");
  }
  return warnings;
}
