import { useEffect, useState } from "react";

export function HowItWorks() {
  return (
    <div className="how">
      <svg viewBox="0 0 1000 250" role="img" aria-label="Browser does sectioning, selection and pseudonymisation; a stateless proxy verifies attestation; the NEAR AI TEE sees only the minimal excerpt.">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10" fill="none" stroke="#F2ECDD" strokeWidth="1.6" />
          </marker>
        </defs>
        <g fill="none" stroke="#F2ECDD" strokeWidth="1.8">
          <rect x="20" y="30" width="340" height="190" rx="10" />
          <rect x="430" y="70" width="200" height="110" rx="10" strokeDasharray="6 6" />
          <rect x="700" y="30" width="280" height="190" rx="10" />
          <path d="M360 110 C 395 100, 400 100, 428 108" markerEnd="url(#arrow)" />
          <path d="M630 108 C 660 100, 670 100, 698 108" markerEnd="url(#arrow)" />
          <path d="M698 160 C 665 172, 660 172, 632 164" markerEnd="url(#arrow)" strokeDasharray="5 5" />
          <path d="M428 164 C 400 172, 395 172, 362 160" markerEnd="url(#arrow)" strokeDasharray="5 5" />
        </g>
        <g fill="#F2ECDD" fontFamily="Inter" fontSize="14">
          <text x="40" y="60" fontWeight="700" fontSize="16">Your browser (trusted)</text>
          <text x="40" y="92">• split into sections (no model)</text>
          <text x="40" y="116">• pick only what the question needs</text>
          <text x="40" y="140">• names, IDs, phones → PERSON_1 …</text>
          <text x="40" y="164">• dates shifted, DOB generalised</text>
          <text x="40" y="188">• identity map stays here</text>
          <text x="450" y="100" fontWeight="700" fontSize="15">Stateless proxy</text>
          <text x="450" y="124">key from .env</text>
          <text x="450" y="146">verifies attestation</text>
          <text x="450" y="168">writes nothing</text>
          <text x="720" y="60" fontWeight="700" fontSize="16">NEAR AI Cloud TEE</text>
          <text x="720" y="92">Intel TDX + NVIDIA GPU enclave</text>
          <text x="720" y="116">sees ~5% of the doc, no names</text>
          <text x="720" y="140">signs sha256(request : response)</text>
          <text x="720" y="164">fresh nonce in every quote</text>
        </g>
        <g fill="#F2ECDD" fontFamily="Indie Flower" fontSize="19">
          <text x="364" y="60">minimal excerpt</text>
          <text x="606" y="60">exact bytes</text>
          <text x="360" y="205">answer + signature</text>
          <text x="740" y="208">assume this gets breached.</text>
        </g>
      </svg>
      <div className="how-steps">
        <div>
          <span className="n">1.</span>
          <h4>Attest first</h4>
          <p>Your browser makes a 32-byte nonce. We verify the gateway and every GPU enclave quote embeds it before a single byte of the document moves.</p>
        </div>
        <div>
          <span className="n">2.</span>
          <h4>Route on a skeleton</h4>
          <p>Only pseudonymised headings go out to choose sections — or nothing at all with the fully local BM25 mode.</p>
        </div>
        <div>
          <span className="n">3.</span>
          <h4>Send the sliver</h4>
          <p>The chosen sections, pseudonymised and capped by your exposure budget. Amounts and facts stay; identities don't.</p>
        </div>
        <div>
          <span className="n">4.</span>
          <h4>Prove what left</h4>
          <p>The enclave signs sha256 of the exact request bytes. Hash the payload yourself, compare — that's the exposure receipt.</p>
        </div>
      </div>
    </div>
  );
}

interface BenchRow {
  mode: string;
  label: string;
  exposure_pct: number;
  correct: number;
  total: number;
  identifiers: number;
}

