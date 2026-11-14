import { useEffect, useMemo, useState } from "react";
import { Drafting, Footer, Hero, Nav, Step } from "./components/Chrome";
import { AskBar, Progress, SamplePicker, type Phase, type Routing, type SampleMeta } from "./components/Inputs";
import { AnswerCard, DocumentPaper } from "./components/Document";
import { BreachReplay, ExposureMeter, VerifiedPanel } from "./components/Evidence";
import { Benchmark, HowItWorks } from "./components/Explain";
import { ApiError, attest, chat, freshNonce, getUserKey, health, saveUserKey, type Attestation, type ChatReceipt } from "./lib/api";
import { KeyDialog } from "./components/KeyDialog";
import { WalletButton } from "./components/Wallet";
import { accessKeyPermission, activeAccount, disconnect, onAccountChange, openConnect, setupWallet, signNep413, verifyNep413 } from "./lib/near";
import { receiptFile, receiptMessage, type CoSigned } from "./lib/receipt";
import { HistoryList, VaultPanel, type VaultItem } from "./components/Vault";
import { deleteRecord, deriveVaultKey, docSha256, listRecords, openDoc, putRecord, sealDoc, vaultKeyMessage, vaultNonce, type VaultDoc } from "./lib/vault";
import { computeExposure, type ModeExposure } from "./lib/exposure";
import { buildPiiMap, pseudonymise, restoreSegments } from "./lib/pii";
import { applyBudget, answerMessages } from "./lib/plan";
import { parseSkeletonReply, rankSections, skeletonLines, skeletonMessages } from "./lib/retrieval";
import { leaves, sectionize } from "./lib/sectionize";
import { pdfToStructuredText, type PdfResult } from "./lib/pdf";

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
  cosign?: CoSigned; // the user's NEP-413 co-signature over the exposure receipt
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
  const [pdf, setPdf] = useState<Omit<PdfResult, "text"> | null>(null); // set when the document came from a PDF
  const [loadingDoc, setLoadingDoc] = useState("");
  const [doc, setDoc] = useState("");
  const [shiftOverride, setShiftOverride] = useState<number | undefined>(undefined); // vault docs keep their date shift
  const [question, setQuestion] = useState("");
  const [budget, setBudget] = useState(10);
  const [routing, setRouting] = useState<Routing>("bm25");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [run, setRun] = useState<Run>(emptyRun());
  const [runKey, setRunKey] = useState(0);
  // Bring-your-own key: lives in localStorage only (see lib/api.ts).
  const [userKey, setUserKey] = useState(getUserKey);
  const [serverKey, setServerKey] = useState(true);
  const [keyOpen, setKeyOpen] = useState(false);
  const onSaveKey = (k: string) => {
    saveUserKey(k);
    setUserKey(k);
  };

  // NEAR wallet (identity, receipt co-signing, vault key). Nothing is sent to our server.
  const [account, setAccount] = useState<string | null>(null);
  const [cosignError, setCosignError] = useState("");
  useEffect(() => {
    let unsub = () => {};
    setupWallet()
      .then(() => {
        setAccount(activeAccount());
        unsub = onAccountChange(setAccount);
      })
      .catch(() => setAccount(null));
    return () => unsub();
  }, []);

  async function cosignReceipt() {
    if (!run.attestation || !run.exposure) return;
    setCosignError("");
    try {
      const ntk = run.exposure[2];
      const message = await receiptMessage({
        question: run.question,
        attestation: run.attestation,
        receipts: run.receipts,
        exposurePct: ntk.pct,
        identifiersSent: ntk.distinct.length,
      });
      const sig = await signNep413(message, crypto.getRandomValues(new Uint8Array(32)));
      const signatureValid = verifyNep413(sig) && (!account || sig.accountId === account);
      const keyOnChain = await accessKeyPermission(sig.accountId, sig.publicKey);
      setRun((cur) => ({ ...cur, cosign: { message, sig, signatureValid, keyOnChain } }));
    } catch (e) {
      setCosignError(e instanceof Error ? e.message : String(e));
    }
  }

  function downloadReceipt() {
    if (!run.cosign || !run.attestation) return;
    const url = URL.createObjectURL(receiptFile(run.cosign, run.attestation, run.receipts));
    const a = document.createElement("a");
    a.href = url;
    a.download = `need-to-know-receipt-${run.receipts[run.receipts.length - 1]?.r.request_sha256.slice(0, 12)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  useEffect(() => {
    health()
      .then((h) => setServerKey(!!h.server_key))
      .catch(() => setServerKey(false));
  }, []);

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
        setPdf(null);
        setShiftOverride(undefined);
        setActiveVaultId(null);
        setDoc(t);
        setDocTitle(s.title);
      });
  }, [docKey, samples]);

  // Everything below is computed locally. `map` (real ↔ placeholder) never leaves this component.
  // Local PageIndex: section tree + PII map, built in the browser. Timed to show it costs ~nothing.
  const { secs, map, indexMs } = useMemo(() => {
    const t0 = performance.now();
    const secs = sectionize(doc, { markdownOnly: !!pdf });
    const map = buildPiiMap(doc, shiftOverride);
    return { secs, map, indexMs: performance.now() - t0 };
  }, [doc, pdf, shiftOverride]);
  const pageOf = (headLine: number) => (pdf ? pdf.lineToPage[headLine] : undefined);
  const indexInfo = {
    sections: secs.filter((x) => x.level > 1).length,
    depth: Math.max(0, ...secs.map((x) => x.level)) - 1,
    source: pdf ? pdf.tocSource : "document headings",
    pages: pdf?.pages,
    ms: indexMs,
  };
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
    if (!userKey && !serverKey) {
      setKeyOpen(true); // nobody has a key yet: ask for the user's own
      return;
    }
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
      const scored = routing === "bm25" ? rankSections(q, candidates).slice(0, 6) : [];
      let ranked: string[] = scored.map((x) => x.id);
      // Only strong matches (>= 80% of the top score) count as "relevant but cut by the budget".
      const strong = new Set(scored.filter((x) => x.score >= 0.8 * (scored[0]?.score ?? 0)).map((x) => x.id));
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
      const droppedRelevant = r.skeletonUsed ? sel.dropped : sel.dropped.filter((s) => strong.has(s.id));
      r.dropped = droppedRelevant.map((s) => s.id);
      const all = [...sel.sent, ...droppedRelevant].reduce((n, s) => n + s.title.length + s.body.length, 0);
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
      if (activeVaultId) await appendHistory(activeVaultId, q, r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
      if (e instanceof ApiError && e.status === 401) setKeyOpen(true);
    }
  }

  // ─────────── private vault (wallet-encrypted, this browser only) ───────────
  const [vaultKey, setVaultKey] = useState<CryptoKey | null>(null); // memory only, never persisted
  const [vaultItems, setVaultItems] = useState<VaultItem[]>([]);
  const [activeVaultId, setActiveVaultId] = useState<string | null>(null);
  const [vaultBusy, setVaultBusy] = useState("");
  const [vaultError, setVaultError] = useState("");
  const [docSha, setDocSha] = useState("");
  useEffect(() => {
    docSha256(doc).then(setDocSha);
  }, [doc]);
  useEffect(() => {
    // Switching or disconnecting the wallet locks the vault.
    setVaultKey(null);
    setVaultItems([]);
    setActiveVaultId(null);
  }, [account]);

  async function refreshVault(key: CryptoKey, acct: string) {
    const recs = await listRecords(acct);
    const items: VaultItem[] = [];
    let unreadable = 0;
    for (const rec of recs) {
      try {
        items.push({ rec, doc: await openDoc(key, rec) });
      } catch {
        unreadable++;
      }
    }
    items.sort((x, y) => y.doc.savedAt.localeCompare(x.doc.savedAt));
    setVaultItems(items);
    if (unreadable) setVaultError(`${unreadable} record(s) could not be decrypted with this wallet key`);
  }

  async function unlockVault() {
    if (!account) return;
    setVaultError("");
    setVaultBusy("waiting for wallet signature…");
    try {
      const sig = await signNep413(vaultKeyMessage(account), await vaultNonce(account));
      const key = await deriveVaultKey(sig, account);
      setVaultKey(key);
      await refreshVault(key, account);
    } catch (e) {
      setVaultError(e instanceof Error ? e.message : String(e));
    } finally {
      setVaultBusy("");
    }
  }

  async function saveToVault() {
    if (!vaultKey || !account || !doc) return;
    setVaultBusy("encrypting…");
    try {
      const existing = vaultItems.find((x) => x.rec.docSha256 === docSha);
      const vdoc: VaultDoc = {
        title: docTitle,
        text: doc,
        pdf: pdf ?? undefined,
        shiftMonths: map.shiftMonths,
        history: existing?.doc.history ?? [],
        savedAt: new Date().toISOString(),
      };
      const rec = await sealDoc(vaultKey, account, vdoc);
      await putRecord(rec);
      setShiftOverride(map.shiftMonths);
      setActiveVaultId(rec.id);
      await refreshVault(vaultKey, account);
    } catch (e) {
      setVaultError(e instanceof Error ? e.message : String(e));
    } finally {
      setVaultBusy("");
    }
  }

  function openFromVault(id: string) {
    const item = vaultItems.find((x) => x.rec.id === id);
    if (!item) return;
    setDocKey("vault");
    setPdf(item.doc.pdf ? { ...item.doc.pdf, tocSource: item.doc.pdf.tocSource as PdfResult["tocSource"] } : null);
    setShiftOverride(item.doc.shiftMonths);
    setDocTitle(item.doc.title);
    setDoc(item.doc.text);
    setActiveVaultId(id);
  }

  async function removeFromVault(id: string) {
    if (!vaultKey || !account) return;
    await deleteRecord(id);
    if (activeVaultId === id) setActiveVaultId(null);
    await refreshVault(vaultKey, account);
  }

  async function appendHistory(id: string, q: string, r: Run) {
    const item = vaultItems.find((x) => x.rec.id === id);
    if (!item || !vaultKey || !account || !r.answer || !r.exposure) return;
    const vdoc: VaultDoc = {
      ...item.doc,
      history: [
        ...item.doc.history,
        {
          at: new Date().toISOString(),
          question: q,
          answer: r.answer.answer,
          exposurePct: r.exposure[2].pct,
          identifiersSent: r.exposure[2].distinct.length,
          requestSha256: r.receipts.map((x) => x.r.request_sha256),
        },
      ],
    };
    await putRecord(await sealDoc(vaultKey, account, vdoc));
    await refreshVault(vaultKey, account);
  }

  const activeVault = vaultItems.find((x) => x.rec.id === activeVaultId);
  const restoreText = (t: string) =>
    restoreSegments(t.replace(/\*\*(.+?)\*\*/g, "$1"), map)
      .map((x) => x.text)
      .join("");

  // Files are read in the browser only. PDFs go through pdf.js (local PageIndex).
  const onUpload = async (file: File) => {
    setDocKey("upload");
    setError("");
    setShiftOverride(undefined);
    setActiveVaultId(null);
    try {
      if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
        setLoadingDoc(`reading ${file.name} locally…`);
        const { text, ...meta } = await pdfToStructuredText(await file.arrayBuffer(), file.name);
        setPdf(meta);
        setDocTitle(file.name);
        setDoc(text);
      } else {
        setPdf(null);
        setDocTitle(file.name);
        setDoc(await file.text());
      }
    } catch (e) {
      setError(`Could not read ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      setPhase("error");
    } finally {
      setLoadingDoc("");
    }
  };

  return (
    <div className="app">
      <Drafting />
      <Nav hasUserKey={!!userKey} onKey={() => setKeyOpen(true)}>
        <WalletButton account={account} onConnect={() => openConnect()} onDisconnect={() => disconnect()} />
      </Nav>
      <KeyDialog open={keyOpen} onClose={() => setKeyOpen(false)} userKey={userKey} onSave={onSaveKey} />
      <Hero />
      <main className="wrap" id="demo">
        <Step n="1" title="Pick a document" aside="all samples are fictional" />
        <SamplePicker samples={samples} selected={docKey} onPick={setDocKey} onUpload={onUpload} />
        {loadingDoc && <p className="keyline" style={{ marginTop: 14 }}>{loadingDoc}</p>}
        <VaultPanel
          account={account}
          unlocked={!!vaultKey}
          busy={vaultBusy}
          items={vaultItems}
          activeId={activeVaultId}
          canSave={!!doc && !vaultItems.some((x) => x.rec.docSha256 === docSha)}
          currentTitle={docTitle}
          error={vaultError}
          onConnect={() => openConnect()}
          onUnlock={unlockVault}
          onLock={() => {
            setVaultKey(null);
            setVaultItems([]);
            setActiveVaultId(null);
          }}
          onSave={saveToVault}
          onOpen={openFromVault}
          onDelete={removeFromVault}
        />

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
        <label className="keycheck">
          <input
            type="checkbox"
            checked={!!userKey}
            onChange={(e) => (e.target.checked ? setKeyOpen(true) : onSaveKey(""))}
          />
          <span>
            Use my own NEAR AI key
            {userKey ? (
              <>
                {" "}
                <span className="muted">(…{userKey.slice(-4)}, stored only in this browser)</span>{" "}
                <button className="linkish" type="button" onClick={() => setKeyOpen(true)}>
                  change
                </button>
              </>
            ) : !serverKey ? (
              <span className="muted"> (needed to ask questions)</span>
            ) : null}
          </span>
        </label>
        <div style={{ marginTop: 16 }}>
          <Progress phase={phase} routing={routing} />
          {error && <p className="error-note">✗ {error}</p>}
          {phase === "done" && run.dropped.length > 0 && (
            <div className="error-note budget-note">
              <span>
                <b>{run.dropped.length} more relevant section{run.dropped.length > 1 ? "s" : ""}</b> (
                {run.dropped
                  .slice(0, 5)
                  .map((d) => {
                    const sec = secs.find((x) => x.id === d);
                    return sec?.num ? `§${sec.num}` : `"${sec?.title ?? d}"`;
                  })
                  .join(", ")}
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
              index={indexInfo}
              pageOf={pageOf}
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
                headingPct={run.skeletonUsed ? (100 * (run.exposure[2].headingChars ?? 0)) / doc.length : 0}
              />
            )}
            <VerifiedPanel attestation={run.attestation} receipts={run.receipts} pending={phase === "attest"} />
            {activeVault && <HistoryList entries={activeVault.doc.history} restore={restoreText} />}
          </div>
        </div>

        <Step n="3" id="replay" title="Breach replay" aside="if this enclave were breached right now, the attacker gets ↓" />
        {run.exposure && run.receipts.length ? (
          <BreachReplay
            modes={run.exposure}
            receipts={run.receipts}
            account={account}
            cosign={run.cosign}
            cosignError={cosignError}
            onConnect={() => openConnect()}
            onCosign={cosignReceipt}
            onDownload={downloadReceipt}
          />
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
