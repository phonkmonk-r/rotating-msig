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
      return "This Safe doesn't have rotation set up yet. New-Safe setup is coming to the app; for now, install it with the Safe App.";
    case "not-owner":
      return "This seed isn't a signer of this Safe. Check the seed phrase and the address.";
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
    <form
      className="auth-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (!working && safe.trim() !== "") void join();
      }}
    >
      <h2>Connect your Safe</h2>
      <p className="muted">We'll find your signer slot and rebuild your keys.</p>

      <label className="field">
        <span className="field-label">Safe address</span>
        <input placeholder="0x…" spellCheck={false} value={safe} onChange={(e) => setSafe(e.target.value)} disabled={working} />
      </label>

      <details className="advanced">
        <summary>Advanced</summary>
        <label className="field">
          <span className="field-label">Network</span>
          <select value={advanced.chainId ?? ""} onChange={(e) => setAdvanced({ ...advanced, chainId: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">Detect automatically</option>
            <option value="1">Ethereum</option>
            <option value="11155111">Sepolia</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">RPC URL</span>
          <input placeholder="Public RPCs" value={advanced.rpc ?? ""} onChange={(e) => setAdvanced({ ...advanced, rpc: e.target.value || undefined })} />
        </label>
        <label className="field">
          <span className="field-label">Execution RPC</span>
          <input
            placeholder="Flashbots Protect on Ethereum"
            value={advanced.executionRpc ?? ""}
            onChange={(e) => setAdvanced({ ...advanced, executionRpc: e.target.value || undefined })}
          />
        </label>
      </details>

      {working && (
        <div className="progress-block">
          <div className="progress-label">
            <span>{progress ? STAGES[progress.stage] : "Starting"}</span>
            {percent !== undefined && <span className="muted">{percent}%</span>}
          </div>
          <div className="bar">
            <div style={{ width: `${percent ?? 8}%` }} />
          </div>
        </div>
      )}
      {error && <div className="note critical">{error}</div>}
      <div className="form-actions">
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={working}>
            Cancel
          </button>
        )}
        <button type="submit" className="primary" disabled={working || safe.trim() === ""}>
          {working ? "Connecting…" : "Continue"}
        </button>
      </div>
    </form>
  );
}
