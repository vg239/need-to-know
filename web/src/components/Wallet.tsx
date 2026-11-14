import { useState } from "react";

/** Top-bar wallet control: connect, show the account, disconnect. */
export function WalletButton({ account, onConnect, onDisconnect }: { account: string | null; onConnect: () => void; onDisconnect: () => void }) {
  const [menu, setMenu] = useState(false);
  if (!account)
    return (
      <button className="link keychip" onClick={onConnect} title="Connect a NEAR wallet: identity, receipt co-signing and your encrypted vault">
        <span className="k-dot" aria-hidden="true" />
        Connect NEAR
      </button>
    );
  return (
    <span className="wallet-wrap">
      <button className="link keychip" onClick={() => setMenu(!menu)} aria-expanded={menu} title={account}>
        <span className="k-dot on" aria-hidden="true" />
        {account.length > 22 ? `${account.slice(0, 10)}…${account.slice(-8)}` : account}
      </button>
      {menu && (
        <span className="wallet-menu paper">
          <span className="muted">Signed in as</span>
          <b className="mono">{account}</b>
          <button
            className="btn ghost"
            onClick={() => {
              setMenu(false);
              onDisconnect();
            }}
          >
            Disconnect
          </button>
        </span>
      )}
    </span>
  );
}
