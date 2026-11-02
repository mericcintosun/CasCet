import { TOKEN_SYMBOL, WCSPR_TOKEN_PACKAGE, X402_TOKEN_PACKAGE } from "./constants";
import type { AnchoredRecord, ReceiptToken } from "./registry-reader";

/**
 * Which token a receipt in the testnet ReceiptRegistry was paid in. A `record`
 * names no token, and the registry holds receipts in two: CasCet's Cep18X402,
 * the only token any testnet settlement used until 2026-11-01 (the DemoToken
 * has no transfer_with_authorization), and, since the real-payment demo
 * learned it on 2026-11-02, the official Wrapped CSPR. Both have the on-chain
 * symbol WCSPR and 9 decimals; only the package hash tells them apart.
 */

/** A record anchored before this time was paid in Cep18X402; a later one's token is read from its settlement. */
export const CEP18X402_ONLY_BEFORE = "2026-11-01T00:00:00Z";

/** The symbols of the tokens the registry's receipts are paid in, by package hash. */
const SYMBOLS: Readonly<Record<string, string>> = {
  [X402_TOKEN_PACKAGE]: TOKEN_SYMBOL,
  [WCSPR_TOKEN_PACKAGE]: "WCSPR",
};

/**
 * `tokenOf` for the testnet ReceiptRegistry: Cep18X402 for a record anchored
 * before {@link CEP18X402_ONLY_BEFORE}; otherwise the token its settlement
 * transaction paid in, as `readSettleToken` reads it from the chain (a token
 * other than the two above keeps its hash, with no symbol); undefined when
 * that cannot be read.
 */
export function testnetReceiptToken(
  readSettleToken: (txHash: string) => Promise<string | undefined>,
): (record: AnchoredRecord) => Promise<ReceiptToken | undefined> {
  const before = Date.parse(CEP18X402_ONLY_BEFORE);
  return async ({ txHash, anchoredAt }) => {
    if (Date.parse(anchoredAt) < before) return { packageHash: X402_TOKEN_PACKAGE, symbol: TOKEN_SYMBOL };
    const packageHash = await readSettleToken(txHash);
    if (packageHash === undefined) return undefined;
    return { packageHash, symbol: Object.hasOwn(SYMBOLS, packageHash) ? SYMBOLS[packageHash]! : "" };
  };
}
