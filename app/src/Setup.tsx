import {
  installCalls,
  installTx,
  loadTreeFile,
  planInstall,
  readGuardInfo,
  validateInstall,
  type GuardInfo,
  type LoadedTree,
  type MetaTx,
  type SafeState,
} from "@rotating-msig/core";
import type SafeAppsSDK from "@safe-global/safe-apps-sdk";
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { getAddress, isAddress, type Address, type PublicClient } from "viem";

import { shortAddress } from "./format";

interface Props {
  client: PublicClient;
  state: SafeState;
  sdk?: SafeAppsSDK;
  initialGuard?: Address;
  onProposed: () => void;
}

type FileResult = { name: string; loaded?: LoadedTree; error?: string };

export function Setup({ client, state, sdk, initialGuard, onProposed }: Props) {
  const [guardInput, setGuardInput] = useState<string>(initialGuard ?? "");
  const [guard, setGuard] = useState<GuardInfo>();
  const [guardError, setGuardError] = useState<string>();
  const [files, setFiles] = useState<FileResult[]>([]);
  const [replaces, setReplaces] = useState<Address[]>([]);
  const [proposal, setProposal] = useState<{ safeTxHash?: string; error?: string }>();

  useEffect(() => {
    if (initialGuard) void checkGuard(initialGuard);
    // Only on mount: later changes go through the Check button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkGuard(value: string) {
    setGuard(undefined);
    setGuardError(undefined);
    if (!isAddress(value, { strict: false })) {
      setGuardError("not an address");
      return;
    }
    try {
      setGuard(await readGuardInfo(client, getAddress(value)));
    } catch {
      setGuardError("no RotationGuard at this address on this chain");
    }
  }

  async function onFiles(event: ChangeEvent<HTMLInputElement>) {
    const results = await Promise.all(
      [...(event.target.files ?? [])].map(async (file): Promise<FileResult> => {
        try {
          return { name: file.name, loaded: loadTreeFile(await file.text()) };
        } catch (error) {
          return { name: file.name, error: (error as Error).message };
        }
      }),
    );
    results.sort((a, b) => (a.loaded?.file.slotId ?? Infinity) - (b.loaded?.file.slotId ?? Infinity));
    setFiles(results);
    setReplaces(results.filter((r) => r.loaded).map((_, slot) => state.owners[slot] ?? state.owners[0]!));
    setProposal(undefined);
  }

  const trees = files.flatMap((f) => (f.loaded ? [f.loaded] : []));
  const selection = guard ? { guard, trees, replaces } : undefined;
  const errors = useMemo(() => (selection ? validateInstall(state, selection) : []), [state, selection]);
  const ready = selection !== undefined && trees.length > 0 && errors.length === 0 && files.every((f) => f.loaded);

  async function propose() {
    if (!selection) return;
    const calls = installCalls(planInstall(state, selection));
    if (sdk) {
      try {
        const { safeTxHash } = await sdk.txs.send({ txs: calls.map((tx) => ({ to: tx.to, value: tx.value.toString(), data: tx.data })) });
        setProposal({ safeTxHash });
        onProposed();
      } catch (error) {
        setProposal({ error: (error as Error).message });
      }
    } else {
      download(`rotation-guard-setup-${shortAddress(state.safe)}.json`, transactionBuilderFile(state, calls));
      setProposal({});
    }
  }

  return (
    <section className="panel setup">
      <h2>Install the rotation guard</h2>
      <p className="muted">
        One Safe transaction, signed by the current owners, enables the guard and replaces every current owner with the first
        fresh address of its slot's tree. Current owners have signed before, so their keys are treated as exposed.
      </p>

      <h3>1. Guard</h3>
      <div className="row">
        <input placeholder="RotationGuard address (0x…)" value={guardInput} onChange={(e) => setGuardInput(e.target.value)} />
        <button type="button" onClick={() => void checkGuard(guardInput)}>
          Check
        </button>
      </div>
      {guardError && <p className="error">{guardError}</p>}
      {guard && (
        <p className="ok-text">
          RotationGuard found. Allowed MultiSendCallOnly {shortAddress(guard.multiSendCallOnly)}, buffer of {guard.bufferSize}.
        </p>
      )}

      <h3>2. Signer trees</h3>
      <p className="muted">
        Load one tree file per slot (from <code>rotation-tree generate</code>). Each file is verified on load by rebuilding its
        root from its addresses.
      </p>
      <input type="file" accept="application/json,.json" multiple onChange={(e) => void onFiles(e)} />
      {files.some((f) => f.error) && (
        <ul className="plain">
          {files
            .filter((f) => f.error)
            .map((f) => (
              <li key={f.name} className="error">
                {f.name}: {f.error}
              </li>
            ))}
        </ul>
      )}

      {trees.length > 0 && (
        <>
          <h3>3. Review</h3>
          <p className="muted">
            Every signer must check that the root of their slot below matches the root their own generator printed. A wrong root
            would hand that slot's future ownership to whoever made the file.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Replaces current owner</th>
                  <th>New owner (index 0)</th>
                  <th>Root</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {trees.map(({ file }, slot) => (
                  <tr key={file.root}>
                    <td>{file.slotId}</td>
                    <td>
                      <select
                        value={replaces[slot]}
                        onChange={(e) => setReplaces(replaces.map((owner, i) => (i === slot ? (e.target.value as Address) : owner)))}
                      >
                        {state.owners.map((owner) => (
                          <option key={owner} value={owner}>
                            {owner}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="mono" title={file.addresses[0]}>
                      {shortAddress(file.addresses[0]!)}
                    </td>
                    <td className="mono root">{file.root}</td>
                    <td>{file.size}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {trees.length > 0 && errors.length > 0 && (
        <ul className="plain">
          {errors.map((error) => (
            <li key={error} className="error">
              {error}
            </li>
          ))}
        </ul>
      )}

      <h3>4. Propose</h3>
      <button type="button" className="primary" disabled={!ready} onClick={() => void propose()}>
        {sdk ? "Propose setup transaction" : "Download for Transaction Builder"}
      </button>
      {!sdk && ready && <InstallTxDetails tx={installTx(planInstall(state, selection!))} />}
      {proposal?.safeTxHash && <p className="ok-text">Proposed. Safe transaction hash {proposal.safeTxHash}. Owners can now confirm it in the queue.</p>}
      {proposal?.error && <p className="error">Not proposed: {proposal.error}</p>}
    </section>
  );
}

function InstallTxDetails({ tx }: { tx: MetaTx }) {
  return (
    <details className="details">
      <summary>Single-transaction form (delegatecall to MultiSendCallOnly), for scripts</summary>
      <pre>{JSON.stringify({ to: tx.to, value: tx.value.toString(), operation: tx.operation, data: tx.data }, null, 2)}</pre>
    </details>
  );
}

/** Safe Transaction Builder batch file format. */
function transactionBuilderFile(state: SafeState, calls: MetaTx[]): string {
  return JSON.stringify(
    {
      version: "1.0",
      chainId: String(state.chainId),
      createdAt: Date.now(),
      meta: { name: "Install RotationGuard", description: `Setup for Safe ${state.safe}`, createdFromSafeAddress: state.safe },
      transactions: calls.map((tx) => ({ to: tx.to, value: tx.value.toString(), data: tx.data })),
    },
    null,
    2,
  );
}

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  URL.revokeObjectURL(url);
}
