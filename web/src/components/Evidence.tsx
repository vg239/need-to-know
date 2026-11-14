import { useEffect, useState } from "react";
import type { Attestation, ChatReceipt, Check } from "../lib/api";
import { sha256Hex } from "../lib/api";
import type { ModeExposure } from "../lib/exposure";

// ─────────────────────────── Exposure Meter ───────────────────────────

export function ExposureMeter({
  modes,
  budget,
  overBudget,
  headingPct,
}: {
  modes: ModeExposure[];
  budget: number;
  overBudget: boolean;
  headingPct: number;
}) {
  const [full, rag, ntk] = modes;
  const fewer = ntk.chars > 0 ? rag.chars / ntk.chars : 0;
  return (
    <section className="meter" aria-label="Exposure meter">
      <h3>Exposure meter</h3>
      <p className="headline">
        You sent <span className="num">{ntk.pct.toFixed(1)}%</span> of the document and{" "}
        <span className="num">{ntk.distinct.length}</span> real identifier{ntk.distinct.length === 1 ? "" : "s"}.
      </p>
      <div className="bars">
        {[full, rag, ntk].map((m) => (
          <div key={m.key} className={`bar-row ${m.key} ${m.key === "ntk" && overBudget ? "over" : ""}`}>
            <div className="top">
              <b>{m.label}</b>
              <span className="mono">
                {m.pct.toFixed(1)}% · {m.distinct.length} real identifier{m.distinct.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="sub">
              {m.key === "ntk" && headingPct > 0
                ? `sections ${(m.pct - headingPct).toFixed(1)}% + headings ${headingPct.toFixed(1)}% · pseudonymised`
                : m.note}
            </div>
            <div className="track">
              <div className="fill" style={{ width: `${Math.max(m.pct, 0.6)}%` }} />
              {m.key === "ntk" && <span className="budget-mark" style={{ left: `${budget}%` }} title={`section budget ${budget}%`} />}
            </div>
          </div>
        ))}
      </div>
      {fewer >= 1.5 && <p className="hand">≈ {fewer.toFixed(0)}× less than typical RAG, with zero names attached.</p>}
      {overBudget && <p className="hand">the best section alone is over budget — sent anyway so the answer isn't empty.</p>}
    </section>
  );
}

// ─────────────────────────── Verified panel ───────────────────────────

function groupChecks(rows: Check[]) {
  const groups = new Map<string, Check[]>();
  for (const r of rows) {
    const g = r.group.startsWith("Model enclave") ? "Model enclaves (GPU TEE)" : r.group === "Model" ? "Model enclaves (GPU TEE)" : r.group;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  return [...groups.entries()];
}

export function VerifiedPanel({
  attestation,
  receipts,
  pending,
}: {
  attestation?: Attestation;
  receipts: { label: string; r: ChatReceipt }[];
  pending: boolean;
}) {
  const rows: Check[] = [
    ...(attestation?.checks ?? []),
    ...receipts.flatMap(({ label, r }) => r.checks.map((c) => ({ ...c, group: `Response signature · ${label}` }))),
  ];
  const ok = rows.filter((r) => r.ok).length;
  const all = rows.length > 0 && ok === rows.length;
  const enclaves = attestation?.evidence.filter((e) => e.group.startsWith("Model")).length ?? 0;
  return (
    <section className="paper verified" aria-label="Verification">
      <div className="v-head">
        <div>
          <h3>Verified</h3>
          <span className="muted" style={{ fontSize: 13 }}>
            {pending ? "checking the enclave before anything is sent…" : attestation ? `fresh attestation · ${enclaves} GPU enclave${enclaves === 1 ? "" : "s"}` : "runs before every question"}
          </span>
        </div>
        <div className={`stamp ${pending || !rows.length ? "pending" : all ? "" : "fail"}`} aria-label={`${ok} of ${rows.length} checks passed`}>
          {pending || !rows.length ? (
            <span>
              <b>…</b>TEE
            </span>
          ) : (
            <span>
              <b>{all ? "✓" : "✗"}</b>
              {ok}/{rows.length}
            </span>
          )}
        </div>
      </div>
      {groupChecks(rows).map(([g, cs]) => {
        // collapse the three identical model enclaves into one list with a count
        const uniq = new Map<string, { c: Check; n: number; allOk: boolean }>();
        for (const c of cs) {
          const u = uniq.get(c.check);
          uniq.set(c.check, { c, n: (u?.n ?? 0) + 1, allOk: (u?.allOk ?? true) && c.ok });
        }
        const gOk = cs.every((c) => c.ok);
        return (
          <details key={g} className="v-group" open={!gOk || g.startsWith("Response")}>
            <summary>
              <span>{g}</span>
              <span className="mono">
                {cs.filter((c) => c.ok).length}/{cs.length} {gOk ? "✓" : "✗"}
              </span>
            </summary>
            <ul>
              {[...uniq.values()].map(({ c, n, allOk }) => (
                <li key={c.check} className={allOk ? "" : "bad"} title={c.detail}>
                  <span className={`mark ${allOk ? "ok" : ""}`}>{allOk ? "✓" : "✗"}</span>
                  <span>
                    {c.check}
                    {n > 1 ? ` ×${n}` : ""}
                    {c.detail && !c.detail.startsWith("0x") ? <span className="muted"> — {c.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        );
      })}
      {attestation && (
        <div className="v-meta">
          <span>
            <b>nonce</b> <span className="mono">{attestation.nonce.slice(0, 24)}…</span> (generated in this browser)
          </span>
          <span>
            <b>model</b> {attestation.model} · <b>enclave signer</b>{" "}
            <span className="mono">{attestation.verified_signers[0]?.slice(0, 14)}…</span>
          </span>
          <span>
            <b>attested in</b> {(attestation.elapsed_ms / 1000).toFixed(1)}s · Intel TDX via dcap-qvl · NVIDIA via NRAS
          </span>
        </div>
      )}
    </section>
  );
}

// ─────────────────────────── Breach Replay ───────────────────────────

function Minimap({ m }: { m: ModeExposure }) {
  // Downsample to ≤ 90 rows so long docs still fit.
  const step = Math.max(1, Math.ceil(m.lines.length / 90));
  const rows = [];
  for (let i = 0; i < m.lines.length; i += step) {
    const slice = m.lines.slice(i, i + step);
    const st = slice.includes("exposed") ? "exposed" : slice.includes("heading") ? "heading" : "hidden";
    const id = m.idLines.slice(i, i + step).some(Boolean);
    rows.push(<i key={i} className={`${st} ${id ? "id" : ""}`} style={{ width: `${55 + ((i * 37) % 45)}%` }} />);
  }
  return <div className="minimap" aria-hidden="true">{rows}</div>;
}

function HashCheck({ r }: { r: ChatReceipt }) {
  const [local, setLocal] = useState<string>("");
  useEffect(() => {
    sha256Hex(r.request_body).then(setLocal);
  }, [r.request_body]);
  const inSig = !!local && !!r.signature?.text.includes(local);
  return (
    <div className="hashline">
      <span>
        sha256 computed <b>in your browser</b>: <span className="mono">{local || "…"}</span>
      </span>
      <span>
        enclave-signed text: <span className="mono">{r.signature?.text.slice(0, 96)}…</span>
      </span>
      <span className="ok">
        {inSig ? "✓ these exact bytes are what the attested enclave signed for" : local ? "✗ hash not found in signature" : "hashing…"}
      </span>
    </div>
  );
}

export function BreachReplay({ modes, receipts }: { modes: ModeExposure[]; receipts: { label: string; r: ChatReceipt }[] }) {
  const [tab, setTab] = useState(receipts.length - 1);
  const cur = receipts[Math.min(tab, receipts.length - 1)];
  return (
    <div className="replay">
      <div className="replay-grid">
        {modes.map((m) => (
          <div key={m.key} className="paper mini">
            <h4>{m.label}</h4>
            <div className="sub">{m.note}</div>
            <Minimap m={m} />
            <div className="leaks">
              <div className="count">{m.distinct.length}</div>
              {m.distinct.length ? (
                <>
                  real identifiers an attacker would read
                  <div className="tags">
                    {m.distinct.slice(0, 7).map((d) => (
                      <span key={d} className="tag">{d}</span>
                    ))}
                    {m.distinct.length > 7 && <span className="muted">+{m.distinct.length - 7} more</span>}
                  </div>
                </>
              ) : (
                <>real identifiers — only placeholders like PERSON_1 (scanned in the actual bytes)</>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="payload">
        <div className="payload-head">
          <div>
            <h3 className="panel-title">The attacker's copy — exact request bytes</h3>
            <span className="muted" style={{ fontSize: 13 }}>
              {cur.r.request_body.length.toLocaleString()} bytes · {cur.r.usage?.prompt_tokens ?? "?"} prompt tokens
            </span>
          </div>
          {receipts.length > 1 && (
            <div className="seg" role="group" aria-label="Request">
              {receipts.map((x, i) => (
                <button key={x.label} aria-pressed={i === tab} onClick={() => setTab(i)}>
                  {x.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <pre>{cur.r.request_body}</pre>
        <HashCheck r={cur.r} />
      </div>
    </div>
  );
}
