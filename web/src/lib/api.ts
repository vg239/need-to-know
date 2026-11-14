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

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
