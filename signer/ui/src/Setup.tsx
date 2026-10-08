import { useState } from "react";

import { desktop, type DesktopSettings, type DesktopState, type TreeSummary } from "./api";
import { short } from "./format";

const CHAIN_NAMES: Record<number, string> = { 1: "Ethereum", 11155111: "Sepolia" };

/** First-launch (and Settings) screen of the desktop app. */
export function Setup({ initial, onDone, onCancel }: { initial?: DesktopState; onDone: () => void; onCancel?: () => void }) {
  const [treePath, setTreePath] = useState(initial?.settings?.treePath ?? "");
  const [tree, setTree] = useState<TreeSummary | undefined>(initial?.tree);
  const [rpc, setRpc] = useState(initial?.settings?.rpc ?? "");
  const [executionRpc, setExecutionRpc] = useState(initial?.settings?.executionRpc ?? "");
  const [error, setError] = useState<string | undefined>(initial?.error);
  const [working, setWorking] = useState(false);

  async function pickTree() {
    try {
      const picked = await desktop!.pickTree();
      if (picked) {
        setTreePath(picked.path);
        setTree(picked.tree);
        setError(undefined);
      }
    } catch (caught) {
      setError(`That file is not a valid tree file: ${(caught as Error).message}`);
    }
  }

  async function start() {
    setWorking(true);
    setError(undefined);
    try {
      const settings: DesktopSettings = { treePath, rpc, executionRpc };
      await desktop!.configure(settings);
      onDone();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setWorking(false);
    }
  }

  const ready = treePath !== "" && rpc.trim() !== "" && !working;
  return (
    <section className="panel setup">
      <h2>Set up your signer</h2>
      <p className="muted">
        Choose your tree file and an RPC. The signer reads which tree index owns your slot on-chain and always signs with that
        key from your wallet.
      </p>

      <div className="field">
        <label>Tree file</label>
        <div className="row">
          <button type="button" onClick={() => void pickTree()}>
            Choose…
          </button>
          <span className="path">{treePath || "No file chosen"}</span>
        </div>
        {tree && (
          <p className="muted small">
            Slot {tree.slotId} of Safe <span className="mono">{short(tree.safe)}</span> on {CHAIN_NAMES[tree.chainId] ?? `chain ${tree.chainId}`},{" "}
            {tree.size.toLocaleString()} keys from account {tree.base.toLocaleString()}
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor="rpc">RPC URL</label>
        <input id="rpc" placeholder="https://…" value={rpc} onChange={(e) => setRpc(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="execution-rpc">Execution RPC (optional)</label>
        <input
          id="execution-rpc"
          placeholder={tree?.chainId === 1 ? "Default: Flashbots Protect" : "Default: the RPC above"}
          value={executionRpc}
          onChange={(e) => setExecutionRpc(e.target.value)}
        />
        <p className="muted small">Executions are sent only here. On mainnet the default keeps them private and never publishes one that would fail.</p>
      </div>

      {error && <p className="banner critical">{error}</p>}
      <div className="tx-actions">
        <button type="button" className="primary" disabled={!ready} onClick={() => void start()}>
          {working ? "Checking your key…" : "Start signer"}
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
