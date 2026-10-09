import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { formatEther } from "viem";

import { browser, type BrowserState, type DappRequest, type ProposalResult, type StatusView } from "../api";
import { short } from "../format";
import { IconAlert, IconBack, IconCheck, IconForward, IconGlobe, IconRefresh } from "../icons";
import { requestValue, sendLabel } from "../lib/execution";
import { Badge, useSoleSigner } from "../ui";

const SUGGESTIONS = [
  { name: "Uniswap", url: "https://app.uniswap.org", note: "Swap tokens" },
  { name: "CoW Swap", url: "https://swap.cow.fi", note: "Swap with MEV protection" },
  { name: "Aave", url: "https://app.aave.com", note: "Lend and borrow" },
  { name: "Revoke.cash", url: "https://revoke.cash", note: "Review token approvals" },
];

const EMPTY: BrowserState = { url: "", title: "", loading: false, canGoBack: false, canGoForward: false };

/**
 * The dApp browser. The page itself is a native view the main process lays over the viewport below; it is hidden
 * whenever a request is under review, so the review can never be covered or imitated by the page.
 */
export function Browse({ status, request, queueMode }: { status: StatusView; request: DappRequest | null; queueMode: boolean }) {
  const sole = useSoleSigner();
  const [state, setState] = useState<BrowserState>(EMPTY);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const [proposed, setProposed] = useState<ProposalResult>();
  const [queuedNote, setQueuedNote] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!browser) return;
    void browser.state().then(setState);
    return browser.onState(setState);
  }, []);

  useEffect(() => {
    if (!editing) setAddress(state.url);
  }, [state.url, editing]);

  const showPage = state.url !== "" && request === null;
  useLayoutEffect(() => {
    if (!browser) return;
    const element = viewport.current;
    if (!showPage || !element) {
      void browser.bounds(null);
      return;
    }
    const place = () => {
      const rect = element.getBoundingClientRect();
      void browser!.bounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      void browser!.bounds(null);
    };
  }, [showPage]);

  async function open(url: string) {
    setError(undefined);
    setProposed(undefined);
    try {
      setState(await browser!.open(url));
      setEditing(false);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (address.trim()) void open(address);
  }

  return (
    <div className="browser">
      <form className="browser-bar" onSubmit={submit}>
        <button type="button" className="icon-button" title="Back" aria-label="Back" disabled={!state.canGoBack} onClick={() => void browser!.navigate("back")}>
          <IconBack />
        </button>
        <button type="button" className="icon-button" title="Forward" aria-label="Forward" disabled={!state.canGoForward} onClick={() => void browser!.navigate("forward")}>
          <IconForward />
        </button>
        <button type="button" className="icon-button" title="Reload" aria-label="Reload" disabled={!state.url} onClick={() => void browser!.navigate("reload")}>
          <IconRefresh width="16" height="16" className={state.loading ? "spin" : ""} />
        </button>
        <div className="browser-address">
          <IconGlobe width="15" height="15" />
          <input
            value={address}
            placeholder="Enter a dApp address, e.g. app.uniswap.org"
            spellCheck={false}
            onFocus={(e) => {
              setEditing(true);
              e.target.select();
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>
        <span className="browser-account" title={`dApps see the Safe ${status.safe} on ${status.chainName}`}>
          Safe {short(status.safe)}
        </span>
      </form>

      {error && (
        <div className="note critical browser-note">
          <IconAlert width="15" height="15" />
          <span>{error.charAt(0).toUpperCase() + error.slice(1)}</span>
        </div>
      )}
      {proposed && request === null && (
        <div className="note ok browser-note">
          <IconCheck width="15" height="15" />
          <span>{sole ? `Executing #${proposed.nonce}. The dApp continues once it lands.` : `Proposed #${proposed.nonce}. The dApp waits until another signer executes it, then continues.`}</span>
          <button type="button" className="link" onClick={() => setProposed(undefined)}>
            Dismiss
          </button>
        </div>
      )}

      {queuedNote && request === null && (
        <div className="note ok browser-note">
          <IconCheck width="15" height="15" />
          <span>Queued, not on-chain yet. The dApp sees it as done so you can continue; propose the queue from Transactions.</span>
          <button type="button" className="link" onClick={() => setQueuedNote(false)}>
            Dismiss
          </button>
        </div>
      )}
      <div className="browser-viewport" ref={viewport}>
        {request ? (
          <RequestReview
            key={request.id}
            request={request}
            status={status}
            queueMode={queueMode}
            onProposed={(result) => {
              setQueuedNote(false);
              setProposed(result);
            }}
            onQueued={() => {
              setProposed(undefined);
              setQueuedNote(true);
            }}
          />
        ) : (
          !state.url && <StartPage onOpen={(url) => void open(url)} />
        )}
      </div>
    </div>
  );
}

function StartPage({ onOpen }: { onOpen: (url: string) => void }) {
  return (
    <div className="browser-start">
      <h2>Use any dApp with your Safe</h2>
      <p className="muted">
        dApps opened here see the Safe as the connected wallet. Their transactions become Safe proposals that you review here and sign with your current key. Message signing is refused: it
        would expose your key without rotating it.
      </p>
      <div className="suggestions">
        {SUGGESTIONS.map((item) => (
          <button key={item.url} type="button" className="suggestion" onClick={() => onOpen(item.url)}>
            <span className="suggestion-name">{item.name}</span>
            <span className="muted small">{item.note}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RequestReview({
  request,
  status,
  queueMode,
  onProposed,
  onQueued,
}: {
  request: DappRequest;
  status: StatusView;
  queueMode: boolean;
  onProposed: (result: ProposalResult) => void;
  onQueued: () => void;
}) {
  const sole = useSoleSigner();
  const [preview, setPreview] = useState<ProposalResult>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let current = true;
    browser!.preview(request.id).then(
      (result) => current && setPreview(result),
      (caught: Error) => current && setError(caught.message),
    );
    return () => {
      current = false;
    };
  }, [request.id]);

  async function approve() {
    setWorking(true);
    setError(undefined);
    try {
      onProposed(await browser!.approve(request.id));
    } catch (caught) {
      setError((caught as Error).message);
      setWorking(false);
    }
  }

  async function queue() {
    setWorking(true);
    setError(undefined);
    try {
      await browser!.queue(request.id);
      onQueued();
    } catch (caught) {
      setError((caught as Error).message);
      setWorking(false);
    }
  }

  const queueFirst = queueMode && !request.readsOwnRpc;
  const total = requestValue(request.calls);
  return (
    <section className="card request-review">
      <div className="request-origin">
        <IconGlobe width="16" height="16" />
        <span className="mono">{request.origin}</span>
        <Badge tone="accent">{request.calls.length === 1 ? "1 call" : `${request.calls.length} calls`}</Badge>
      </div>
      <h2>Wants the Safe to</h2>

      {preview ? (
        <div className="review-panel">
          {preview.actions.map((action, i) => (
            <div key={i} className={`tx-action ${action.kind}`}>
              {action.summary}
            </div>
          ))}
          {preview.warnings.map((warning) => (
            <div key={warning} className="note warning">
              <IconAlert width="15" height="15" />
              <span>{warning}</span>
            </div>
          ))}
          <dl className="kv">
            <dt>Sends</dt>
            <dd>{total > 0n ? `${formatEther(total)} ETH` : "No ETH"}</dd>
            <dt>Proposal</dt>
            <dd>
              #{preview.nonce} on {status.chainName}
            </dd>
          </dl>
          <ul className="checklist">
            {sole ? (
              <>
                <li>Sent by your current key, the only signature needed</li>
                <li>You rotate to your next key</li>
              </>
            ) : (
              <>
                <li>Signed with your current key as your confirmation</li>
                <li>Another signer executes; you both rotate</li>
              </>
            )}
          </ul>
        </div>
      ) : (
        !error && <p className="muted">Checking…</p>
      )}

      {request.readsOwnRpc && request.method === "eth_sendTransaction" && (
        <div className="note warning">
          <IconAlert width="15" height="15" />
          <span>
            {sole
              ? "This dApp reads the chain itself, so it only sees transactions once they are on-chain. Execute: it continues once the transaction lands. Queued, it would keep waiting."
              : "This dApp reads the chain itself, so it only sees transactions once they are on-chain. Sign & propose: it waits until another signer executes, then continues. Queued, it would keep waiting."}
          </span>
        </div>
      )}
      {error && (
        <div className="note critical">
          <IconAlert width="15" height="15" />
          <span>{error.charAt(0).toUpperCase() + error.slice(1)}</span>
        </div>
      )}

      <div className="tx-footer">
        <button type="button" onClick={() => void browser!.reject(request.id)} disabled={working}>
          Reject
        </button>
        <button
          type="button"
          className={queueFirst ? "primary" : ""}
          onClick={() => void queue()}
          disabled={working}
          title={request.readsOwnRpc ? "This dApp cannot see queued actions; it will keep waiting" : undefined}
        >
          Add to queue
        </button>
        <button type="button" className={queueFirst ? "" : "primary"} onClick={() => void approve()} disabled={working || !preview}>
          {working ? "Signing…" : sendLabel(sole)}
        </button>
      </div>
    </section>
  );
}
