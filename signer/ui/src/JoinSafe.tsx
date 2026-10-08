import { useEffect, useRef, useState } from "react";

import { desktop, type Advanced, type DesktopState, type JoinProgress } from "./api";

const STAGES: Record<JoinProgress["stage"], string> = {
  network: "Finding the network",
  reading: "Reading the Safe",
  finding: "Finding your slot",
  deriving: "Rebuilding your keys",
  verifying: "Checking against the chain",
};

/** Plain-language versions of join failures ("kind: message" from the main process). */
function explain(message: string): string {
  const [kind, ...rest] = message.split(": ");
  const detail = rest.join(": ");
  switch (kind) {
    case "not-installed":
      return "This Safe does not have the rotation guard yet. Setting up a new Safe from the app is the next feature; until then, install it with the Safe App.";
    case "not-owner":
      return `Your seed is not one of this Safe's signers. ${detail.includes("Check") ? "Check that you imported the right seed phrase and that this is the right Safe." : detail}`;
    case "no-safe":
    case "ambiguous-chain":
    case "invalid-address":
    case "root-mismatch":
      return detail.charAt(0).toUpperCase() + detail.slice(1);
    default:
      return message;
  }
}

/** Joins a Safe: the only thing a signer has to provide is its address. */
export function JoinSafe({
  initial,
  initialSafe,
  autoStart,
  onDone,
  onCancel,
}: {
  initial?: DesktopState;
  initialSafe?: string;
  autoStart?: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [safe, setSafe] = useState(initialSafe ?? initial?.settings?.safe ?? "");
  const [advanced, setAdvanced] = useState<Advanced>({
    chainId: undefined,
    rpc: initial?.settings?.rpc || undefined,
    executionRpc: initial?.settings?.executionRpc || undefined,
  });
  const [progress, setProgress] = useState<JoinProgress>();
  const [error, setError] = useState<string | undefined>(initial?.error);
  const [working, setWorking] = useState(false);
  const started = useRef(false);

  useEffect(() => desktop!.onProgress(setProgress), []);

  async function join() {
    setWorking(true);
    setError(undefined);
    setProgress(undefined);
    try {
      await desktop!.join(safe.trim(), advanced);
      onDone();
    } catch (caught) {
      setError(explain((caught as Error).message));
    } finally {
      setWorking(false);
    }
  }

  useEffect(() => {
    if (autoStart && safe && !started.current) {
      started.current = true;
      void join();
    }
    // Run once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const percent = progress?.stage === "deriving" && progress.total ? Math.round(((progress.done ?? 0) / progress.total) * 100) : undefined;
  return (
    <section className="panel setup">
      <h2>Your Safe</h2>
      <p className="muted">
        Paste the Safe's address. The app finds the network, works out which signer you are from your seed, rebuilds your
        rotation keys and checks them against what is committed on-chain, even if you have already signed before.
      </p>
      <div className="field">
        <label htmlFor="safe">Safe address</label>
        <input id="safe" placeholder="0x…" spellCheck={false} value={safe} onChange={(e) => setSafe(e.target.value)} disabled={working} />
      </div>

      <details className="advanced">
        <summary>Advanced</summary>
        <div className="field">
          <label htmlFor="network">Network</label>
          <select
            id="network"
            value={advanced.chainId ?? ""}
            onChange={(e) => setAdvanced({ ...advanced, chainId: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">Detect automatically</option>
            <option value="1">Ethereum</option>
            <option value="11155111">Sepolia</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="rpc">RPC URL</label>
          <input id="rpc" placeholder="Default: public RPCs" value={advanced.rpc ?? ""} onChange={(e) => setAdvanced({ ...advanced, rpc: e.target.value || undefined })} />
        </div>
        <div className="field">
          <label htmlFor="execution-rpc">Execution RPC</label>
          <input
            id="execution-rpc"
            placeholder="Default: Flashbots Protect on Ethereum, the RPC above on Sepolia"
            value={advanced.executionRpc ?? ""}
            onChange={(e) => setAdvanced({ ...advanced, executionRpc: e.target.value || undefined })}
          />
        </div>
      </details>

      {working && progress && (
        <div className="progress-block">
          <div>
            {STAGES[progress.stage]}
            {percent !== undefined && ` ${progress.done?.toLocaleString()} / ${progress.total?.toLocaleString()}`}…
          </div>
          {percent !== undefined && (
            <div className="bar">
              <div style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
      )}
      {error && <p className="banner critical">{error}</p>}
      <div className="tx-actions">
        <button type="button" className="primary" disabled={working || safe.trim() === ""} onClick={() => void join()}>
          {working ? "Setting up…" : "Continue"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={working}>
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}
