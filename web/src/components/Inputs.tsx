import type { ChangeEvent } from "react";

export interface SampleMeta {
  key: string;
  title: string;
  subtitle: string;
  file: string;
  presets: string[];
}

export function SamplePicker({
  samples,
  selected,
  onPick,
  onUpload,
}: {
  samples: SampleMeta[];
  selected: string;
  onPick: (key: string) => void;
  onUpload: (file: File) => void;
}) {
  const upload = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onUpload(f); // read in the browser, never uploaded anywhere
    e.target.value = "";
  };
  return (
    <div className="samples">
      {samples.map((s) => (
        <button key={s.key} className="paper polaroid" aria-pressed={selected === s.key} onClick={() => onPick(s.key)}>
          <div className="photo" aria-hidden="true">
            <i className="h" />
            {[92, 78, 85, 60, 88, 70, 80].map((w, i) => (
              <i key={i} style={{ width: `${w}%` }} />
            ))}
          </div>
          <p className="cap">{s.title}</p>
          <p className="sub">{s.subtitle} · fictional</p>
        </button>
      ))}
      <label className="paper polaroid upload" aria-pressed={selected === "upload"}>
        <div className="photo">
          your own .pdf / .md / .txt
          <br />
          read locally, never uploaded
        </div>
        <p className="cap">bring your own</p>
        <p className="sub">stays in this browser tab</p>
        <input className="sr-only" type="file" accept=".pdf,.md,.txt,application/pdf,text/plain,text/markdown" onChange={upload} />
      </label>
    </div>
  );
}

export type Routing = "skeleton" | "bm25";

export function AskBar(props: {
  question: string;
  setQuestion: (q: string) => void;
  presets: string[];
  budget: number;
  setBudget: (n: number) => void;
  routing: Routing;
  setRouting: (r: Routing) => void;
  busy: boolean;
  onAsk: (q?: string) => void;
}) {
  const { question, setQuestion, presets, budget, setBudget, routing, setRouting, busy, onAsk } = props;
  return (
    <form
      className="ask"
      onSubmit={(e) => {
        e.preventDefault();
        onAsk();
      }}
    >
      <div className="ask-row">
        <input
          className="input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask anything about the document…"
          aria-label="Question"
        />
        <button className="btn" disabled={busy || !question.trim()}>
          {busy ? "working…" : "Ask privately →"}
        </button>
      </div>
      <div className="presets">
        {presets.map((p) => (
          <button
            type="button"
            key={p}
            className="preset"
            disabled={busy}
            onClick={() => {
              setQuestion(p);
              onAsk(p);
            }}
          >
            {p}
          </button>
        ))}
      </div>
      <div className="controls">
        <label className="control">
          <span className="lbl">Exposure budget</span>
          <input type="range" min={2} max={40} step={1} value={budget} onChange={(e) => setBudget(+e.target.value)} />
          <span className="budget-val">{budget}%</span>
          <span className="muted">of the document, max</span>
        </label>
        <div className="control">
          <span className="lbl">Pick sections by</span>
          <div className="seg" role="group" aria-label="Routing">
            <button type="button" aria-pressed={routing === "bm25"} onClick={() => setRouting("bm25")}>
              local first (BM25)
            </button>
            <button type="button" aria-pressed={routing === "skeleton"} onClick={() => setRouting("skeleton")}>
              headings → TEE
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}

export type Phase = "idle" | "attest" | "route" | "answer" | "done" | "error";

export function Progress({ phase, routing }: { phase: Phase; routing: Routing }) {
  const steps: [Phase, string][] = [
    ["attest", "verify enclave (fresh nonce)"],
    ["route", routing === "skeleton" ? "choose sections from headings" : "choose sections locally"],
    ["answer", "send minimal excerpt"],
    ["done", "restore names locally"],
  ];
  const order: Phase[] = ["attest", "route", "answer", "done"];
  const at = order.indexOf(phase);
  if (phase === "idle" || phase === "error") return null;
  return (
    <div className="progress" aria-live="polite">
      {steps.map(([p, label], i) => (
        <span key={p} className={i < at || phase === "done" ? "done" : i === at ? "on" : ""}>
          <span className="dot" />
          {label}
        </span>
      ))}
    </div>
  );
}
