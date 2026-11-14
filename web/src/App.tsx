import { useEffect, useMemo, useState } from "react";
import { Drafting, Footer, Hero, Nav, Step } from "./components/Chrome";
import { AskBar, Progress, SamplePicker, type Phase, type Routing, type SampleMeta } from "./components/Inputs";
import { AnswerCard, DocumentPaper } from "./components/Document";
import { BreachReplay, ExposureMeter, VerifiedPanel } from "./components/Evidence";
import { Benchmark, HowItWorks } from "./components/Explain";
import { attest, chat, freshNonce, type Attestation, type ChatReceipt } from "./lib/api";
import { computeExposure, type ModeExposure } from "./lib/exposure";
import { buildPiiMap, pseudonymise } from "./lib/pii";
import { applyBudget, answerMessages } from "./lib/plan";
import { parseSkeletonReply, rankSections, skeletonLines, skeletonMessages } from "./lib/retrieval";
import { leaves, sectionize } from "./lib/sectionize";

const MODEL = "z-ai/glm-5.3-flash"; // NEAR-hosted TEE model (owned_by: nearai)

interface Run {
  question: string;
  attestation?: Attestation;
  receipts: { label: string; r: ChatReceipt }[];
  answer?: ChatReceipt;
  sentIds: string[];
  skeletonUsed: boolean;
  skeletonChars: number;
  overBudget: boolean;
  dropped: string[]; // relevant sections the budget cut
  neededPct: number; // budget that would have fit every relevant section
  exposure?: ModeExposure[];
}

const emptyRun = (question = ""): Run => ({
  question,
  receipts: [],
  sentIds: [],
  skeletonUsed: false,
  skeletonChars: 0,
  overBudget: false,
  dropped: [],
  neededPct: 0,
});

