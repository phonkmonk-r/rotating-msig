import { useEffect, useState } from "react";

import { api, desktop, type JoinProgress, type ProposalInput, type ProposalResult } from "../api";
import { IconAlert, IconCheck } from "../icons";

/**
 * Renews this signer's key list: derives a fresh list from the seed (or Ledger), then proposes switching the slot to
 * it and staging its first keys, in one Safe transaction that needs the threshold like any other.
 */
export function RenewKeys({ compact = false }: { compact?: boolean }) {
  const [stage, setStage] = useState<"idle" | "deriving" | "review" | "signing" | "done">("idle");
  const [progress, setProgress] = useState<JoinProgress>();
  const [review, setReview] = useState<ProposalResult & { input: ProposalInput }>();
  const [error, setError] = useState<string>();

  useEffect(() => (desktop ? desktop.onProgress(setProgress) : undefined), []);

  async function prepare() {
    setStage("deriving");
    setError(undefined);
    try {
      const input = await api.renewKeys();
      setReview({ ...(await api.propose(input, true)), input });
      setStage("review");
    } catch (caught) {
      setError((caught as Error).message);
      setStage("idle");
    }
  }

  async function propose() {
    if (!review) return;
    setStage("signing");
    setError(undefined);
    try {
      const result = await api.propose(review.input, false);
      setReview({ ...result, input: review.input });
      setStage("done");
    } catch (caught) {
      setError((caught as Error).message);
      setStage("review");
    }
  }

  const percent = progress?.stage === "deriving" && progress.total ? Math.round(((progress.done ?? 0) / progress.total) * 100) : undefined;
  return (
    <div className="renew-keys">
      {!compact && stage === "idle" && (
        <p className="muted small">
          Derives a fresh list of keys from your seed (a few seconds; several minutes on a Ledger) and proposes moving your slot onto it. Like any Safe transaction it needs the
          threshold; when it executes, your slot rotates straight onto the new list.
        </p>
      )}
      {stage === "deriving" && (
        <div className="progress-block">
          <div className="progress-label">
            <span>Deriving your new key list</span>
            {percent !== undefined && <span className="muted">{percent}%</span>}
          </div>
          <div className="bar">
            <div style={{ width: `${percent ?? 8}%` }} />
          </div>
        </div>
      )}
      {review && stage !== "done" && (
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
      )}
      {stage === "done" && review && (
        <div className="note ok">
          <IconCheck width="15" height="15" />
          <span>Proposed #{review.nonce}. Once another signer executes it, Keyturn switches to your new key list by itself.</span>
        </div>
      )}
      {error && <div className="note critical">{error.charAt(0).toUpperCase() + error.slice(1)}</div>}
      {stage !== "done" && (
        <div className="tx-footer">
          {stage === "review" || stage === "signing" ? (
            <>
              <button type="button" onClick={() => setStage("idle")} disabled={stage === "signing"}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={() => void propose()} disabled={stage === "signing"}>
                {stage === "signing" ? "Signing…" : "Sign & propose"}
              </button>
            </>
          ) : (
            <button type="button" className={compact ? "primary" : ""} onClick={() => void prepare()} disabled={stage === "deriving"}>
              {stage === "deriving" ? "Deriving…" : "Renew my key list"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
