import { useState } from "react";

import { api, type Execution, type QueueItem, type StatusView } from "../api";
import { explorer, short } from "../format";
import { IconAlert, IconCheck, IconExternal, IconInbox } from "../icons";
import { Avatar, Badge, PageHeader } from "../ui";

const EXECUTION_POLL_MS = 3_000;

export function Transactions({ status, queue, onBusy }: { status: StatusView; queue: QueueItem[]; onBusy: (busy: boolean) => void }) {
  return (
    <>
      <PageHeader title="Transactions" subtitle={queue.length === 0 ? "Nothing pending" : `${queue.length} pending`} />
      {queue.length === 0 ? (
        <div className="empty-state">
          <IconInbox />
          <p>No pending transactions</p>
          <span className="muted">New proposals show up here automatically.</span>
        </div>
      ) : (
        <div className="stack">
          {queue.map((item) => (
            <TxCard key={item.safeTxHash} item={item} status={status} onBusy={onBusy} />
          ))}
        </div>
      )}
    </>
  );
}

type Stage =
  | { kind: "idle" }
  | { kind: "review" }
  | { kind: "working" }
  | { kind: "confirmed" }
  | { kind: "executing"; execution: Execution }
  | { kind: "failed"; message: string };

function TxCard({ item, status, onBusy }: { item: QueueItem; status: StatusView; onBusy: (busy: boolean) => void }) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const needed = Math.max(status.threshold - 1, 0);
  const counting = item.confirmations.filter((c) => c.counts).length;
  const { action, blockers, warnings } = item.verdict;

  async function run() {
    setStage({ kind: "working" });
    onBusy(true);
    try {
      if (action === "confirm") {
        await api.confirm(item.safeTxHash);
        setStage({ kind: "confirmed" });
      } else {
        let execution = await api.execute(item.safeTxHash);
        setStage({ kind: "executing", execution });
        while (execution.status === "pending" || execution.status === "stuck") {
          await new Promise((resolve) => setTimeout(resolve, EXECUTION_POLL_MS));
          execution = await api.execution(execution.transactionHash);
          setStage({ kind: "executing", execution });
        }
      }
    } catch (caught) {
      setStage({ kind: "failed", message: (caught as Error).message });
    } finally {
      onBusy(false);
    }
  }

  const actionLabel = action === "confirm" ? "Confirm" : action === "execute" ? "Execute" : undefined;
  return (
    <article className={`card tx ${actionLabel ? "actionable" : ""}`}>
      <div className="tx-top">
        <span className="tx-nonce">#{item.nonce}</span>
        <div className="tx-actions-list">
          {item.actions.length === 0 ? (
            <span className="muted">Details unavailable</span>
          ) : (
            item.actions.map((a, i) => (
              <div key={i} className={`tx-action ${a.kind}`}>
                {a.summary}
              </div>
            ))
          )}
        </div>
        {actionLabel ? <Badge tone="accent">Your turn</Badge> : <Badge>Waiting</Badge>}
      </div>

      <div className="tx-meta">
        <span className="signatures">
          <span className="muted">Signatures</span>
          <span className="signature-avatars">
            {item.confirmations.map((c) => (
              <span key={c.owner} title={`${c.owner}${c.counts ? "" : " (no longer counts)"}`} className={c.counts ? "" : "stale"}>
                <Avatar address={c.owner} size={20} />
              </span>
            ))}
          </span>
          <span className={counting >= needed ? "ok-text" : ""}>
            {counting}/{needed}
          </span>
        </span>
        <span className="mono muted small" title={item.safeTxHash}>
          {short(item.safeTxHash)}
        </span>
      </div>

      {warnings.map((w) => (
        <div key={w} className="note warning">
          <IconAlert width="15" height="15" />
          <span>{w}</span>
        </div>
      ))}

      {stage.kind === "confirmed" && (
        <div className="note ok">
          <IconCheck width="15" height="15" />
          <span>Confirmation posted.</span>
        </div>
      )}
      {stage.kind === "executing" && <ExecutionStatus execution={stage.execution} chainId={status.chainId} />}
      {stage.kind === "failed" && (
        <div className="note critical">
          <IconAlert width="15" height="15" />
          <span>{stage.message}</span>
        </div>
      )}

      {stage.kind !== "confirmed" && stage.kind !== "executing" && (
        <>
          {action === "none" ? (
            blockers.length > 0 && <p className="blocked muted small">{blockers[0]}</p>
          ) : stage.kind === "idle" || stage.kind === "failed" ? (
            <div className="tx-footer">
              <button type="button" className="primary" onClick={() => setStage({ kind: "review" })}>
                {actionLabel}
              </button>
            </div>
          ) : (
            <Review action={action} status={status} item={item} working={stage.kind === "working"} onRun={() => void run()} onCancel={() => setStage({ kind: "idle" })} />
          )}
        </>
      )}
    </article>
  );
}

function Review({
  action,
  item,
  status,
  working,
  onRun,
  onCancel,
}: {
  action: "confirm" | "execute";
  item: QueueItem;
  status: StatusView;
  working: boolean;
  onRun: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="review">
      {action === "confirm" ? (
        <dl className="kv">
          <dt>Signing as</dt>
          <dd className="mono">{status.me && `Slot ${status.me.slotId} · ${short(status.me.address)}`}</dd>
          <dt>Hash</dt>
          <dd className="mono small">{item.safeTxHash}</dd>
        </dl>
      ) : (
        <ul className="checklist">
          <li>Simulated before sending</li>
          <li>Sent via {status.executionHost}</li>
          <li>Signers rotate to fresh keys</li>
        </ul>
      )}
      <div className="tx-footer">
        <button type="button" onClick={onCancel} disabled={working}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={working} onClick={onRun}>
          {working ? (action === "confirm" ? "Signing…" : "Sending…") : action === "confirm" ? "Sign" : "Execute"}
        </button>
      </div>
    </div>
  );
}

function ExecutionStatus({ execution, chainId }: { execution: Execution; chainId: number }) {
  const link = explorer(chainId, "tx", execution.transactionHash);
  const hash = (
    <a href={link} target="_blank" rel="noreferrer" className="mono">
      {short(execution.transactionHash)} <IconExternal />
    </a>
  );
  if (execution.status === "success") {
    return (
      <div className="note ok column">
        <span>
          <IconCheck width="15" height="15" /> Executed {hash} · {Number(execution.gasUsed).toLocaleString()} gas
        </span>
        {execution.rotated && execution.rotated.length > 0 && (
          <span className="muted small">{execution.rotated.map((r) => `Slot ${r.slotId} → ${short(r.to)}`).join(" · ")}</span>
        )}
      </div>
    );
  }
  if (execution.status === "reverted") {
    return (
      <div className="note critical column">
        <span>Reverted {hash}</span>
        <span className="small">{execution.message}</span>
      </div>
    );
  }
  return (
    <div className={`note ${execution.status === "stuck" ? "warning" : "pending"} column`}>
      <span>
        <span className="spinner" /> Waiting for inclusion {hash}
      </span>
      {execution.message && <span className="small">{execution.message}</span>}
    </div>
  );
}
