/**
 * Private vault: an encrypted document library that lives ONLY in this
 * browser (IndexedDB), unlocked by a NEAR wallet signature.
 *
 * Nothing is stored server-side (a track requirement), so the vault stays in
 * the browser:
 *
 *   key  = HKDF-SHA256(NEP-413 signature over a fixed message + deterministic
 *          nonce, salt = sha256(account), info = "need-to-know vault v1")
 *          → AES-256-GCM, non-extractable, held in memory only
 *   data = AES-256-GCM(JSON{title, text, pdf meta, shiftMonths, history})
 *
 * Ed25519 signatures are deterministic, so the same wallet key re-derives the
 * same vault key on every visit. GCM's auth tag rejects a wrong key or any
 * tampering. Without the wallet, the IndexedDB records are opaque bytes.
 */
import type { Nep413Signature } from "./nep413";
import { verifyNep413 } from "./nep413";

export interface HistoryEntry {
  at: string;
  question: string; // as the user typed it (stays encrypted in the vault)
  answer: string; // the enclave's answer, with placeholders (restored on display)
  exposurePct: number;
  identifiersSent: number;
  requestSha256: string[];
}

export interface VaultDoc {
  title: string;
  text: string;
  pdf?: { lineToPage: number[]; pages: number; tocSource: string };
  shiftMonths: number; // keeps date-shifting stable for this document across visits
  history: HistoryEntry[];
  savedAt: string;
}

export interface VaultRecord {
  id: string; // `${account}:${docSha256}`
  account: string;
  docSha256: string;
  iv: string; // base64
  ciphertext: string; // base64 (includes GCM tag)
  bytes: number;
}

const DB = "need-to-know";
const STORE = "vault";
const enc = new TextEncoder();
const b64 = (u: Uint8Array) => {
  let s = ""; // chunked: spreading a large array into fromCharCode overflows the stack
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u: ArrayBuffer) => [...new Uint8Array(u)].map((x) => x.toString(16).padStart(2, "0")).join("");

export const vaultKeyMessage = (account: string) =>
  `Need-to-Know vault key v1\naccount: ${account}\nThis signature unlocks your encrypted document vault in this browser. It is never sent anywhere.`;

/** Deterministic nonce, so the same wallet key always re-derives the same vault key. */
export async function vaultNonce(account: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`need-to-know-vault-v1:${account}`)));
}

/** HKDF(signature) → AES-256-GCM. Rejects signatures that don't verify or belong to another account. */
export async function deriveVaultKey(sig: Nep413Signature, account: string): Promise<CryptoKey> {
  if (sig.accountId !== account) throw new Error("Signature is from a different account");
  if (!verifyNep413(sig)) throw new Error("Wallet signature did not verify");
  const ikm = await crypto.subtle.importKey("raw", unb64(sig.signature), "HKDF", false, ["deriveKey"]);
  const salt = await crypto.subtle.digest("SHA-256", enc.encode(account));
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("need-to-know vault v1") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable: the key can't be read out of the page
    ["encrypt", "decrypt"],
  );
}

export async function docSha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export async function sealDoc(key: CryptoKey, account: string, doc: VaultDoc): Promise<VaultRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // fresh IV per write
  const plain = enc.encode(JSON.stringify(doc));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const sha = await docSha256(doc.text);
  return { id: `${account}:${sha}`, account, docSha256: sha, iv: b64(iv), ciphertext: b64(ct), bytes: ct.length };
}

export async function openDoc(key: CryptoKey, rec: VaultRecord): Promise<VaultDoc> {
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(rec.iv) }, key, unb64(rec.ciphertext));
    return JSON.parse(new TextDecoder().decode(plain)) as VaultDoc;
  } catch {
    throw new Error("Cannot decrypt: wrong wallet key or the record was tampered with");
  }
}

// ─────────────────────────── IndexedDB (this browser only) ───────────────────────────

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("account", "account");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = fn(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const putRecord = (rec: VaultRecord) => tx("readwrite", (s) => s.put(rec));
export const deleteRecord = (id: string) => tx("readwrite", (s) => s.delete(id));
export const listRecords = (account: string) => tx<VaultRecord[]>("readonly", (s) => s.index("account").getAll(account));
