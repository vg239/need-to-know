/** Thin client for the stateless proxy (server/app.py). */

export interface Check {
  group: string;
  check: string;
  ok: boolean;
  warn: boolean;
  detail: string;
}

export interface Attestation {
  nonce: string;
  model: string;
  verified: boolean;
  verified_signers: string[];
  gateway_signer: string | null;
  checks: Check[];
  evidence: { group: string; signing_address: string; app_name: string; compose_hash: string; mrtd: string }[];
  elapsed_ms: number;
}

export interface ChatReceipt {
  answer: string;
  chat_id: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  elapsed_ms: number;
  request_body: string; // EXACT bytes the enclave received
  request_sha256: string;
  response_sha256: string;
  signature: { text: string; signature: string; signing_address: string; signing_algo: string; signature_kind: string } | null;
  verified: boolean;
  checks: Check[];
}

export type Msg = { role: "system" | "user" | "assistant"; content: string };

// ─────────────── bring-your-own NEAR AI key ───────────────
// Stored ONLY in this browser's localStorage. Sent to the stateless proxy in a
// header on each request, used for that single upstream call, never stored there.
const KEY_STORAGE = "ntk.nearaiKey";

export function getUserKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return ""; // private mode / blocked storage: just fall back to the server key
  }
}

export function saveUserKey(k: string): void {
  try {
    if (k) localStorage.setItem(KEY_STORAGE, k);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage unavailable: the key simply won't persist */
  }
}

export async function health(): Promise<{ ok: boolean; stateless: boolean; server_key: boolean }> {
  const r = await fetch("/api/health");
  return r.json();
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const k = getUserKey();
  if (k) headers["X-NearAI-Key"] = k;
  const r = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) {
    const text = await r.text();
    let detail = text.slice(0, 200);
    try {
      detail = JSON.parse(text).detail ?? detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(`${detail} (HTTP ${r.status})`, r.status);
  }
  return r.json();
}

/** 32 fresh random bytes, generated HERE so the server can't choose or replay them. */
export function freshNonce(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const attest = (nonce: string, model: string) => post<Attestation>("/api/attest", { nonce, model });

export const chat = (a: Attestation, messages: Msg[], opts: { json?: boolean; maxTokens?: number } = {}) =>
  post<ChatReceipt>("/api/chat", {
    model: a.model,
    messages,
    json_mode: !!opts.json,
    max_tokens: opts.maxTokens ?? 900,
    verified_signers: a.verified_signers,
    gateway_signer: a.gateway_signer,
  });

/** SHA-256 in the browser — lets the user check the receipt without trusting our server. */
export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
