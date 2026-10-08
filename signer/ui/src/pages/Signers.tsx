import type { SignerView, StatusView } from "../api";
import { Manage } from "./Manage";
import { LOW_GAS_WEI } from "../data";
import { eth } from "../format";
import { Address, Avatar, Badge, Dots, PageHeader } from "../ui";

export function Signers({ status, pending, queueMode, onQueued }: { status: StatusView; pending: number; queueMode: boolean; onQueued: () => void }) {
  return (
    <>
      <PageHeader title="Signers" subtitle={`${status.signers.length} slots · ${status.threshold} needed to execute`} />
      <section className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>Signer</th>
              <th>Key</th>
              <th>Next keys</th>
              <th>Gas</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {status.signers.map((signer) => (
              <tr key={signer.slotId} className={signer.isMe ? "me" : ""}>
                <td>
                  <div className="signer-cell">
                    <Avatar address={signer.owner} size={30} />
                    <div>
                      <div className="signer-name">
                        Slot {signer.slotId} {signer.isMe && <Badge tone="accent">You</Badge>}
                      </div>
                      <Address address={signer.owner} chainId={status.chainId} />
                    </div>
                  </div>
                </td>
                <td>
                  {signer.index.toLocaleString()} <span className="muted">/ {signer.treeSize.toLocaleString()}</span>
                </td>
                <td>
                  <Dots filled={signer.staged} total={status.me?.bufferSize ?? 5} />
                </td>
                <td>{eth(signer.balance)}</td>
                <td>
                  <SignerState signer={signer} gasFunding={status.gasFunding} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <Manage status={status} pending={pending} queueMode={queueMode} onQueued={onQueued} />
    </>
  );
}

function SignerState({ signer, gasFunding }: { signer: SignerView; gasFunding: boolean }) {
  if (signer.staged === 0) return <Badge tone="critical">Out of keys</Badge>;
  if (signer.confirmedNonces.length > 0) return <Badge tone="warning">Signed #{signer.confirmedNonces.join(", #")}</Badge>;
  if (signer.unused + signer.staged < signer.treeSize * 0.1) return <Badge tone="warning">Tree low</Badge>;
  if (!gasFunding && BigInt(signer.balance) < LOW_GAS_WEI) return <Badge tone="warning">Needs gas</Badge>;
  if (signer.staged < 2) return <Badge tone="warning">Refill soon</Badge>;
  return <Badge tone="ok">Ready</Badge>;
}
