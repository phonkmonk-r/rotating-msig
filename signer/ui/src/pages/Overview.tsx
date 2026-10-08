import type { QueueItem, StatusView } from "../api";
import { LOW_GAS_WEI } from "../data";
import { eth } from "../format";
import { IconAlert, IconTransactions } from "../icons";
import { Address, Avatar, Badge, Dots, PageHeader } from "../ui";

export function Overview({ status, queue, onOpenTransactions }: { status: StatusView; queue: QueueItem[]; onOpenTransactions: () => void }) {
  const me = status.me;
  const waiting = queue.filter((item) => item.verdict.action !== "none").length;
  const gasAccount = status.gasFunding ? me?.operator : undefined;
  const lowGas = gasAccount ? status.findings.some((f) => f.message.startsWith("Your gas account")) : me ? BigInt(me.balance) < LOW_GAS_WEI : false;

  return (
    <>
      <PageHeader title="Overview" subtitle={`${status.threshold} of ${status.owners.length} signers · nonce ${status.nonce}`} />

      {me ? (
        <section className="card identity">
          <div className="identity-head">
            <Avatar address={me.address} size={44} />
            <div className="identity-text">
              <div className="identity-title">
                Slot {me.slotId} <Badge tone="accent">You</Badge>
              </div>
              <Address address={me.address} chainId={status.chainId} full />
            </div>
          </div>
          <div className="metrics">
            <div className="metric">
              <span className="metric-label">Current key</span>
              <span className="metric-value">
                {me.index.toLocaleString()} <span className="muted">/ {me.treeSize.toLocaleString()}</span>
              </span>
            </div>
            <div className={`metric ${lowGas ? "warning" : ""}`} title={gasAccount ? `Paid from ${gasAccount.address}, your seed's first account` : undefined}>
              <span className="metric-label">{gasAccount ? "Gas account" : "Gas"}</span>
              <span className="metric-value">{eth(gasAccount ? gasAccount.balance : me.balance)}</span>
            </div>
            <div className={`metric ${me.staged === 0 ? "critical" : me.staged < 2 ? "warning" : ""}`}>
              <span className="metric-label">Next keys</span>
              <span className="metric-value">
                <Dots filled={me.staged} total={me.bufferSize} />
              </span>
            </div>
            <div className="metric">
              <span className="metric-label">Executes via</span>
              <span className="metric-value small-value">{status.executionHost}</span>
            </div>
          </div>
        </section>
      ) : (
        <section className="card">
          <div className="note critical">
            <IconAlert width="15" height="15" />
            <span>{status.meError ?? "Your key could not be resolved."}</span>
          </div>
        </section>
      )}

      <div className="grid-2">
        <section className="card action-card" onClick={onOpenTransactions} role="button" tabIndex={0}>
          <div className="card-icon">
            <IconTransactions />
          </div>
          <div>
            <div className="big-number">{waiting}</div>
            <div className="muted">{waiting === 1 ? "transaction needs you" : "transactions need you"}</div>
          </div>
          <span className="muted small">{queue.length} pending in total</span>
        </section>
        <section className="card">
          <div className="metric-label">Safe balance</div>
          <div className="big-number">{eth(status.balance)}</div>
          <Address address={status.safe} chainId={status.chainId} />
        </section>
      </div>

      {status.findings.length > 0 && (
        <section className="card">
          <h2 className="card-title">Health</h2>
          <ul className="issues">
            {status.findings.map((finding, i) => (
              <li key={i} className={finding.severity}>
                <IconAlert width="15" height="15" />
                <span>
                  {finding.slotId !== undefined && <strong>Slot {finding.slotId}: </strong>}
                  {finding.message.charAt(0).toUpperCase() + finding.message.slice(1)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
