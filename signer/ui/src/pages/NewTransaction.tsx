import { useCallback, useEffect, useState } from "react";
import { formatUnits, isAddress, parseEther, parseUnits } from "viem";

import { api, type DappCall, type ProposalInput, type ProposalResult, type StatusView, type TokenInfo } from "../api";
import { eth } from "../format";
import { IconAlert, IconCheck } from "../icons";
import { Avatar, Badge, Dots } from "../ui";
import { ContractCall } from "./ContractCall";

type Tab = "eth" | "erc20" | "call" | "force-rotate";

const TABS: { id: Tab; label: string }[] = [
  { id: "eth", label: "Send ETH" },
  { id: "erc20", label: "Send token" },
  { id: "call", label: "Contract call" },
  { id: "force-rotate", label: "Rotate signer" },
];

/** Form to propose a transaction from the app; the proposer's signature is their confirmation. */
export function NewTransaction({
  status,
  queueMode,
  onClose,
  onProposed,
}: {
  status: StatusView;
  queueMode: boolean;
  onClose: () => void;
  onProposed: () => void;
}) {
  const [tab, setTab] = useState<Tab>("eth");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [tokenAddress, setTokenAddress] = useState("");
  const [token, setToken] = useState<TokenInfo>();
  const [tokenError, setTokenError] = useState<string>();
  const [slots, setSlots] = useState<number[]>([]);
  const [custom, setCustom] = useState<{ call?: DappCall; problem?: string }>({});
  const onCustom = useCallback((call: DappCall | undefined, problem?: string) => setCustom({ call, problem }), []);
  const [review, setReview] = useState<ProposalResult>();
  const [done, setDone] = useState<ProposalResult>();
  const [queued, setQueued] = useState<number>(0);
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  useEffect(() => {
    setToken(undefined);
    setTokenError(undefined);
    if (!isAddress(tokenAddress, { strict: false })) return;
    let current = true;
    api.token(tokenAddress).then(
      (info) => current && setToken(info),
      (caught: Error) => current && setTokenError(caught.message),
    );
    return () => {
      current = false;
    };
  }, [tokenAddress]);

  function input(): ProposalInput {
    if (tab === "force-rotate") return { kind: "force-rotate", slotIds: slots };
    if (tab === "call") {
      if (!custom.call) throw new Error(custom.problem ?? "Complete the call");
      return { kind: "calls", origin: "app", calls: [custom.call] };
    }
    if (!isAddress(to, { strict: false })) throw new Error("Enter a valid recipient address");
    if (!/^\d*\.?\d+$/.test(amount.trim())) throw new Error("Enter an amount");
    if (tab === "eth") return { kind: "eth", to, amount: parseEther(amount.trim()).toString() };
    if (!token) throw new Error("Enter a token address");
    return { kind: "erc20", token: token.address, to, amount: parseUnits(amount.trim(), token.decimals).toString() };
  }

  async function submit(preview: boolean) {
    setWorking(true);
    setError(undefined);
    try {
      const result = await api.propose(input(), preview);
      if (preview) setReview(result);
      else {
        setDone(result);
        onProposed();
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setWorking(false);
    }
  }

  async function addToQueue() {
    setWorking(true);
    setError(undefined);
    try {
      await api.draftAdd(input());
      setQueued(queued + 1);
      setReview(undefined);
      setTo("");
      setAmount("");
      setSlots([]);
      onProposed();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setWorking(false);
    }
  }

  function switchTab(next: Tab) {
    setTab(next);
    setReview(undefined);
    setError(undefined);
  }

  if (done) {
    return (
      <section className="card composer">
        <div className="composer-done">
          <span className="done-icon">
            <IconCheck />
          </span>
          <div>
            <div className="identity-title">Proposed #{done.nonce}</div>
            <p className="muted">Your signature counts as a confirmation. Another signer can now execute it.</p>
          </div>
        </div>
        <div className="tx-footer">
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </section>
    );
  }

  const others = status.signers;
  return (
    <section className="card composer">
      <div className="composer-head">
        <div className="segmented">
          {TABS.map((item) => (
            <button key={item.id} type="button" className={tab === item.id ? "active" : ""} onClick={() => switchTab(item.id)} disabled={review !== undefined}>
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" className="icon-button" onClick={onClose} title="Close" aria-label="Close">
          ✕
        </button>
      </div>

      {review ? (
        <div className="review-panel">
          <div className="metric-label">Proposal #{review.nonce}</div>
          {review.actions.map((action, i) => (
            <div key={i} className={`tx-action ${action.kind}`}>
              {action.summary}
            </div>
          ))}
          {review.warnings.map((warning) => (
            <div key={warning} className="note warning">
              <IconAlert width="15" height="15" />
              <span>{warning}</span>
            </div>
          ))}
          <ul className="checklist">
            <li>Signed with your current key as your confirmation</li>
            <li>Another signer executes; you both rotate</li>
          </ul>
        </div>
      ) : tab === "call" ? (
        <ContractCall onChange={onCustom} />
      ) : tab === "force-rotate" ? (
        <div className="slot-picker">
          {others.map((signer) => {
            const checked = slots.includes(signer.slotId);
            return (
              <label key={signer.slotId} className={`slot-option ${checked ? "checked" : ""}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={signer.staged === 0}
                  onChange={() => setSlots(checked ? slots.filter((id) => id !== signer.slotId) : [...slots, signer.slotId].sort())}
                />
                <Avatar address={signer.owner} size={26} />
                <span className="slot-option-name">
                  Slot {signer.slotId} {signer.isMe && <Badge tone="accent">You</Badge>}
                </span>
                <Dots filled={signer.staged} total={status.me?.bufferSize ?? 5} />
                {signer.confirmedNonces.length > 0 && <Badge tone="warning">Exposed</Badge>}
              </label>
            );
          })}
          <div className="slot-picker-footer">
            <p className="muted small">Moves each chosen slot to its next key. Use it for keys exposed outside a transaction.</p>
            <button
              type="button"
              className="link-button small"
              onClick={() => setSlots(others.filter((signer) => signer.staged > 0).map((signer) => signer.slotId))}
            >
              Select all
            </button>
          </div>
        </div>
      ) : (
        <div className="composer-fields">
          {tab === "erc20" && (
            <label className="field">
              <span className="field-label">
                Token
                {token && (
                  <span className="muted">
                    {token.symbol} · balance {formatUnits(BigInt(token.safeBalance), token.decimals)}
                  </span>
                )}
              </span>
              <input placeholder="Token contract 0x…" spellCheck={false} value={tokenAddress} onChange={(e) => setTokenAddress(e.target.value)} />
              {tokenError && <span className="field-error">{tokenError}</span>}
            </label>
          )}
          <label className="field">
            <span className="field-label">Recipient</span>
            <input placeholder="0x…" spellCheck={false} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">
              Amount
              {tab === "eth" && <span className="muted">Safe balance {eth(status.balance, 6)}</span>}
            </span>
            <div className="amount-input">
              <input inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <span className="unit">{tab === "eth" ? "ETH" : (token?.symbol ?? "")}</span>
            </div>
          </label>
        </div>
      )}

      {queued > 0 && (
        <div className="note ok">
          <IconCheck width="15" height="15" />
          <span>Added to the queue. Add more, or review the queue below and propose it.</span>
        </div>
      )}
      {error && (
        <div className="note critical">
          <IconAlert width="15" height="15" />
          <span>{error.charAt(0).toUpperCase() + error.slice(1)}</span>
        </div>
      )}

      <div className="tx-footer">
        {review ? (
          <>
            <button type="button" onClick={() => setReview(undefined)} disabled={working}>
              Back
            </button>
            <button type="button" className="primary" onClick={() => void submit(false)} disabled={working}>
              {working ? "Signing…" : "Sign & propose"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={queueMode ? "primary" : ""}
              onClick={() => void addToQueue()}
              disabled={working || (tab === "force-rotate" && slots.length === 0)}
            >
              Add to queue
            </button>
            {!queueMode && (
              <button type="button" className="primary" onClick={() => void submit(true)} disabled={working || (tab === "force-rotate" && slots.length === 0)}>
                {working ? "Checking…" : "Review"}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
