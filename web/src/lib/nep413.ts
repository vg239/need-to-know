/**
 * NEP-413 signed-message verification, pure functions (no wallet, no DOM).
 * Cross-checked against @near-wallet-selector/core's reference verifySignature.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";

export interface Nep413Signature {
  accountId: string;
  publicKey: string; // "ed25519:<base58>"
  signature: string; // base64
  message: string;
  nonce: string; // base64, 32 bytes
  recipient: string;
  callbackUrl?: string;
}


const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const borshString = (s: string) => {
  const utf8 = new TextEncoder().encode(s);
  return [u32(utf8.length), utf8];
};

/** sha256( borsh(u32 2^31+413) || borsh({message, nonce[32], recipient, callbackUrl?}) ), per NEP-413. */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string, callbackUrl?: string): Uint8Array {
  const parts: Uint8Array[] = [u32(2 ** 31 + 413), ...borshString(message), nonce, ...borshString(recipient)];
  if (callbackUrl === undefined) parts.push(new Uint8Array([0]));
  else parts.push(new Uint8Array([1]), ...borshString(callbackUrl));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (all.set(p, o), (o += p.length));
  return sha256(all);
}

/** Verify a NEP-413 signature locally. Tries the payload with and without callbackUrl (wallets differ). */
export function verifyNep413(sig: Nep413Signature): boolean {
  if (!sig.publicKey.startsWith("ed25519:")) return false;
  const pub = base58Decode(sig.publicKey.slice(8));
  const signature = Uint8Array.from(Buffer.from(sig.signature, "base64"));
  const nonce = Uint8Array.from(Buffer.from(sig.nonce, "base64"));
  const variants = sig.callbackUrl ? [undefined, sig.callbackUrl] : [undefined];
  return variants.some((cb) => {
    try {
      return ed25519.verify(signature, nep413Hash(sig.message, nonce, sig.recipient, cb), pub);
    } catch {
      return false;
    }
  });
}

