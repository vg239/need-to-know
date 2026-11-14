/**
 * NEAR wallet: connect, NEP-413 message signing, and LOCAL verification.
 *
 * Adapted from PrivateRAG's wallet module (wallet-selector + signMessage),
 * with two additions:
 *   - every signature is verified in the browser (ed25519 over the NEP-413
 *     payload hash), never trusted blindly;
 *   - the signing key is checked on-chain (view_access_key over NEAR RPC),
 *     so "signed by alice.near" means alice.near really holds that key.
 *
 * Nothing here sends document content anywhere. The wallet is used for
 * identity and for deriving the private-vault encryption key (vault.ts).
 */
import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import "@near-wallet-selector/modal-ui/styles.css";
import { Buffer } from "buffer";
import type { Nep413Signature } from "./nep413";
export { verifyNep413, type Nep413Signature } from "./nep413";

export const NETWORK: "mainnet" | "testnet" = import.meta.env.VITE_NEAR_NETWORK === "testnet" ? "testnet" : "mainnet";
export const RECIPIENT = "need-to-know"; // NEP-413 recipient: binds signatures to this app
const RPC = NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com";


let selector: WalletSelector | null = null;
let modal: WalletSelectorModal | null = null;
let init: Promise<WalletSelector> | null = null;

export function setupWallet(): Promise<WalletSelector> {
  if (selector) return Promise.resolve(selector);
  init ??= (async () => {
    selector = await setupWalletSelector({ network: NETWORK, modules: [setupMeteorWallet(), setupMyNearWallet()] });
    modal = setupModal(selector, { theme: "light", description: "Need-to-Know uses your wallet to prove who you are and to encrypt your private document vault. No transactions, no funds." });
    return selector;
  })();
  return init;
}

export function activeAccount(): string | null {
  return selector?.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
}

export function onAccountChange(cb: (accountId: string | null) => void): () => void {
  if (!selector) return () => {};
  const sub = selector.store.observable.subscribe((s) => cb(s.accounts.find((a) => a.active)?.accountId ?? null));
  return () => sub.unsubscribe();
}

export async function openConnect(): Promise<void> {
  await setupWallet();
  modal!.show();
}

export async function disconnect(): Promise<void> {
  if (!selector) return;
  const w = await selector.wallet().catch(() => null);
  await w?.signOut();
}

/** Ask the connected wallet to sign `message` (NEP-413). */
export async function signNep413(message: string, nonce: Uint8Array): Promise<Nep413Signature> {
  const sel = await setupWallet();
  const wallet = await sel.wallet();
  const callbackUrl = window.location.origin + window.location.pathname;
  const res = await wallet.signMessage({ message, recipient: RECIPIENT, nonce: Buffer.from(nonce), callbackUrl });
  if (!res?.signature) throw new Error("The wallet returned no signature");
  return {
    accountId: res.accountId,
    publicKey: res.publicKey,
    signature: res.signature,
    message,
    nonce: Buffer.from(nonce).toString("base64"),
    recipient: RECIPIENT,
    callbackUrl,
  };
}

/** Does `accountId` hold `publicKey` on-chain? Returns the permission, or null if not found / RPC down. */
export async function accessKeyPermission(accountId: string, publicKey: string): Promise<"FullAccess" | "FunctionCall" | null> {
  try {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "ntk",
        method: "query",
        params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
      }),
    });
    const j = await r.json();
    const p = j?.result?.permission;
    if (!p) return null;
    return p === "FullAccess" ? "FullAccess" : "FunctionCall";
  } catch {
    return null;
  }
}