export function Benchmark() {
  const [rows, setRows] = useState<BenchRow[] | null>(null);
  useEffect(() => {
    fetch("/bench.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRows(d?.rows ?? null))
      .catch(() => setRows(null));
  }, []);
  if (!rows?.length)
    return (
      <div className="empty">
        <p className="hand">benchmark not generated yet</p>
        <p>
          Run <code>uv run --project server python bench/run_bench.py</code> to sweep accuracy vs exposure.
        </p>
      </div>
    );

  const W = 560, H = 300, P = 44;
  const x = (v: number) => P + (v / 100) * (W - P - 16);
  const y = (v: number) => H - P - v * (H - P - 20);
  const acc = (r: BenchRow) => r.correct / r.total;
  // Only the budget sweep is one series; baselines and heading-routing are separate points.
  const sweep = rows.filter((r) => r.mode.startsWith("ntk-bm25")).sort((a, b) => a.exposure_pct - b.exposure_pct);
  const others = rows.filter((r) => !r.mode.startsWith("ntk-bm25"));
  const best = sweep.find((r) => r.correct === r.total) ?? sweep[sweep.length - 1];
  const short: Record<string, string> = { full: "whole doc", rag: "typical RAG", "ntk-skel": "heading routing" };
  return (
    <div className="bench">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Accuracy versus share of document exposed">
        <g stroke="rgb(242 236 221 / .16)" strokeWidth="1">
          {[0, 25, 50, 75, 100].map((v) => (
            <line key={`x${v}`} x1={x(v)} x2={x(v)} y1={20} y2={H - P} />
          ))}
          {[0, 0.5, 1].map((v) => (
            <line key={`y${v}`} x1={P} x2={W - 16} y1={y(v)} y2={y(v)} />
          ))}
        </g>
        <g fill="rgb(242 236 221 / .68)" fontFamily="Inter" fontSize="11">
          {[0, 25, 50, 75, 100].map((v) => (
            <text key={v} x={x(v)} y={H - P + 16} textAnchor="middle">{v}%</text>
          ))}
          {[0, 50, 100].map((v) => (
            <text key={v} x={P - 8} y={y(v / 100) + 4} textAnchor="end">{v}%</text>
          ))}
          <text x={(W + P) / 2} y={H - 6} textAnchor="middle">share of the document sent to the model</text>
        </g>
        <polyline fill="none" stroke="#F2ECDD" strokeWidth="2.2" points={sweep.map((p) => `${x(p.exposure_pct)},${y(acc(p))}`).join(" ")} />
        {sweep.map((p) => (
          <circle key={p.mode} cx={x(p.exposure_pct)} cy={y(acc(p))} r={5} fill="#F2ECDD" />
        ))}
        {others.map((p) => (
          <g key={p.mode}>
            <circle cx={x(p.exposure_pct)} cy={y(acc(p))} r={6} fill="#1F3A2B" stroke="#F2ECDD" strokeWidth="2" strokeDasharray="3 2" />
            <text x={x(p.exposure_pct)} y={y(acc(p)) + (p.mode === "rag" ? -12 : 22)} textAnchor={p.exposure_pct > 90 ? "end" : "middle"} fill="rgb(242 236 221 / .68)" fontFamily="Inter" fontSize="11">
              {short[p.mode] ?? p.label} · {p.identifiers} ids
            </text>
          </g>
        ))}
        {best && (
          <text x={x(best.exposure_pct) + 14} y={y(acc(best)) - 12} fill="#F2ECDD" fontFamily="Indie Flower" fontSize="18">
            ← {Math.round(100 * acc(best))}% right, {best.exposure_pct.toFixed(0)}% sent, 0 names
          </text>
        )}
        <text x={P + 8} y={H - P - 10} fill="rgb(242 236 221 / .68)" fontFamily="Inter" fontSize="11">
          ● Need-to-Know budget sweep (local routing) · ◌ comparison points
        </text>
      </svg>
      <table>
        <thead>
          <tr>
            <th>Mode</th>
            <th>Sent</th>
            <th>Correct</th>
            <th>Identifiers</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.mode}>
              <td>{r.label}</td>
              <td>{r.exposure_pct.toFixed(1)}%</td>
              <td>
                {r.correct}/{r.total}
              </td>
              <td>{r.identifiers}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
