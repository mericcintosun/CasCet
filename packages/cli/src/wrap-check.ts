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

/** Every startup warning `cascet wrap` prints for a parsed config. */
export function wrapWarnings(cfg: Pick<CascetConfig, "payTo" | "network" | "asset" | "facilitator">): string[] {
  return [...payToWarnings(cfg), ...facilitatorWarnings(cfg)];
}

/**
 * Startup warning about a contract-package payTo (the schema stores one as
 * "01" + hex; a public key never gets this far). Every facilitator that exists
 * today runs @make-software/casper-x402 1.0.0, which settles any payTo as an
 * account hash, and CasCet buyers refuse such a payee.
 */
export function payToWarnings(cfg: Pick<CascetConfig, "payTo">): string[] {
  if (!cfg.payTo.startsWith("01")) return [];
  return [
    `WARNING: payTo ${cfg.payTo} is a contract package (e.g. a RevenueSplit), not an account hash. Facilitators ` +
      "built on @make-software/casper-x402 1.0.0 (the hosted one and CasCet's self-hosted one) settle every payTo as " +
      "an account hash, so this revenue would be credited to an account nobody controls, and CasCet buyers refuse to " +
      'pay a contract-package payee. Use your account hash ("npx @cascet/cli account-hash <public-key>") until a ' +
      "facilitator supports contract payees.",
  ];
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
