import { useState, type ReactNode } from "react";

import { api, type ProposalInput, type ProposalResult, type StatusView } from "../api";
import { IconAlert, IconCheck } from "../icons";

type Action = "add" | "remove" | "threshold" | "escape";

const ESCAPE_PHRASE = "remove rotation";

/** Signer management, proposed like any other transaction: another signer executes it and both rotate. */
export function Manage({ status, pending }: { status: StatusView; pending: number }) {
  const [open, setOpen] = useState<Action>();
  const owners = status.signers.length;
  const blocked = pending > 0 ? "Finish the pending transaction first" : status.threshold < 2 ? "Proposing needs a threshold of at least 2" : undefined;

  return (
    <section className="card">
      <h2 className="card-title">Manage signers</h2>
      {blocked && <p className="muted small">{blocked}.</p>}
      <div className="manage-actions">
        {(
          [
            ["add", "Add a signer"],
            ["remove", "Remove a signer"],
            ["threshold", "Change threshold"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className={open === id ? "active" : ""} disabled={blocked !== undefined} onClick={() => setOpen(open === id ? undefined : id)}>
            {label}
          </button>
        ))}
      </div>

      {open === "add" && <AddSigner key="add" owners={owners} threshold={status.threshold} onClose={() => setOpen(undefined)} />}
      {open === "remove" && <RemoveSigner key="remove" status={status} onClose={() => setOpen(undefined)} />}
      {open === "threshold" && <ChangeThreshold key="threshold" status={status} onClose={() => setOpen(undefined)} />}

      <details className="danger-zone" open={open === "escape"} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open ? "escape" : undefined)}>
        <summary>Remove rotation (escape hatch)</summary>
        {open === "escape" && <Escape blocked={blocked} onClose={() => setOpen(undefined)} />}
      </details>
    </section>
  );
}

function ThresholdSelect({ value, max, onChange }: { value: number; max: number; onChange: (value: number) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <option key={n} value={n}>
          {n} of {max}
        </option>
      ))}
    </select>
  );
}

/** Review, then sign and propose, for one admin action. */
function Proposal({ input, ready, children, onClose }: { input: () => ProposalInput; ready: boolean; children: ReactNode; onClose: () => void }) {
  const [review, setReview] = useState<ProposalResult>();
  const [done, setDone] = useState<ProposalResult>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  async function submit(preview: boolean) {
    setWorking(true);
    setError(undefined);
    try {
      const result = await api.propose(input(), preview);
      if (preview) setReview(result);
      else setDone(result);
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message.charAt(0).toUpperCase() + message.slice(1));
    } finally {
      setWorking(false);
    }
  }

  if (done) {
    return (
      <div className="manage-panel">
        <div className="note ok">
          <IconCheck width="15" height="15" />
          <span>Proposed #{done.nonce}. Another signer executes it from Transactions.</span>
        </div>
        <div className="tx-footer">
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="manage-panel">
      {review ? (
        <div className="review-panel">
          {review.actions.map((action, i) => (
            <div key={i} className={`tx-action ${action.kind}`}>
              {action.summary}
            </div>
          ))}
          {review.warnings.map((warning) => (
            <div key={warning} className="note warning">
              <IconAlert width="15" height="15" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      ) : (
        children
      )}
      {error && <div className="note critical">{error}</div>}
      <div className="tx-footer">
        <button type="button" onClick={review ? () => setReview(undefined) : onClose} disabled={working}>
          {review ? "Back" : "Cancel"}
        </button>
        {review ? (
          <button type="button" className="primary" disabled={working} onClick={() => void submit(false)}>
            {working ? "Signing…" : "Sign & propose"}
          </button>
        ) : (
          <button type="button" className="primary" disabled={working || !ready} onClick={() => void submit(true)}>
            {working ? "Checking…" : "Review"}
          </button>
        )}
      </div>
    </div>
  );
}

function AddSigner({ owners, threshold, onClose }: { owners: number; threshold: number; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [next, setNext] = useState(threshold);
  return (
    <Proposal input={() => ({ kind: "add-signer", package: code.trim(), threshold: next })} ready={code.trim().startsWith("rotation-slot:")} onClose={onClose}>
      <p className="muted small">
        The new signer opens this app, chooses "I'm being added to a Safe" with this Safe's address, and sends you their slot package.
      </p>
      <label className="field">
        <span className="field-label">Their slot package</span>
        <textarea rows={3} spellCheck={false} placeholder="rotation-slot:…" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Signatures needed afterwards</span>
        <ThresholdSelect value={next} max={owners + 1} onChange={setNext} />
      </label>
    </Proposal>
  );
}

function RemoveSigner({ status, onClose }: { status: StatusView; onClose: () => void }) {
  const [slotId, setSlotId] = useState<number>();
  const remaining = status.signers.length - 1;
  const [next, setNext] = useState(Math.min(status.threshold, Math.max(remaining, 1)));
  const removingMe = status.signers.find((signer) => signer.slotId === slotId)?.isMe;
  return (
    <Proposal input={() => ({ kind: "remove-signer", slotId: slotId!, threshold: next })} ready={slotId !== undefined && remaining >= 1} onClose={onClose}>
      <label className="field">
        <span className="field-label">Signer</span>
        <select value={slotId ?? ""} onChange={(e) => setSlotId(e.target.value === "" ? undefined : Number(e.target.value))}>
          <option value="">Choose a slot</option>
          {status.signers.map((signer) => (
            <option key={signer.slotId} value={signer.slotId}>
              Slot {signer.slotId}
              {signer.isMe ? " (you)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Signatures needed afterwards</span>
        <ThresholdSelect value={next} max={Math.max(remaining, 1)} onChange={setNext} />
      </label>
      {removingMe && (
        <div className="note warning">
          <IconAlert width="15" height="15" />
          <span>This removes you: once it executes, this app can no longer sign for the Safe.</span>
        </div>
      )}
    </Proposal>
  );
}

function ChangeThreshold({ status, onClose }: { status: StatusView; onClose: () => void }) {
  const [next, setNext] = useState(status.threshold);
  return (
    <Proposal input={() => ({ kind: "threshold", threshold: next })} ready={next !== status.threshold} onClose={onClose}>
      <label className="field">
        <span className="field-label">Signatures needed</span>
        <ThresholdSelect value={next} max={status.signers.length} onChange={setNext} />
      </label>
      {next === 1 && (
        <div className="note warning">
          <IconAlert width="15" height="15" />
          <span>With 1, any single signer controls the Safe, and the app can no longer propose (the executor would sign alone).</span>
        </div>
      )}
    </Proposal>
  );
}

function Escape({ blocked, onClose }: { blocked?: string; onClose: () => void }) {
  const [phrase, setPhrase] = useState("");
  return (
    <Proposal input={() => ({ kind: "escape" })} ready={!blocked && phrase.trim().toLowerCase() === ESCAPE_PHRASE} onClose={onClose}>
      <p className="muted small">
        Removes the rotation guard, turning this back into a plain Safe. Nobody rotates in this transaction, so treat the keys of everyone who signs it as burned. Use it only if the guard
        itself is in the way.
      </p>
      <label className="field">
        <span className="field-label">Type "{ESCAPE_PHRASE}" to continue</span>
        <input value={phrase} onChange={(e) => setPhrase(e.target.value)} />
      </label>
    </Proposal>
  );
}
