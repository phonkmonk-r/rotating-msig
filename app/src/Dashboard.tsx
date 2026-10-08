import { assess, describeRevert, readSafeState, type Finding, type SafeState, type SlotState } from "@rotating-msig/core";
import { useCallback, useEffect, useState } from "react";
import type { Address, PublicClient } from "viem";

import { chainName, formatEth, shortAddress } from "./format";

const REFRESH_MS = 12_000;

interface Props {
  client: PublicClient;
  safe: Address;
  guard?: Address;
}

export function Dashboard({ client, safe, guard }: Props) {
  const [state, setState] = useState<SafeState>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date>();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setState(await readSafeState(client, safe, guard));
      setError(undefined);
      setUpdatedAt(new Date());
    } catch (caught) {
      setError(describeRevert(caught) ?? (caught as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client, safe, guard]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!state) {
    return <p className="muted">{error ? `Could not read the Safe: ${error}` : "Reading the Safe…"}</p>;
  }

  const findings = assess(state);
  return (
    <>
      <section className="cards">
        <Card label="Safe" value={shortAddress(state.safe)} title={state.safe} detail={chainName(state.chainId)} />
        <Card label="Threshold" value={`${state.threshold} of ${state.owners.length}`} detail={`nonce ${state.nonce}`} />
        <Card label="Balance" value={formatEth(state.balance)} />
        <Card
          label="Rotation guard"
          value={state.installed ? "Installed" : "Not installed"}
          tone={state.installed ? "ok" : "critical"}
          detail={state.installed ? shortAddress(state.guard) : undefined}
          title={state.guard}
        />
      </section>

      <Findings findings={findings} />

      {state.slots.length > 0 && <Slots slots={state.slots} bufferSize={state.bufferSize} />}

      <footer className="footer">
        <span className="muted">{updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : ""}</span>
        {error && <span className="error">Refresh failed: {error}</span>}
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </footer>
    </>
  );
}

function Card({ label, value, detail, title, tone }: { label: string; value: string; detail?: string; title?: string; tone?: "ok" | "critical" }) {
  return (
    <div className="card">
      <div className="card-label">{label}</div>
      <div className={`card-value ${tone ?? ""}`} title={title}>
        {value}
      </div>
      {detail && <div className="card-detail" title={title}>{detail}</div>}
    </div>
  );
}

function Findings({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return <section className="findings clear">All clear: every slot has staged addresses, tree headroom and gas.</section>;
  }
  return (
    <section className="findings">
      <h2>Needs attention</h2>
      <ul>
        {findings.map((finding, i) => (
          <li key={i} className={finding.severity}>
            <span className="badge">{finding.severity}</span>
            {finding.slotId !== undefined && <span className="slot-ref">slot {finding.slotId}</span>}
            {finding.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Slots({ slots, bufferSize }: { slots: SlotState[]; bufferSize: number }) {
  return (
    <section>
      <h2>Slots</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Slot</th>
              <th>Current owner</th>
              <th>Tree position</th>
              <th>Staged</th>
              <th>Unused</th>
              <th>Owner gas</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((slot) => (
              <tr key={slot.slotId}>
                <td>{slot.slotId}</td>
                <td className="mono" title={slot.owner}>
                  {shortAddress(slot.owner)}
                </td>
                <td>
                  <div className="progress" title={`index ${slot.ownerIndex} of ${slot.size}`}>
                    <div style={{ width: `${((slot.ownerIndex + 1) / slot.size) * 100}%` }} />
                  </div>
                  <span className="muted">
                    {slot.ownerIndex + 1} / {slot.size}
                  </span>
                </td>
                <td>
                  <span className="dots" aria-label={`${slot.staged.length} of ${bufferSize} staged`}>
                    {Array.from({ length: bufferSize }, (_, i) => (
                      <span key={i} className={i < slot.staged.length ? "dot on" : "dot"} />
                    ))}
                  </span>
                </td>
                <td>{slot.unstaged}</td>
                <td>{formatEth(slot.ownerBalance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
