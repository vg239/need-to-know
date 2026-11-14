import type { ReactNode } from "react";

/** Faint construction lines over the grid — the drafting-table feel. */
export function Drafting() {
  const ticks = Array.from({ length: 15 }, (_, i) => i);
  return (
    <svg className="drafting" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="6 8">
        <line x1="-40" y1="860" x2="1480" y2="120" />
        <line x1="180" y1="-20" x2="760" y2="920" />
        <line x1="1460" y1="640" x2="820" y2="-30" />
      </g>
      <g fill="none" stroke="currentColor" strokeWidth="1.2">
        <path d="M 40 900 A 420 420 0 0 1 460 480" />
        <path d="M 40 900 A 300 300 0 0 1 340 600" strokeDasharray="3 6" />
      </g>
      <g fill="currentColor" fontFamily="Inter" fontSize="11">
        <text x="300" y="540">30°</text>
        <text x="410" y="620">45°</text>
        <text x="196" y="470">60°</text>
        {ticks.map((i) => (
          <text key={`l${i}`} x="12" y={70 + i * 60}>{(15 - i) * 5}</text>
        ))}
        {ticks.map((i) => (
          <text key={`r${i}`} x="1410" y={70 + i * 60}>{(15 - i) * 5}</text>
        ))}
        {ticks.map((i) => (
          <text key={`b${i}`} x={110 + i * 90} y="890">{i * 5}</text>
        ))}
      </g>
    </svg>
  );
}

export function Nav() {
  return (
    <nav className="nav" aria-label="Main">
      <a className="brand" href="#top">need-to-know</a>
      <a className="link" href="#demo">Demo</a>
      <a className="link" href="#replay">Breach replay</a>
      <a className="link" href="#how">How it works</a>
      <a className="link" href="#bench">Benchmark</a>
      <a className="link cta" href="#demo">Try it</a>
    </nav>
  );
}

export function Hero() {
  return (
    <header className="hero wrap" id="top">
      <div>
        <h1>
          Ask AI about a confidential document.
          <br />
          Send it only what it needs.
        </h1>
        <p className="tagline hand">the enclave proves where your data went — we prove how little of it went.</p>
        <p className="lede">
          Need-to-Know picks the few sections a question needs, swaps names and IDs for placeholders in your browser,
          and sends that sliver to a model running inside a verified NEAR AI TEE. Then it shows you exactly what left,
          signed by the enclave itself.
        </p>
        <div className="facts">
          <span className="chip solid">Intel TDX + NVIDIA attested</span>
          <span className="chip">Fresh nonce every question</span>
          <span className="chip">Nothing stored server-side</span>
        </div>
      </div>
      <aside className="paper note-card tape" aria-label="Why this exists">
        <h3 className="hand">why?</h3>
        <ol>
          <li>A TEE protects data <b>while</b> it is processed.</li>
          <li>It can't limit <b>how much</b> you hand over.</li>
          <li>If enclave software is ever breached, everything you sent is exposed.</li>
          <li>
            So: <b>assume breach, minimise the blast radius</b> — and measure it.
          </li>
        </ol>
      </aside>
    </header>
  );
}

export function Step({ n, title, aside, id }: { n: ReactNode; title: string; aside?: string; id?: string }) {
  return (
    <div className="step" id={id}>
      <span className="n" aria-hidden="true">{n}</span>
      <div>
        <h2>{title}</h2>
        <span className="underline" />
      </div>
      {aside && <span className="aside hand">{aside}</span>}
    </div>
  );
}

export function Footer() {
  return (
    <footer className="wrap">
      <span className="hand">nothing is stored server-side. the identity map never leaves this tab.</span>
      <span>
        Built for the NEAR Hackathon · Privacy &amp; Private AI · inference on NEAR AI Cloud · all sample data is fictional
      </span>
    </footer>
  );
}
