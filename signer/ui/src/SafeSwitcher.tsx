import { useEffect, useRef, useState } from "react";

import { desktop, type SafeSummary, type StatusView } from "./api";
import { short } from "./format";
import { IconPlus } from "./icons";
import { Avatar } from "./ui";

/** The Safe card at the top of the sidebar; in the desktop app it opens a list of the profile's Safes. */
export function SafeSwitcher({ status, onSwitched, onAdd }: { status: StatusView; onSwitched: () => void; onAdd?: () => void }) {
  const [open, setOpen] = useState(() => window.location.hash.includes("switcher"));
  const [safes, setSafes] = useState<SafeSummary[]>();
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !desktop) return;
    setSafes(undefined);
    void desktop.listSafes().then(setSafes, (caught: Error) => setError(caught.message));
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  async function select(key: string) {
    setError(undefined);
    try {
      await desktop!.selectSafe(key);
      setOpen(false);
      onSwitched();
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  const chip = (
    <>
      <Avatar address={status.safe} size={30} />
      <div>
        <div className="safe-chip-name">Safe</div>
        <div className="mono small">{short(status.safe)}</div>
      </div>
      <span className={`network ${status.chainId === 1 ? "mainnet" : "testnet"}`}>{status.chainId === 1 ? "Ethereum" : status.chainName}</span>
    </>
  );
  if (!desktop) {
    return (
      <div className="safe-chip" title={status.safe}>
        {chip}
      </div>
    );
  }

  return (
    <div className="safe-switcher" ref={box}>
      <button type="button" className={`safe-chip ${open ? "open" : ""}`} title="Switch Safe" onClick={() => setOpen(!open)}>
        {chip}
      </button>
      {open && (
        <div className="safe-menu" role="menu">
          {!safes && !error && <div className="muted small safe-menu-note">Loading…</div>}
          {safes?.map((safe) => (
            <button key={safe.key} type="button" role="menuitem" className={`safe-option ${safe.active ? "active" : ""}`} onClick={() => void select(safe.key)}>
              <Avatar address={safe.safe} size={24} />
              <span className="safe-option-text">
                <span className="mono small">{short(safe.safe)}</span>
                <span className="muted small">
                  {safe.chainName} · slot {safe.slotId}
                  {safe.error ? " · not connected" : ""}
                </span>
              </span>
              {(safe.needsYou ?? 0) > 0 && <span className="count" title="Transactions waiting for you">{safe.needsYou}</span>}
              {safe.queued > 0 && (
                <span className="count muted-count" title="Actions in this Safe's queue">
                  {safe.queued}
                </span>
              )}
            </button>
          ))}
          {error && <div className="note critical safe-menu-note">{error}</div>}
          {onAdd && (
            <button
              type="button"
              className="safe-option add"
              onClick={() => {
                setOpen(false);
                onAdd();
              }}
            >
              <IconPlus /> Add a Safe
            </button>
          )}
        </div>
      )}
    </div>
  );
}
