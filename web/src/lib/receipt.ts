/**
 * Co-signed exposure receipt: the enclave already signed sha256(request bytes);
 * the user adds a NEP-413 signature from their NEAR wallet over the same facts.
 * Contains hashes and numbers only, never document or question text, so it can
 * be shared (e.g. with an auditor) and verified offline.
 */
import type { Attestation, ChatReceipt } from "./api";
import { sha256Hex } from "./api";
import type { Nep413Signature } from "./nep413";

export interface CoSigned {
  message: string;
  sig: Nep413Signature;
  signatureValid: boolean; // ed25519 over the NEP-413 payload, checked locally
  keyOnChain: "FullAccess" | "FunctionCall" | null; // view_access_key over NEAR RPC
}

export async function receiptMessage(args: {
  question: string;
  attestation: Attestation;
  receipts: { label: string; r: ChatReceipt }[];
  exposurePct: number;
  identifiersSent: number;
}): Promise<string> {
  const { question, attestation, receipts, exposurePct, identifiersSent } = args;
  return [
    "Need-to-Know exposure receipt v1",
    `model: ${attestation.model}`,
    `enclave signer: ${receipts[receipts.length - 1]?.r.signature?.signing_address ?? "none"}`,
    `attestation nonce: ${attestation.nonce}`,
    ...receipts.map(({ label, r }) => `request sha256 (${label}): ${r.request_sha256}`),
    ...receipts.map(({ label, r }) => `response sha256 (${label}): ${r.response_sha256}`),
    `document sent: ${exposurePct.toFixed(1)}%`,
    `real identifiers sent: ${identifiersSent}`,
    `question sha256: ${await sha256Hex(question)}`,
    `time: ${new Date().toISOString()}`,
  ].join("\n");
}

export function receiptFile(cos: CoSigned, attestation: Attestation, receipts: { label: string; r: ChatReceipt }[]): Blob {
  const doc = {
    type: "need-to-know/exposure-receipt",
    version: 1,
    statement: cos.message,
    user_signature: { ...cos.sig, scheme: "NEP-413 (ed25519)", verified_locally: cos.signatureValid, key_on_chain: cos.keyOnChain },
    enclave: receipts.map(({ label, r }) => ({ call: label, request_sha256: r.request_sha256, response_sha256: r.response_sha256, signature: r.signature })),
    attestation: { model: attestation.model, nonce: attestation.nonce, verified: attestation.verified, verified_signers: attestation.verified_signers },
    how_to_verify: [
      "1. ed25519-verify user_signature over the NEP-413 payload (message, nonce, recipient) with its publicKey.",
      "2. Check the publicKey is an access key of accountId via NEAR RPC view_access_key.",
      "3. EIP-191-recover each enclave.signature.text; it must equal signing_address and contain request_sha256.",
    ],
  };
  return new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
}
