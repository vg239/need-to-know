import { Fragment, useEffect, useRef, useState } from "react";
import { markCodes, markIdentifiers, pseudonymise, restoreSegments, type PiiMap, type Segment } from "../lib/pii";
import type { Section } from "../lib/sectionize";
import type { ChatReceipt } from "../lib/api";

function Segs({ segs, map }: { segs: Segment[]; map?: PiiMap }) {
  return (
    <>
      {segs.map((s, i) =>
        s.code && map ? (
          <span key={i} className="ident" title={`leaves your browser as ${s.code}`}>
            {s.text}
          </span>
        ) : s.code ? (
          <span key={i} className="code" title="placeholder — the real value never left your browser">
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

/** One redaction bar per line, so bars follow the text's shape and the wipe animates cleanly. */
function Redacted({ text, soft }: { text: string; soft: boolean }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((ln, i) => (
        <Fragment key={i}>
          {ln.trim() ? <span className={`redact ${soft ? "soft" : ""}`} style={{ animationDelay: `${Math.min(i * 18, 360)}ms` }}>{ln}</span> : ln}
          {i < lines.length - 1 ? "\n" : null}
        </Fragment>
      ))}
    </>
  );
}

export function DocumentPaper(props: {
  title: string;
  secs: Section[];
  map: PiiMap;
  sentIds: string[];
  skeletonUsed: boolean;
  hasRun: boolean;
  runKey: number;
}) {
  const { title, secs, map, sentIds, skeletonUsed, hasRun, runKey } = props;
  const [view, setView] = useState<"yours" | "enclave">("enclave");
  const sent = new Set(sentIds);
  const ids = map.entities.length;
  const bodyRef = useRef<HTMLDivElement>(null);

  // After a run, bring the first section that actually left into view (inside the paper only).
  useEffect(() => {
    if (!hasRun) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(".sec.sent");
    if (el && bodyRef.current) bodyRef.current.scrollTo({ top: el.offsetTop - 24, behavior: "smooth" });
  }, [hasRun, runKey, view]);

  return (
    <article className="paper doc">
      <div className="doc-head">
        <h3>{title}</h3>
        <div className="seg" role="group" aria-label="Document view">
          <button aria-pressed={view === "yours"} onClick={() => setView("yours")}>
            Your view
          </button>
          <button aria-pressed={view === "enclave"} onClick={() => setView("enclave")}>
            What the enclave saw
          </button>
        </div>
      </div>
      <div className="doc-body" ref={bodyRef} key={`${view}-${runKey}`}>
        {view === "enclave" && !hasRun && (
          <p className="hand" style={{ fontSize: 20, margin: "0 0 10px" }}>
            nothing has left your browser yet ↓
          </p>
        )}
        {secs.map((s) => {
          const isSent = hasRun && sent.has(s.id);
          const lvl = Math.min(s.level, 3);
          const heading = s.num ? `${s.num} ${s.title}` : s.title;
          if (view === "yours") {
            return (
              <section key={s.id} className={`sec ${isSent ? "sent" : ""}`}>
                {isSent && <span className="margin-note">sent ✓</span>}
                <h4 className={`l${lvl}`}>
                  <Segs segs={markIdentifiers(heading, map)} map={map} />
                </h4>
                {s.body && (
                  <p className="body">
                    <Segs segs={markIdentifiers(s.body, map)} map={map} />
                  </p>
                )}
              </section>
            );
          }
          // Enclave view: exactly what it received — everything else is a redaction bar.
          const headingShown = isSent || (hasRun && skeletonUsed && !!s.body && s.level > 1);
          return (
            <section key={s.id} className={`sec ${isSent ? "sent" : ""}`}>
              {isSent && <span className="margin-note">sent ✓</span>}
              <h4 className={`l${lvl}`}>
                {headingShown ? (
                  <Segs segs={markCodes(pseudonymise(heading, map))} />
                ) : (
                  <Redacted text={heading} soft={!hasRun} />
                )}
              </h4>
              {s.body && (
                <p className="body">
                  {isSent ? (
                    <Segs segs={markCodes(pseudonymise(s.body, map))} />
                  ) : (
                    <Redacted text={s.body} soft={!hasRun} />
                  )}
                </p>
              )}
            </section>
          );
        })}
      </div>
      <div className="doc-legend">
        {view === "yours" ? (
          <span>
            <span className="ident">dotted</span> = {ids} identifiers detected locally (names, IDs, phones, addresses…)
          </span>
        ) : (
          <>
            <span><i style={{ background: "var(--green)" }} />never sent</span>
            {skeletonUsed && <span><i style={{ background: "var(--green-06)", border: "1.5px solid var(--green)" }} />heading only</span>}
            <span><span className="code">PERSON_1</span> placeholder</span>
            <span>dates shifted by a secret offset</span>
          </>
        )}
      </div>
    </article>
  );
}

export function AnswerCard({ receipt, map }: { receipt: ChatReceipt; map: PiiMap }) {
  const [raw, setRaw] = useState(false);
  const clean = receipt.answer.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^\s*[*-]\s+/gm, "• ").trim();
  const segs = restoreSegments(clean, map);
  const restoredCount = segs.filter((s) => s.code).length;
  return (
    <article className="paper answer">
      <h3>Answer</h3>
      <div className="text">
        {segs.map((s, i) =>
          s.code ? (
            <span key={i} className="restored" title={`the enclave only saw ${s.code}`}>
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </div>
      {restoredCount > 0 && (
        <p className="hand hand-note">↺ {restoredCount} value{restoredCount > 1 ? "s" : ""} restored locally — the enclave never saw them</p>
      )}
      <button className="linkish" onClick={() => setRaw(!raw)}>
        {raw ? "hide" : "show"} what the enclave actually answered
      </button>
      {raw && <div className="raw">{receipt.answer}</div>}
    </article>
  );
}
