import { readFile } from "node:fs/promises";
import type { ClientCasperSigner } from "@x402/casper";
import { ExactCasperScheme } from "@x402/casper/exact/client";
import type { SchemeNetworkClient } from "@x402/core/types";
import casperSdk from "casper-js-sdk";

const { KeyAlgorithm, PrivateKey } = casperSdk;

export type CasperKeyAlgorithm = "ed25519" | "secp256k1";

/**
 * A `ClientCasperSigner` for @x402/casper from a PEM private key, built with
 * this package's casper-js-sdk. The signer is a plain object on purpose:
 * @x402/casper pins its own casper-js-sdk (5.1.1), so no casper-js-sdk class
 * instance crosses into it.
 */
export function clientSignerFromPem(pem: string, algorithm: CasperKeyAlgorithm = "ed25519"): ClientCasperSigner {
  const key = PrivateKey.fromPem(pem, algorithm === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519);
  const accountAddress = `00${key.publicKey.accountHash().toHex()}`;
  const publicKey = key.publicKey.toHex();
  return {
    accountAddress: () => accountAddress,
    publicKey: () => publicKey,
    signEIP712: async digest => key.signAndAddAlgorithmBytes(digest),
  };
}

/** {@link clientSignerFromPem} for a PEM key file. */
export async function loadClientSigner(privateKeyPath: string, algorithm: CasperKeyAlgorithm = "ed25519"): Promise<ClientCasperSigner> {
  return clientSignerFromPem(await readFile(privateKeyPath, "utf8"), algorithm);
}

/**
 * @x402/casper's exact client scheme, without `findDefaultAsset`.
 *
 * Both authorization styles verify the same EIP-712 TransferWithAuthorization
 * message (signed over `value`), so one scheme pays legacy-amount and
 * cep3009-value tokens alike. `findDefaultAsset` is left out because x402's
 * spend controls treat every asset it recognizes (csprUSD) as allowed by
 * default; CasCet's SpendPolicy decides which assets a buyer pays in.
 */
export function createCasperClientScheme(signer: ClientCasperSigner): SchemeNetworkClient {
  const inner = new ExactCasperScheme(signer);
  return {
    scheme: inner.scheme,
    createPaymentPayload: (x402Version, requirements) => inner.createPaymentPayload(x402Version, requirements),
  };
}
