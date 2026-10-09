import { useState } from "react";

import { api, type DraftView, type Execution, type QueueItem, type StatusView } from "../api";
import { explorer, short } from "../format";
import { IconAlert, IconCheck, IconExternal, IconInbox, IconPlus } from "../icons";
import { executionInFlight, executionTone } from "../lib/execution";
import { Avatar, Badge, PageHeader } from "../ui";
import { NewTransaction } from "./NewTransaction";
import { QueueCard } from "./QueueCard";

const EXECUTION_POLL_MS = 3_000;

export function Transactions({
  status,
  queue,
  draft,
  onBusy,
  onRefresh,
}: {
  status: StatusView;
  queue: QueueItem[];
  draft: DraftView;
  onBusy: (busy: boolean) => void;
  onRefresh: () => void;
}) {
  const [composing, setComposing] = useState(() => window.location.hash.includes("compose"));
  // Executions this window ran: kept after the transaction leaves the queue, so the final steps stay readable.
  const [finished, setFinished] = useState<{ item: QueueItem; execution: Execution }[]>([]);
  const done = finished.filter((entry) => !queue.some((item) => item.safeTxHash === entry.item.safeTxHash));
  return (
    <>
      <PageHeader
        title="Transactions"
        subtitle={queue.length === 0 ? "Nothing pending" : `${queue.length} pending`}
        actions={
          !composing && (
            <button
              type="button"
              className="primary"
              onClick={() => setComposing(true)}
              disabled={queue.length > 0 && !draft.enabled}
              title={queue.length > 0 && !draft.enabled ? "Finish the pending transaction first, or turn on the queue" : undefined}
            >
              <IconPlus /> New transaction
            </button>
          )
        }
      />
      {composing && <NewTransaction status={status} queueMode={draft.enabled} onClose={() => setComposing(false)} onProposed={onRefresh} />}
      <QueueCard draft={draft} pending={queue.length} onChanged={onRefresh} />
      {done.map(({ item, execution }) => (
        <FinishedCard
          key={item.safeTxHash}
          item={item}
          execution={execution}
          chainId={status.chainId}
          onDismiss={() => setFinished((list) => list.filter((entry) => entry.item.safeTxHash !== item.safeTxHash))}
        />
      ))}
      {queue.length === 0 && !composing && draft.items.length === 0 && done.length === 0 ? (
        <div className="empty-state">
          <IconInbox />
          <p>No pending transactions</p>
          <span className="muted">Propose one, or wait for a signer to.</span>
        </div>
      ) : (
        <div className="stack">
          {queue.map((item) => (
            <TxCard
              key={item.safeTxHash}
              item={item}
              status={status}
              onBusy={onBusy}
              onFinished={(execution) => setFinished((list) => [{ item, execution }, ...list.filter((entry) => entry.item.safeTxHash !== item.safeTxHash)])}
            />
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

function TxCard({
  item,
  status,
  onBusy,
  onFinished,
}: {
  item: QueueItem;
  status: StatusView;
  onBusy: (busy: boolean) => void;
  onFinished: (execution: Execution) => void;
}) {
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
        while (executionInFlight(execution)) {
          await new Promise((resolve) => setTimeout(resolve, execution.status === "preparing" ? 1_000 : EXECUTION_POLL_MS));
          execution = await api.execution(execution.safeTxHash);
          setStage({ kind: "executing", execution });
        }
        onFinished(execution);
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

/** An execution that has left the queue, with its final steps, until the signer dismisses it. */
function FinishedCard({ item, execution, chainId, onDismiss }: { item: QueueItem; execution: Execution; chainId: number; onDismiss: () => void }) {
  const tone = executionTone(execution.status);
  return (
    <article className="card tx finished">
      <div className="tx-top">
        <span className="tx-nonce">#{item.nonce}</span>
        <div className="tx-actions-list">
          {item.actions.map((a, i) => (
            <div key={i} className={`tx-action ${a.kind}`}>
              {a.summary}
            </div>
          ))}
        </div>
        <Badge tone={tone === "pending" ? "neutral" : tone}>{execution.status === "success" ? "Executed" : execution.status}</Badge>
      </div>
      <ExecutionStatus execution={execution} chainId={chainId} />
      <div className="tx-footer">
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </article>
  );
}

/** The execution's steps as they happen: simulate, gas for the key, sign and send, inclusion, rotation, sweep. */
function ExecutionStatus({ execution, chainId }: { execution: Execution; chainId: number }) {
  const tone = executionTone(execution.status);
  return (
    <div className={`note ${tone} column execution-steps`}>
      <ol>
        {execution.steps.map((step) => (
          <li key={step.id} className={`step ${step.status}`}>
            <span className="step-icon">
              {step.status === "done" ? (
                <IconCheck width="14" height="14" />
              ) : step.status === "active" ? (
                <span className="spinner" />
              ) : step.status === "failed" ? (
                <IconAlert width="14" height="14" />
              ) : step.status === "skipped" ? (
                "–"
              ) : (
                <span className="step-dot" />
              )}
            </span>
            <span className="step-text">
              <span className="step-label">{step.label}</span>
              {step.detail && <span className="small step-detail">{step.detail}</span>}
            </span>
            {step.transactionHash && (
              <a href={explorer(chainId, "tx", step.transactionHash)} target="_blank" rel="noreferrer" className="mono small step-link">
                {short(step.transactionHash)} <IconExternal />
              </a>
            )}
          </li>
        ))}
      </ol>
      {execution.message && <span className="small">{execution.message}</span>}
    </div>
  );
}

