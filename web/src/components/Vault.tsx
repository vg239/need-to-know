import type { VaultDoc, VaultRecord } from "../lib/vault";

export interface VaultItem {
  rec: VaultRecord;
  doc: VaultDoc;
}

/** The private RAG library: encrypted with a key from your NEAR wallet, stored in this browser only. */
export function VaultPanel(props: {
  account: string | null;
  unlocked: boolean;
  busy: string;
  items: VaultItem[];
  activeId: string | null;
  canSave: boolean;
  currentTitle: string;
  error: string;
  onConnect: () => void;
  onUnlock: () => void;
  onLock: () => void;
  onSave: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { account, unlocked, busy, items, activeId, canSave, currentTitle, error } = props;
  return (
    <section className="paper vault" aria-label="Private vault">
      <div className="vault-head">
        <div>
          <h3>Your private vault</h3>
          <p className="muted">
            Encrypted library for your own documents and their Q&amp;A history. AES-256-GCM with a key derived from your NEAR wallet
            signature, stored in this browser only (IndexedDB). Our server never sees it.
          </p>
        </div>
        {!account ? (
          <button className="btn" onClick={props.onConnect}>
            Connect NEAR wallet
          </button>
        ) : !unlocked ? (
          <button className="btn" onClick={props.onUnlock} disabled={!!busy}>
            {busy || "Unlock vault (sign once)"}
          </button>
        ) : (
          <div className="vault-actions">
            <button className="btn" onClick={props.onSave} disabled={!canSave || !!busy} title={canSave ? "" : "Already in your vault"}>
              {busy || (canSave ? `Save "${currentTitle.slice(0, 28)}" to vault` : "Saved in vault ✓")}
            </button>
            <button className="btn ghost" onClick={props.onLock}>
              Lock
            </button>
          </div>
        )}
      </div>
      {error && <p className="error-note">✗ {error}</p>}
      {unlocked && (
        <ul className="vault-list">
          {items.length === 0 && <li className="muted">Empty. Open or upload a document, then save it here.</li>}
          {items.map(({ rec, doc }) => (
            <li key={rec.id} className={rec.id === activeId ? "active" : ""}>
              <button className="vault-open" onClick={() => props.onOpen(rec.id)}>
                <b>{doc.title}</b>
                <span className="muted">
                  {doc.pdf ? `${doc.pdf.pages} pages · ` : ""}
                  {doc.history.length} question{doc.history.length === 1 ? "" : "s"} · {(rec.bytes / 1024).toFixed(0)} KB encrypted · sha256{" "}
                  {rec.docSha256.slice(0, 10)}
                </span>
              </button>
              <button className="linkish" onClick={() => props.onDelete(rec.id)}>
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {account && !unlocked && (
        <p className="muted vault-note">
          Signed in as <b>{account}</b>. Unlocking asks your wallet to sign a fixed message; the signature never leaves this tab and
          deterministically re-creates the same key on every visit.
        </p>
      )}
    </section>
  );
}

export function HistoryList({ entries, restore }: { entries: VaultDoc["history"]; restore: (s: string) => string }) {
  if (!entries.length) return null;
  return (
    <section className="paper history" aria-label="Earlier questions">
      <h3>Earlier questions on this document</h3>
      <p className="muted">From your encrypted vault. Answers are restored locally with this document's identity map.</p>
      <ol>
        {[...entries].reverse().map((h) => (
          <li key={h.at}>
            <b>{h.question}</b>
            <span className="muted">
              {new Date(h.at).toLocaleString()} · {h.exposurePct.toFixed(1)}% sent · {h.identifiersSent} identifiers
            </span>
            <p>{restore(h.answer).slice(0, 360)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