export default function App() {
  const [samples, setSamples] = useState<SampleMeta[]>([]);
  const [docKey, setDocKey] = useState("medical_record");
  const [docTitle, setDocTitle] = useState("");
  const [doc, setDoc] = useState("");
  const [question, setQuestion] = useState("");
  const [budget, setBudget] = useState(10);
  const [routing, setRouting] = useState<Routing>("bm25");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [run, setRun] = useState<Run>(emptyRun());
  const [runKey, setRunKey] = useState(0);

  // Sample catalogue
  useEffect(() => {
    fetch("/samples/questions.json")
      .then((r) => r.json())
      .then((j: Record<string, Omit<SampleMeta, "key">>) => setSamples(Object.entries(j).map(([key, v]) => ({ key, ...v }))));
  }, []);

  // Load the chosen sample (fictional, bundled with the app)
  useEffect(() => {
    const s = samples.find((x) => x.key === docKey);
    if (!s) return;
    fetch(`/samples/${s.file}`)
      .then((r) => r.text())
      .then((t) => {
        setDoc(t);
        setDocTitle(s.title);
      });
  }, [docKey, samples]);

  // Everything below is computed locally. `map` (real ↔ placeholder) never leaves this component.
  const secs = useMemo(() => sectionize(doc), [doc]);
  const map = useMemo(() => buildPiiMap(doc), [doc]);
  const candidates = useMemo(() => leaves(secs).filter((s) => s.level > 1), [secs]);

  useEffect(() => {
    setRun(emptyRun());
    setPhase("idle");
    setError("");
  }, [doc]);

  const presets = samples.find((s) => s.key === docKey)?.presets ?? [];
  const busy = phase === "attest" || phase === "route" || phase === "answer";

  async function ask(q = question, budgetPct = budget) {
    q = q.trim();
    if (!q || busy || !doc) return;
    setError("");
    const r = emptyRun(q);
    setRun(r);
    setRunKey((k) => k + 1);
    try {
      // 1. Attest BEFORE sending anything about the document.
      setPhase("attest");
      const a = await attest(freshNonce(), MODEL);
      r.attestation = a;
      setRun({ ...r });
      if (!a.verified) throw new Error("Enclave verification failed — nothing from your document was sent.");

      // 2. Choose sections.
      setPhase("route");
      // Local first (zero bytes leave to make the choice). Benchmark: 20/20 at 10% budget.
      let ranked: string[] = routing === "bm25" ? rankSections(q, candidates).map((x) => x.id).slice(0, 6) : [];
      // Vague questions ("audit my spending") share no keywords with any section →
      // fall back to routing on pseudonymised headings inside the TEE.
      if (!ranked.length) {
        const skeleton = pseudonymise(skeletonLines(candidates), map);
        const r1 = await chat(a, skeletonMessages(skeleton, pseudonymise(q, map)), { json: true, maxTokens: 600 });
        r.receipts.push({ label: "1 · headings", r: r1 });
        r.skeletonUsed = true;
        r.skeletonChars = skeleton.length;
        ranked = parseSkeletonReply(r1.answer, candidates);
      }
      if (!ranked.length) ranked = candidates.map((c) => c.id); // last resort: budget decides
      const sel = applyBudget(ranked, candidates, doc.length, budgetPct);
      r.sentIds = sel.sent.map((s) => s.id);
      r.overBudget = sel.overBudget;
      r.dropped = sel.dropped.map((s) => s.id);
      const all = [...sel.sent, ...sel.dropped].reduce((n, s) => n + s.title.length + s.body.length, 0);
      r.neededPct = Math.min(100, Math.ceil((100 * all) / doc.length) + 8); // headroom: routing may vary slightly
      setRun({ ...r });

      // 3. Send only the minimal, pseudonymised excerpt.
      setPhase("answer");
      const r2 = await chat(a, answerMessages(sel.sent, q, map), { maxTokens: 1200 });
      r.receipts.push({ label: r.skeletonUsed ? "2 · answer" : "answer", r: r2 });
      r.answer = r2;

      // 4. Measure what actually left (scans the real request bytes).
      r.exposure = computeExposure({
        doc,
        secs,
        map,
        question: q,
        sentIds: r.sentIds,
        skeletonUsed: r.skeletonUsed,
        skeletonChars: r.skeletonChars,
        ntkPayloads: r.receipts.map((x) => x.r.request_body),
      });
      setRun({ ...r });
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  const onUpload = (name: string, text: string) => {
    setDocKey("upload");
    setDocTitle(name);
    setDoc(text);
  };

  return (
    <div className="app">
      <Drafting />
      <Nav />
      <Hero />
      <main className="wrap" id="demo">
        <Step n="1" title="Pick a document" aside="all samples are fictional" />
        <SamplePicker samples={samples} selected={docKey} onPick={setDocKey} onUpload={onUpload} />

        <Step n="2" title="Ask a question" aside="only the answer's sections will leave" />
        <AskBar
          question={question}
          setQuestion={setQuestion}
          presets={presets}
          budget={budget}
          setBudget={setBudget}
          routing={routing}
          setRouting={setRouting}
          busy={busy}
          onAsk={(q) => ask(q)}
        />
        <div style={{ marginTop: 16 }}>
          <Progress phase={phase} routing={routing} />
          {error && <p className="error-note">✗ {error}</p>}
          {phase === "done" && run.dropped.length > 0 && (
            <div className="error-note budget-note">
              <span>
                <b>{run.dropped.length} more relevant section{run.dropped.length > 1 ? "s" : ""}</b> (
                {run.dropped.slice(0, 5).map((d) => `§${d}`).join(", ")}
                {run.dropped.length > 5 ? "…" : ""}) didn't fit your {budget}% budget, so the enclave never saw them.
              </span>
              <button
                className="btn"
                onClick={() => {
                  setBudget(run.neededPct);
                  ask(run.question, run.neededPct);
                }}
              >
                Allow {run.neededPct}% and re-ask →
              </button>
            </div>
          )}
        </div>

        <div className="workspace">
          {doc && (
            <DocumentPaper
              title={docTitle}
              secs={secs}
              map={map}
              sentIds={run.sentIds}
              skeletonUsed={run.skeletonUsed}
              hasRun={!!run.answer}
              runKey={runKey}
            />
          )}
          <div className="col">
            {run.answer ? (
              <AnswerCard receipt={run.answer} map={map} />
            ) : (
              <div className="empty">
                <p className="hand">your answer lands here</p>
                <p>Pick a preset question to see what leaves your browser — and what doesn't.</p>
              </div>
            )}
            {run.exposure && (
              <ExposureMeter
                modes={run.exposure}
                budget={budget}
                overBudget={run.overBudget}
                headingPct={run.skeletonUsed ? (100 * run.skeletonChars) / doc.length : 0}
              />
            )}
            <VerifiedPanel attestation={run.attestation} receipts={run.receipts} pending={phase === "attest"} />
          </div>
        </div>

        <Step n="3" id="replay" title="Breach replay" aside="if this enclave were breached right now, the attacker gets ↓" />
        {run.exposure && run.receipts.length ? (
          <BreachReplay modes={run.exposure} receipts={run.receipts} />
        ) : (
          <div className="empty">
            <p className="hand">ask something first</p>
            <p>You'll see the attacker's copy under three approaches, and the exact bytes our request sent.</p>
          </div>
        )}

        <Step n="4" id="how" title="How it works" aside="assume breach. minimise the blast radius." />
        <HowItWorks />

        <Step n="5" id="bench" title="Does privacy cost accuracy?" aside="measured, not claimed" />
        <Benchmark />
      </main>
      <Footer />
    </div>
  );
}
