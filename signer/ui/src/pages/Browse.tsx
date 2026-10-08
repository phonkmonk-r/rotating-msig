import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { formatEther } from "viem";

import { browser, type BrowserState, type DappRequest, type ProposalResult, type StatusView } from "../api";
import { short } from "../format";
import { IconAlert, IconBack, IconCheck, IconForward, IconGlobe, IconRefresh } from "../icons";
import { Badge } from "../ui";

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
export function Browse({ status, request }: { status: StatusView; request: DappRequest | null }) {
  const [state, setState] = useState<BrowserState>(EMPTY);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const [proposed, setProposed] = useState<ProposalResult>();
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
          <span>Proposed #{proposed.nonce}. Another signer executes it; the dApp sees it as pending until then.</span>
          <button type="button" className="link" onClick={() => setProposed(undefined)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="browser-viewport" ref={viewport}>
        {request ? (
          <RequestReview key={request.id} request={request} status={status} onProposed={setProposed} />
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

function RequestReview({ request, status, onProposed }: { request: DappRequest; status: StatusView; onProposed: (result: ProposalResult) => void }) {
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

  const total = request.calls.reduce((sum, call) => sum + (call.value && call.value !== "0x" ? BigInt(call.value) : 0n), 0n);
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
            <li>Signed with your current key as your confirmation</li>
            <li>Another signer executes; you both rotate</li>
          </ul>
        </div>
      ) : (
        !error && <p className="muted">Checking…</p>
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
        <button type="button" className="primary" onClick={() => void approve()} disabled={working || !preview}>
          {working ? "Signing…" : "Sign & propose"}
        </button>
      </div>
    </section>
  );
}
