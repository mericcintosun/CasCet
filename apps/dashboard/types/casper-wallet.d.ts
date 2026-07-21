// Casper Wallet browser-extension provider (injected on `window`, asynchronously).
export {};

interface CasperWalletProviderInstance {
  requestConnection(): Promise<boolean>;
  disconnectFromSite(): Promise<boolean>;
  isConnected(): Promise<boolean>;
  getActivePublicKey(): Promise<string>;
  getVersion(): Promise<string>;
  sign(
    deployJson: string,
    signingPublicKeyHex: string,
  ): Promise<{ cancelled: boolean; signatureHex?: string; signature?: Uint8Array }>;
}

interface CasperWalletEventTypes {
  Connected: string;
  Disconnected: string;
  ActiveKeyChanged: string;
  Locked: string;
  Unlocked: string;
}

declare global {
  interface Window {
    CasperWalletProvider?: (options?: { timeout?: number }) => CasperWalletProviderInstance;
    CasperWalletEventTypes?: CasperWalletEventTypes;
  }
}
