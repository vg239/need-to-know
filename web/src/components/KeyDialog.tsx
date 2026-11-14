import { useEffect, useState } from "react";

/** Bring-your-own NEAR AI key. The key lives in this browser's localStorage only. */
export function KeyDialog({
  open,
  onClose,
  userKey,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  userKey: string;
  onSave: (k: string) => void;
}) {
  const [draft, setDraft] = useState(userKey);
  const [show, setShow] = useState(false);
  useEffect(() => setDraft(userKey), [userKey, open]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, onClose]);
  if (!open) return null;

  const trimmed = draft.trim();
  return (
    <div className="key-backdrop" onClick={onClose}>
      <div className="paper key-card tape" role="dialog" aria-modal="true" aria-labelledby="key-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="key-title">Use your own NEAR AI key</h3>
        <p>Run every question on your own NEAR AI Cloud credits.</p>
        <ul>
          <li>Stored only in <b>this browser</b> (localStorage). Remove it any time.</li>
          <li>Sent to our stateless proxy in a header for each request, used for that one call to NEAR AI, then dropped. Never stored or logged.</li>
          <li>
            Get one at <a href="https://cloud.near.ai" target="_blank" rel="noreferrer">cloud.near.ai</a>, or claim $10 free via{" "}
            <a href="https://nearbuilders.org/join" target="_blank" rel="noreferrer">NEAR Builders</a>.
          </li>
          <li className="muted">Like anything in localStorage, scripts on this page could read it. A key with a small balance is a good idea.</li>
        </ul>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(trimmed);
            onClose();
          }}
        >
          <input
            className="input"
            type={show ? "text" : "password"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="sk-…"
            autoComplete="off"
            spellCheck={false}
            aria-label="NEAR AI API key"
          />
          <button type="button" className="btn ghost" onClick={() => setShow(!show)}>
            {show ? "hide" : "show"}
          </button>
        </form>
        <p className="status">
          Personal key:{" "}
          <b>{userKey ? `your key ending …${userKey.slice(-4)}` : "no personal key saved"}</b>
        </p>
        <div className="actions">
          <button className="btn ghost" disabled={!userKey} onClick={() => onSave("")}>
            Remove my key
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn"
              disabled={!trimmed || /\s/.test(trimmed)}
              onClick={() => {
                onSave(trimmed);
                onClose();
              }}
            >
              Save key
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
