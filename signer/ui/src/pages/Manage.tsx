import { useState, type ReactNode } from "react";

import { api, type ProposalInput, type ProposalResult, type StatusView } from "../api";
import { IconAlert, IconCheck } from "../icons";
import { packagePreview } from "../lib/slotPackage";
import { nextStep, sendLabel } from "../lib/execution";
import { Address, useSoleSigner } from "../ui";

type Action = "add" | "remove" | "threshold" | "escape";

const ESCAPE_PHRASE = "remove rotation";

/** Signer management, sent like any other transaction: another signer executes it (or the only signer at once) and every signer rotates. */
export function Manage({ status, pending, queueMode, onQueued }: { status: StatusView; pending: number; queueMode: boolean; onQueued: () => void }) {
  const [open, setOpen] = useState<Action>();
  const owners = status.signers.length;
  const blocked =
    pending > 0 && !queueMode ? "Finish the pending transaction first, or turn on the queue" : undefined;
  const queue = { queueMode, onQueued };

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

      {open === "add" && <AddSigner key="add" owners={owners} threshold={status.threshold} queue={queue} onClose={() => setOpen(undefined)} />}
      {open === "remove" && <RemoveSigner key="remove" status={status} queue={queue} onClose={() => setOpen(undefined)} />}
      {open === "threshold" && <ChangeThreshold key="threshold" status={status} queue={queue} onClose={() => setOpen(undefined)} />}

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

interface QueueProps {
  queueMode: boolean;
  onQueued: () => void;
}

/** Review, then sign and propose, for one admin action; or add it to the queue. */
function Proposal({
  input,
  ready,
  children,
  queue,
  onClose,
}: {
  input: () => ProposalInput;
  ready: boolean;
  children: ReactNode;
  /** Absent for actions that must be proposed on their own. */
  queue?: QueueProps;
  onClose: () => void;
}) {
  const sole = useSoleSigner();
  const [review, setReview] = useState<ProposalResult>();
  const [done, setDone] = useState<ProposalResult>();
  const [queued, setQueued] = useState(false);
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

  async function addToQueue() {
    setWorking(true);
    setError(undefined);
    try {
      await api.draftAdd(input());
      setQueued(true);
      queue?.onQueued();
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message.charAt(0).toUpperCase() + message.slice(1));
    } finally {
      setWorking(false);
    }
  }

  if (queued) {
    return (
      <div className="manage-panel">
        <div className="note ok">
          <IconCheck width="15" height="15" />
          <span>Added to the queue. Propose it from Transactions.</span>
        </div>
        <div className="tx-footer">
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="manage-panel">
        <div className="note ok">
          <IconCheck width="15" height="15" />
          <span>
            {sole ? "Executing" : "Proposed"} #{done.nonce}. {nextStep(sole)}
          </span>
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
            {working ? "Signing…" : sendLabel(sole)}
          </button>
        ) : (
          <>
            {queue && (
              <button type="button" className={queue.queueMode ? "primary" : ""} disabled={working || !ready} onClick={() => void addToQueue()}>
                Add to queue
              </button>
            )}
            {!queue?.queueMode && (
              <button type="button" className="primary" disabled={working || !ready} onClick={() => void submit(true)}>
                {working ? "Checking…" : "Review"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AddSigner({ owners, threshold, queue, onClose }: { owners: number; threshold: number; queue: QueueProps; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [next, setNext] = useState(threshold);
  const [confirmed, setConfirmed] = useState(false);
  const preview = packagePreview(code);
  return (
    <Proposal input={() => ({ kind: "add-signer", package: code.trim(), threshold: next })} ready={preview !== undefined && confirmed} queue={queue} onClose={onClose}>
      <p className="muted small">
        The new signer opens this app, chooses "I'm being added to a Safe" with this Safe's address, and sends you their slot package.
      </p>
      <label className="field">
        <span className="field-label">Their slot package</span>
        <textarea
          rows={3}
          spellCheck={false}
          placeholder="rotation-slot:…"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setConfirmed(false);
          }}
        />
      </label>
      {code.trim() !== "" && !preview && <div className="note critical">This is not a slot package.</div>}
      {preview && (
        <div className="package-signer">
          <span className="muted small">Signed by this signer address (it becomes slot {preview.slotId}):</span>
          <Address address={preview.operator} full />
          <label className="checkbox">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I confirmed this address with the new signer directly (a call or in person), not only through the message that carried the package.</span>
          </label>
        </div>
      )}
      <label className="field">
        <span className="field-label">Signatures needed afterwards</span>
        <ThresholdSelect value={next} max={owners + 1} onChange={setNext} />
      </label>
    </Proposal>
  );
}

function RemoveSigner({ status, queue, onClose }: { status: StatusView; queue: QueueProps; onClose: () => void }) {
  const [slotId, setSlotId] = useState<number>();
  const remaining = status.signers.length - 1;
  const [next, setNext] = useState(Math.min(status.threshold, Math.max(remaining, 1)));
  const removingMe = status.signers.find((signer) => signer.slotId === slotId)?.isMe;
  return (
    <Proposal input={() => ({ kind: "remove-signer", slotId: slotId!, threshold: next })} ready={slotId !== undefined && remaining >= 1} queue={queue} onClose={onClose}>
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

function ChangeThreshold({ status, queue, onClose }: { status: StatusView; queue: QueueProps; onClose: () => void }) {
  const [next, setNext] = useState(status.threshold);
  return (
    <Proposal input={() => ({ kind: "threshold", threshold: next })} ready={next !== status.threshold} queue={queue} onClose={onClose}>
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
