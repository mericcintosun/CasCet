"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ProviderInstance = ReturnType<NonNullable<Window["CasperWalletProvider"]>>;

const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Thin hook over the Casper Wallet extension provider (injected async on window).
 * Handles connect / active-key / lock events; exposes a `signTx` used by the
 * withdraw flow (server prepares the tx, wallet signs, server submits).
 */
export function useCasperWallet() {
  const provider = useRef<ProviderInstance | null>(null);
  const [installed, setInstalled] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [publicKeyHex, setPublicKeyHex] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const getProvider = useCallback((): ProviderInstance | null => {
    if (typeof window === "undefined" || !window.CasperWalletProvider) return null;
    if (!provider.current) provider.current = window.CasperWalletProvider({ timeout: 30 * 60 * 1000 });
    return provider.current;
  }, []);

  // The extension injects asynchronously — poll briefly for it.
  useEffect(() => {
    let tries = 0;
    const id = setInterval(() => {
      if (typeof window !== "undefined" && window.CasperWalletProvider) {
        setInstalled(true);
        clearInterval(id);
      } else if (++tries > 40) {
        clearInterval(id);
      }
    }, 100);
    return () => clearInterval(id);
  }, []);

  // React to wallet lock / account-switch / disconnect.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const types = window.CasperWalletEventTypes;
    if (!types) return;
    const onState = (e: Event) => {
      try {
        const d = JSON.parse((e as CustomEvent).detail ?? "{}") as {
          activeKey?: string;
          isConnected?: boolean;
          isUnlocked?: boolean;
        };
        if (d.isConnected === false || d.isUnlocked === false) setPublicKeyHex(null);
        else if (d.activeKey) setPublicKeyHex(d.activeKey);
      } catch {
        /* ignore malformed event */
      }
    };
    const events = [types.Connected, types.ActiveKeyChanged, types.Disconnected, types.Locked, types.Unlocked].filter(
      Boolean,
    );
    events.forEach((ev) => window.addEventListener(ev, onState));
    return () => events.forEach((ev) => window.removeEventListener(ev, onState));
  }, [installed]);

  const connect = useCallback(async () => {
    const p = getProvider();
    if (!p) {
      setError("Casper Wallet not found. Install the extension and reload.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const ok = await p.requestConnection();
      if (ok) setPublicKeyHex(await p.getActivePublicKey());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  }, [getProvider]);

  const disconnect = useCallback(async () => {
    const p = getProvider();
    try {
      await p?.disconnectFromSite();
    } catch {
      /* ignore */
    }
    setPublicKeyHex(null);
  }, [getProvider]);

  const signTx = useCallback(
    async (txJson: unknown, pubHex: string): Promise<string> => {
      const p = getProvider();
      if (!p) throw new Error("Casper Wallet not found");
      const res = await p.sign(JSON.stringify(txJson), pubHex);
      if (res.cancelled) throw new Error("Signature was cancelled in the wallet");
      const sigHex = res.signatureHex ?? (res.signature ? bytesToHex(res.signature) : "");
      if (!sigHex) throw new Error("Wallet returned no signature");
      return sigHex;
    },
    [getProvider],
  );

  return { installed, connecting, publicKeyHex, connected: !!publicKeyHex, error, connect, disconnect, signTx };
}
