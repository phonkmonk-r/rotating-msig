import { useCallback, useEffect, useRef, useState } from "react";

import { api, hasToken, type ExecuteResult, type QueueItem, type StatusView } from "./api";
import { eth, explorer, short } from "./format";

const REFRESH_MS = 10_000;
const LOW_GAS_WEI = 5_000_000_000_000_000n;

export function App() {
  const [status, setStatus] = useState<StatusView>();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [error, setError] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    try {
      const [nextStatus, nextQueue] = await Promise.all([api.status(), api.queue()]);
      setStatus(nextStatus);
      setQueue(nextQueue);
      setError(undefined);
      setUpdatedAt(new Date());
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!hasToken) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!hasToken) {
    return (
      <main className="app">
        <h1>Rotation Signer</h1>
        <section className="panel">
          <p>This page needs the session link printed by <code>rotation-signer</code> in your terminal. Open that link instead.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="header">
        <div>
          <h1>Rotation Signer</h1>
          {status && (
            <p className="muted">
              Safe{" "}
              <a href={explorer(status.chainId, "address", status.safe)} target="_blank" rel="noreferrer" className="mono">
                {short(status.safe)}
              </a>{" "}
              · {status.chainName} · {status.threshold} of {status.owners.length} · nonce {status.nonce}
            </p>
          )}
        </div>
        <button type="button" onClick={() => void refresh()}>
          Refresh
        </button>
      </header>

      {error && <p className="banner critical">Could not reach the signer: {error}</p>}
      {!status && !error && <p className="muted">Loading…</p>}
      {status && (
        <>
          <Identity status={status} />
          {status.findings.length > 0 && (
            <section className="panel findings">
              <h2>Safe health</h2>
              <ul>
                {status.findings.map((finding, i) => (
                  <li key={i} className={finding.severity}>
                    <span className="badge">{finding.severity}</span>
                    {finding.slotId !== undefined && <strong>slot {finding.slotId}</strong>} {finding.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Queue
            status={status}
            queue={queue}
            onBusy={(value) => {
              busy.current = value;
              if (!value) void refresh();
            }}
          />
        </>
      )}
      <footer className="footer muted">{updatedAt && `Updated ${updatedAt.toLocaleTimeString()}`}</footer>
    </main>
  );
}

function Identity({ status }: { status: StatusView }) {
  const me = status.me;
  if (!me) {
    return (
      <section className="panel identity error-panel">
        <h2>Your key could not be resolved</h2>
        <p>{status.meError}</p>
        <p className="muted">Check that you started the signer with your own tree file and seed (or Ledger).</p>
      </section>
    );
  }
  const lowGas = BigInt(me.balance) < LOW_GAS_WEI;
  return (
    <section className="panel identity">
      <div className="identity-main">
        <div className="eyebrow">You sign as slot {me.slotId}</div>
        <div className="owner mono">
          <a href={explorer(status.chainId, "address", me.address)} target="_blank" rel="noreferrer">
            {me.address}
          </a>
        </div>
        <div className="muted">
          Current owner key: tree index {me.index.toLocaleString()} of {me.treeSize.toLocaleString()}. It changes after every
          transaction you sign; this signer always uses the right one.
        </div>
      </div>
      <div className="stats">
        <Stat label="Gas" value={eth(me.balance)} tone={lowGas ? "warning" : undefined} hint={lowGas ? "Too little to execute" : undefined} />
        <Stat
          label="Next keys staged"
          value={
            <span className="dots" aria-label={`${me.staged} of ${me.bufferSize}`}>
              {Array.from({ length: me.bufferSize }, (_, i) => (
                <span key={i} className={i < me.staged ? "dot on" : "dot"} />
              ))}
            </span>
          }
          tone={me.staged === 0 ? "critical" : me.staged < 2 ? "warning" : undefined}
          hint={`${me.staged} of ${me.bufferSize}`}
        />
        <Stat label="Executions go through" value={status.executionHost} />
      </div>
    </section>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone?: "warning" | "critical" }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

function Queue({ status, queue, onBusy }: { status: StatusView; queue: QueueItem[]; onBusy: (busy: boolean) => void }) {
  return (
    <section>
      <h2>Pending transactions</h2>
      {queue.length === 0 ? (
        <section className="panel empty">
          <p>Nothing to sign.</p>
          <p className="muted">Create a transaction in Safe{"{"}Wallet{"}"}; it appears here within a few seconds.</p>
        </section>
      ) : (
        queue.map((item) => <TxCard key={item.safeTxHash} item={item} status={status} onBusy={onBusy} />)
      )}
    </section>
  );
}

type Stage = { kind: "idle" } | { kind: "review" } | { kind: "working" } | { kind: "done"; result?: ExecuteResult } | { kind: "failed"; message: string };

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
        setStage({ kind: "done" });
      } else {
        setStage({ kind: "done", result: await api.execute(item.safeTxHash) });
      }
    } catch (caught) {
      setStage({ kind: "failed", message: (caught as Error).message });
    } finally {
      onBusy(false);
    }
  }

  return (
    <article className={`panel tx ${action}`}>
      <div className="tx-head">
        <span className="nonce">#{item.nonce}</span>
        <ul className="actions">
          {item.actions.map((a, i) => (
            <li key={i} className={`action ${a.kind}`}>
              {a.summary}
            </li>
          ))}
          {item.actions.length === 0 && <li className="muted">Actions unavailable until your key resolves</li>}
        </ul>
      </div>

      <div className="tx-confirmations">
        <span className="progress-label">
          Off-chain confirmations {counting} of {needed}
        </span>
        {item.confirmations.map((c) => (
          <span key={c.owner} className={`chip ${c.counts ? "" : "stale"}`} title={`${c.owner} (${c.signatureType})`}>
            {short(c.owner)}
            {!c.counts && " · does not count"}
          </span>
        ))}
        <span className="muted hash" title={item.safeTxHash}>
          {short(item.safeTxHash)}
        </span>
      </div>

      {warnings.length > 0 && (
        <ul className="notes warning">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {stage.kind === "done" ? (
        <Done action={action} result={stage.result} chainId={status.chainId} />
      ) : action === "none" ? (
        <ul className="notes blocked">
          {blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : stage.kind === "idle" ? (
        <div className="tx-actions">
          <button type="button" className="primary" onClick={() => setStage({ kind: "review" })}>
            {action === "confirm" ? "Confirm" : "Execute"}
          </button>
          <span className="muted">
            {action === "confirm" ? "Signs with your current key and posts the confirmation." : "You are the last signer: you execute with your own signature."}
          </span>
        </div>
      ) : (
        <Review action={action} item={item} status={status} stage={stage} onRun={() => void run()} onCancel={() => setStage({ kind: "idle" })} />
      )}
    </article>
  );
}

function Review({
  action,
  item,
  status,
  stage,
  onRun,
  onCancel,
}: {
  action: "confirm" | "execute";
  item: QueueItem;
  status: StatusView;
  stage: Stage;
  onRun: () => void;
  onCancel: () => void;
}) {
  const working = stage.kind === "working";
  return (
    <div className="review">
      {action === "confirm" ? (
        <p>
          You are about to sign transaction <span className="mono">{item.safeTxHash}</span> as slot {status.me?.slotId} (
          <span className="mono">{status.me && short(status.me.address)}</span>). The hash was recomputed from the transaction's
          fields, not taken from the Transaction Service. Your key rotates when this transaction executes.
        </p>
      ) : (
        <>
          <p>Before anything is sent:</p>
          <ul className="checklist">
            <li>The other {status.threshold - 1 === 1 ? "confirmation is" : "confirmations are"} collected; yours is added as the executor's.</li>
            <li>The transaction is simulated first. If it would revert, nothing is sent.</li>
            <li>
              It is sent only through <strong>{status.executionHost}</strong>, which does not publish failing transactions.
            </li>
            <li>When it executes, you and the confirming signer(s) rotate to fresh keys.</li>
          </ul>
        </>
      )}
      {stage.kind === "failed" && <p className="banner critical">{stage.message}</p>}
      <div className="tx-actions">
        <button type="button" className="primary" disabled={working} onClick={onRun}>
          {working ? (action === "confirm" ? "Signing…" : "Simulating and sending…") : action === "confirm" ? "Sign and post confirmation" : "Simulate and execute"}
        </button>
        <button type="button" disabled={working} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Done({ action, result, chainId }: { action: "confirm" | "execute" | "none"; result?: ExecuteResult; chainId: number }) {
  if (action === "confirm" || !result) return <p className="banner ok">Confirmation posted. The last signer can now execute.</p>;
  const link = explorer(chainId, "tx", result.transactionHash);
  return (
    <div className="banner ok">
      <p>
        Executed in{" "}
        {link ? (
          <a href={link} target="_blank" rel="noreferrer" className="mono">
            {short(result.transactionHash)}
          </a>
        ) : (
          <span className="mono">{short(result.transactionHash)}</span>
        )}{" "}
        using {Number(result.gasUsed).toLocaleString()} gas.
      </p>
      <ul>
        {result.rotated.map((r) => (
          <li key={r.slotId}>
            Slot {r.slotId} rotated: <span className="mono">{short(r.from)}</span> → <span className="mono">{short(r.to)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
