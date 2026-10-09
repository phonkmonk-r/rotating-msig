import { Fragment, useEffect, useState } from "react";
import { formatUnits } from "viem";

import { api, type DraftView, type ProposalResult, type Simulation } from "../api";
import { short, signedAmount, UNLIMITED_APPROVAL } from "../format";
import { IconAlert, IconCheck } from "../icons";
import { sendingLabel, sendLabel } from "../lib/execution";
import { Badge, useSoleSigner } from "../ui";

/**
 * Actions waiting in the local queue: simulated together as the Safe would run them, then proposed as one transaction,
 * so each signer signs (and rotates) once for all of them.
 */
export function QueueCard({ draft, pending, onChanged }: { draft: DraftView; pending: number; onChanged: () => void }) {
  const sole = useSoleSigner();
  const [simulation, setSimulation] = useState<Simulation>();
  const [simulating, setSimulating] = useState(false);
  const [review, setReview] = useState<ProposalResult>();
  const [done, setDone] = useState<ProposalResult>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const key = draft.items.map((item) => item.id).join(",");

  useEffect(() => {
    setReview(undefined);
    if (!key) return;
    let current = true;
    setSimulating(true);
    api.draftSimulate().then(
      (result) => current && setSimulation(result),
      (caught: Error) => current && setSimulation({ available: false, reason: caught.message, calls: [], changes: [], approvals: [] }),
    ).finally(() => current && setSimulating(false));
    return () => {
      current = false;
    };
  }, [key]);

  async function run(action: () => Promise<unknown>) {
    setError(undefined);
    try {
      await action();
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message.charAt(0).toUpperCase() + message.slice(1));
    }
    onChanged();
  }

  async function propose(preview: boolean) {
    setWorking(true);
    setError(undefined);
    try {
      const result = await api.draftPropose(preview);
      if (preview) setReview(result);
      else {
        setDone(result);
        setReview(undefined);
        onChanged();
      }
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message.charAt(0).toUpperCase() + message.slice(1));
    } finally {
      setWorking(false);
    }
  }

  if (done && draft.items.length === 0) {
    return (
      <section className="card queue-card">
        <div className="note ok">
          <IconCheck width="15" height="15" />
          <span>
            {sole ? "Executing" : "Proposed"} #{done.nonce} with {done.actions.length} action(s). {sole ? "Follow it below." : "Another signer executes it below."}
          </span>
          <button type="button" className="link" onClick={() => setDone(undefined)}>
            Dismiss
          </button>
        </div>
      </section>
    );
  }
  if (draft.items.length === 0) return null;

  const failed = simulation?.available ? simulation.calls.findIndex((call) => !call.ok) : -1;
  const blocked = pending > 0 ? "Finish the pending transaction before proposing the queue" : undefined;
  return (
    <section className="card queue-card">
      <div className="queue-head">
        <h2 className="card-title">Queue</h2>
        <span className="muted small">
          {draft.items.length} action{draft.items.length === 1 ? "" : "s"} · not signed or sent yet
        </span>
      </div>

      <ol className="queue-items">
        {draft.items.map((item, index) => (
          <li key={item.id} className="queue-item">
            <span className="queue-index">{index + 1}</span>
            <div className="queue-actions">
              {item.actions.map((action, i) => (
                <div key={i} className={`tx-action ${action.kind}`}>
                  {action.summary}
                </div>
              ))}
              {item.origin !== "app" && <span className="muted small mono">{item.origin}</span>}
            </div>
            <div className="queue-controls">
              <button type="button" className="icon-button" title="Move up" aria-label="Move up" disabled={index === 0} onClick={() => void run(() => api.draftMove(item.id, -1))}>
                ↑
              </button>
              <button
                type="button"
                className="icon-button"
                title="Move down"
                aria-label="Move down"
                disabled={index === draft.items.length - 1}
                onClick={() => void run(() => api.draftMove(item.id, 1))}
              >
                ↓
              </button>
              <button type="button" className="icon-button" title="Remove" aria-label="Remove" onClick={() => void run(() => api.draftRemove(item.id))}>
                ✕
              </button>
            </div>
          </li>
        ))}
      </ol>

      <div className="simulation">
        <div className="metric-label">Simulated outcome</div>
        {simulating ? (
          <p className="muted small">Simulating…</p>
        ) : !simulation ? null : !simulation.available ? (
          <p className="muted small">This network's RPC cannot simulate ({simulation.reason}). Execution is still simulated before it is sent.</p>
        ) : (
          <>
            {failed >= 0 ? (
              <div className="note critical">
                <IconAlert width="15" height="15" />
                <span>
                  Call {failed + 1} of {simulation.calls.length} would fail: {simulation.calls[failed]!.error}
                </span>
              </div>
            ) : (
              <div className="note ok">
                <IconCheck width="15" height="15" />
                <span>All {simulation.calls.length} call(s) succeed</span>
              </div>
            )}
            {simulation.changes.length > 0 && (
              <dl className="kv">
                {simulation.changes.map((change) => (
                  <Fragment key={change.token}>
                    <dt>{change.symbol}</dt>
                    <dd className={BigInt(change.delta) < 0n ? "negative" : "positive"}>{signedAmount(change.delta, change.decimals, change.symbol)}</dd>
                  </Fragment>
                ))}
              </dl>
            )}
            {simulation.approvals.map((approval) => (
              <div key={`${approval.token}${approval.spender}`} className="muted small">
                Approves {short(approval.spender)} to spend{" "}
                {BigInt(approval.amount) >= UNLIMITED_APPROVAL ? <Badge tone="warning">unlimited</Badge> : `${formatUnits(BigInt(approval.amount), approval.decimals)}`} {approval.symbol}
              </div>
            ))}
          </>
        )}
      </div>

      {review && review.warnings.length > 0 && (
        <div className="review-panel">
          {review.warnings.map((warning) => (
            <div key={warning} className="note warning">
              <IconAlert width="15" height="15" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}
      {blocked && <p className="muted small">{blocked}.</p>}
      {error && <div className="note critical">{error}</div>}

      <div className="tx-footer">
        <button type="button" disabled={working} onClick={() => void run(() => api.draftClear())}>
          Clear
        </button>
        {review ? (
          <button type="button" className="primary" disabled={working} onClick={() => void propose(false)}>
            {working ? sendingLabel(sole) : `${sendLabel(sole)} ${draft.items.length} action${draft.items.length === 1 ? "" : "s"}`}
          </button>
        ) : (
          <button type="button" className="primary" disabled={working || blocked !== undefined || failed >= 0} onClick={() => void propose(true)}>
            {working ? "Checking…" : "Review"}
          </button>
        )}
      </div>
    </section>
  );
}
