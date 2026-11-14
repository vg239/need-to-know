import { useEffect, useState } from "react";

// Arrow paths, shared by the marching-dash stroke and the travelling dot.
const FLOWS = [
  { d: "M360 112 C 392 100, 404 100, 428 108", back: false, dur: "1.6s" },
  { d: "M630 108 C 660 100, 672 100, 698 108", back: false, dur: "1.6s" },
  { d: "M698 162 C 666 174, 660 174, 632 166", back: true, dur: "2.2s" },
  { d: "M428 166 C 398 176, 392 176, 362 162", back: true, dur: "2.2s" },
];

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function HowItWorks() {
  const animate = !reducedMotion();
  return (
    <div className="how">
      <div className="paper sheet">
        <svg viewBox="0 0 1000 250" role="img" aria-label="Browser does sectioning, selection and pseudonymisation; a stateless proxy verifies attestation; the NEAR AI TEE sees only the minimal excerpt.">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L10,5 L0,10" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </marker>
          </defs>
          <g fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="20" y="30" width="340" height="190" rx="10" />
            <rect x="430" y="70" width="200" height="110" rx="10" strokeDasharray="6 6" />
            <rect x="700" y="30" width="280" height="190" rx="10" />
            {FLOWS.map((f) => (
              <path key={f.d} className={`flow ${f.back ? "back" : ""}`} d={f.d} markerEnd="url(#arrow)" />
            ))}
          </g>
          {/* a packet travelling along each arrow: out with the excerpt, back with the signed answer */}
          {animate &&
            FLOWS.map((f, i) => (
              <circle key={i} r={f.back ? 3.2 : 4.2} fill={f.back ? "#FFFFFF" : "currentColor"} stroke="currentColor" strokeWidth="1.5">
                <animateMotion dur={f.dur} repeatCount="indefinite" path={f.d} begin={`${i * 0.4}s`} />
              </circle>
            ))}
          <g fill="currentColor" fontFamily="Inter" fontSize="14">
            <text x="40" y="60" fontWeight="700" fontSize="16">Your browser (trusted)</text>
            <text x="40" y="92">• split into sections (no model)</text>
            <text x="40" y="116">• pick only what the question needs</text>
            <text x="40" y="140">• names, IDs, phones become PERSON_1</text>
            <text x="40" y="164">• dates shifted, DOB generalised</text>
            <text x="40" y="188">• identity map stays here</text>
            <text x="450" y="100" fontWeight="700" fontSize="15">Stateless proxy</text>
            <text x="450" y="124">your key or .env key</text>
            <text x="450" y="146">verifies attestation</text>
            <text x="450" y="168">writes nothing</text>
            <text x="720" y="60" fontWeight="700" fontSize="16">NEAR AI Cloud TEE</text>
            <text x="720" y="92">Intel TDX + NVIDIA GPU enclave</text>
            <text x="720" y="116">sees ~5% of the doc, no names</text>
            <text x="720" y="140">signs sha256(request : response)</text>
            <text x="720" y="164">fresh nonce in every quote</text>
          </g>
          <g fill="currentColor" fontFamily="Indie Flower" fontSize="19">
            <text x="364" y="60">minimal excerpt</text>
            <text x="606" y="60">exact bytes</text>
            <text x="360" y="208">answer + signature</text>
            <text x="740" y="208">assume this gets breached.</text>
          </g>
        </svg>
      </div>
      <div className="how-steps">
        <div>
          <span className="n">1.</span>
          <h4>Attest first</h4>
          <p>Your browser makes a 32-byte nonce. We verify the gateway and every GPU enclave quote embeds it before a single byte of the document moves.</p>
        </div>
        <div>
          <span className="n">2.</span>
          <h4>Choose locally</h4>
          <p>Local BM25 picks the sections, so nothing leaves to make the choice. Only vague questions fall back to sending pseudonymised headings.</p>
        </div>
        <div>
          <span className="n">3.</span>
          <h4>Send the sliver</h4>
          <p>The chosen sections, pseudonymised and capped by your exposure budget. Amounts and facts stay; identities don't.</p>
        </div>
        <div>
          <span className="n">4.</span>
          <h4>Prove what left</h4>
          <p>The enclave signs sha256 of the exact request bytes. Hash the payload yourself and compare: that is the exposure receipt.</p>
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
        <g stroke="rgb(30 43 77 / .14)" strokeWidth="1">
          {[0, 25, 50, 75, 100].map((v) => (
            <line key={`x${v}`} x1={x(v)} x2={x(v)} y1={20} y2={H - P} />
          ))}
          {[0, 0.5, 1].map((v) => (
            <line key={`y${v}`} x1={P} x2={W - 16} y1={y(v)} y2={y(v)} />
          ))}
        </g>
        <g fill="rgb(30 43 77 / .7)" fontFamily="Inter" fontSize="11">
          {[0, 25, 50, 75, 100].map((v) => (
            <text key={v} x={x(v)} y={H - P + 16} textAnchor="middle">{v}%</text>
          ))}
          {[0, 50, 100].map((v) => (
            <text key={v} x={P - 8} y={y(v / 100) + 4} textAnchor="end">{v}%</text>
          ))}
          <text x={(W + P) / 2} y={H - 6} textAnchor="middle">share of the document sent to the model</text>
        </g>
        <polyline fill="none" stroke="currentColor" strokeWidth="2.2" points={sweep.map((p) => `${x(p.exposure_pct)},${y(acc(p))}`).join(" ")} />
        {sweep.map((p) => (
          <circle key={p.mode} cx={x(p.exposure_pct)} cy={y(acc(p))} r={5} fill="currentColor" />
        ))}
        {others.map((p) => (
          <g key={p.mode}>
            <circle cx={x(p.exposure_pct)} cy={y(acc(p))} r={6} fill="#FFFFFF" stroke="currentColor" strokeWidth="2" strokeDasharray="3 2" />
            <text x={x(p.exposure_pct)} y={y(acc(p)) + (p.mode === "rag" ? -12 : 22)} textAnchor={p.exposure_pct > 90 ? "end" : "middle"} fill="rgb(30 43 77 / .7)" fontFamily="Inter" fontSize="11">
              {short[p.mode] ?? p.label} · {p.identifiers} ids
            </text>
          </g>
        ))}
        {best && (
          <text x={x(best.exposure_pct) + 14} y={y(acc(best)) - 12} fill="currentColor" fontFamily="Indie Flower" fontSize="18">
            ← {Math.round(100 * acc(best))}% right, {best.exposure_pct.toFixed(0)}% sent, 0 names
          </text>
        )}
        <text x={P + 8} y={H - P - 10} fill="rgb(30 43 77 / .7)" fontFamily="Inter" fontSize="11">
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
