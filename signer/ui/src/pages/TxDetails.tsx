import { useState } from "react";

import type { QueueItem, StatusView } from "../api";
import { eth, short } from "../format";
import { IconCheck, IconCopy } from "../icons";
import { Address } from "../ui";

/** Everything behind a transaction's one-line summary: each call's target, function and data, and the Safe transaction itself. */
export function TxDetails({ item, status }: { item: QueueItem; status: StatusView }) {
  const slotOf = (owner: string) => status.signers.find((signer) => signer.owner.toLowerCase() === owner.toLowerCase())?.slotId;
  const who = (owner: string) => {
    const slotId = slotOf(owner);
    return slotId === undefined ? "not an owner now" : `slot ${slotId}${status.me?.slotId === slotId ? " (you)" : ""}`;
  };
  const batch = item.tx.operation === 1;
  return (
    <div className="tx-details">
      <div className="tx-details-body">
        {item.actions.map((action, i) => (
          <section key={i} className="tx-call">
            <div className="tx-call-title">
              {item.actions.length > 1 ? `Call ${i + 1} of ${item.actions.length}` : "Call"}
              <span className="muted"> · {action.summary}</span>
            </div>
            <dl className="kv">
              <dt>To</dt>
              <dd>
                <Address address={action.to} chainId={status.chainId} full />
              </dd>
              <dt>Value</dt>
              <dd>{eth(String(action.value), 6)}</dd>
              <dt>Function</dt>
              <dd className="mono">{action.functionName ? `${action.functionName}()` : action.selector ? `selector ${action.selector} (unknown ABI)` : "none (plain transfer)"}</dd>
              <dt>Data</dt>
              <dd>
                <Calldata data={action.data} />
              </dd>
            </dl>
          </section>
        ))}
        <section className="tx-call">
          <div className="tx-call-title">Safe transaction</div>
          <dl className="kv">
            <dt>Nonce</dt>
            <dd>{item.nonce}</dd>
            <dt>Operation</dt>
            <dd>{batch ? `Delegatecall to MultiSendCallOnly ${short(item.tx.to)}: ${item.actions.length} calls in one batch` : "Call"}</dd>
            <dt>safeTxGas</dt>
            <dd>{Number(item.tx.safeTxGas).toLocaleString("en-US")}</dd>
            <dt>Hash</dt>
            <dd>
              <Calldata data={item.safeTxHash} full />
            </dd>
            {item.proposer && (
              <>
                <dt>Proposed by</dt>
                <dd>
                  <Address address={item.proposer} chainId={status.chainId} /> <span className="muted">{who(item.proposer)}</span>
                </dd>
              </>
            )}
            {item.submissionDate && (
              <>
                <dt>Proposed at</dt>
                <dd>{new Date(item.submissionDate).toLocaleString()}</dd>
              </>
            )}
            <dt>Signatures</dt>
            <dd>
              {item.confirmations.length === 0 ? (
                <span className="muted">none yet</span>
              ) : (
                <ul className="tx-signatures">
                  {item.confirmations.map((c) => (
                    <li key={c.owner} className={c.counts ? "" : "muted"}>
                      <Address address={c.owner} chainId={status.chainId} /> <span className="muted">{who(c.owner)}</span>
                      {!c.counts && <span className="muted"> · no longer counts</span>}
                      {c.signatureType !== "EOA" && <span className="muted"> · {c.signatureType}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
        </section>
      </div>
    </div>
  );
}

/** Hex data, shown shortened until clicked, with a copy button. */
function Calldata({ data, full = false }: { data: string; full?: boolean }) {
  const [expanded, setExpanded] = useState(full);
  const [copied, setCopied] = useState(false);
  const bytes = Math.max(0, (data.length - 2) / 2);
  if (bytes === 0) return <span className="muted">empty</span>;
  const shown = expanded || data.length <= 34 ? data : `${data.slice(0, 22)}…${data.slice(-8)}`;
  return (
    <span className="calldata">
      <button type="button" className={`mono calldata-text ${expanded ? "expanded" : ""}`} title={expanded ? "Shorten" : "Show all"} onClick={() => setExpanded(!expanded)}>
        {shown}
      </button>
      {!full && <span className="muted small"> {bytes.toLocaleString("en-US")} bytes</span>}
      <button
        type="button"
        className="icon-button small"
        title="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(data).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <IconCheck width="14" height="14" /> : <IconCopy />}
      </button>
    </span>
  );
}
