import {
  DEFAULT_FACILITATOR_NAME,
  DEFAULT_FACILITATOR_URL,
  DEFAULT_SELF_HOSTED_FACILITATOR_URL,
  isHostedFacilitatorUrl,
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
export function wrapWarnings(
  cfg: Pick<CascetConfig, "payTo" | "network" | "asset" | "facilitator"> & Partial<Pick<CascetConfig, "assets" | "facilitators">>,
): string[] {
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
 * Startup warnings about the facilitators (M03): the hosted facilitator only
 * settles CEP-3009 `value` tokens, so pairing it with any other asset makes
 * every settlement revert. Each asset is checked against its own facilitator.
 */
export function facilitatorWarnings(
  cfg: Pick<CascetConfig, "network" | "asset" | "facilitator"> & Partial<Pick<CascetConfig, "assets" | "facilitators">>,
): string[] {
  const warnings: string[] = [];
  const keyless = new Set<string>();
  for (const asset of cfg.assets ?? [cfg.asset]) {
    const name = asset.facilitator ?? DEFAULT_FACILITATOR_NAME;
    const named = cfg.facilitators && Object.hasOwn(cfg.facilitators, name) ? cfg.facilitators[name] : undefined;
    const facilitator = named ?? cfg.facilitator;
    if (!isHostedFacilitatorUrl(facilitator.url)) continue;
    const field = name === DEFAULT_FACILITATOR_NAME ? "facilitator" : `facilitators.${name}`;
    if (!isKnownCep3009Asset(cfg.network, asset.packageHash)) {
      warnings.push(
        `WARNING: ${field}.url is the hosted facilitator (${DEFAULT_FACILITATOR_URL}), which only settles CEP-3009 ` +
          `tokens whose transfer_with_authorization takes \`value\` (e.g. the official Wrapped CSPR). asset ` +
          `${asset.packageHash} on ${cfg.network} is not known to be one. CasCet's own x402 token takes \`amount\`, ` +
          `so every settlement there reverts (User error: 64658). Point ${field}.url at a self-hosted facilitator ` +
          `(default ${DEFAULT_SELF_HOSTED_FACILITATOR_URL}) or switch to a CEP-3009 asset.`,
      );
    }
    if (!facilitator.apiKey) keyless.add(field);
  }
  for (const field of keyless) {
    warnings.push(`WARNING: the hosted facilitator needs a CSPR.cloud access token in ${field}.apiKey.`);
  }
  return warnings;
}
