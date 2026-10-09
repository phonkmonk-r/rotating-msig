import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { formatEther } from "viem";

import { browser, type Bookmark, type BrowserState, type DappRequest, type ProposalResult, type StatusView } from "../api";
import { useBookmarks } from "../bookmarks";
import { short } from "../format";
import { IconAlert, IconBack, IconCheck, IconClose, IconForward, IconGlobe, IconPlus, IconRefresh, IconStar } from "../icons";
import { isSaved, tabLabel } from "../lib/browser";
import { requestValue, sendingLabel, sendingNote, sendLabel } from "../lib/execution";
import { Badge, useSoleSigner } from "../ui";

/** Start page apps; `colour` paints the letter tile, since the page's CSP keeps remote icons out. */
const SUGGESTIONS = [
  { name: "Uniswap", url: "https://app.uniswap.org", note: "Swap tokens", colour: "#ff007a" },
  { name: "CoW Swap", url: "https://swap.cow.fi", note: "Swaps without MEV", colour: "#052b65" },
  { name: "Aave", url: "https://app.aave.com", note: "Lend and borrow", colour: "linear-gradient(135deg, #b6509e, #2ebac6)" },
  { name: "Curve", url: "https://curve.finance", note: "Stablecoin swaps", colour: "linear-gradient(135deg, #2b47e6, #e8433f)" },
  { name: "Revoke.cash", url: "https://revoke.cash", note: "Check approvals", colour: "#1c1c1c" },
];

const EMPTY: BrowserState = { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, tabs: [] };

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
  const bookmarks = useBookmarks();
  const saved = isSaved(bookmarks, state.url);

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

  async function tabAction(action: () => Promise<BrowserState>) {
    setError(undefined);
    try {
      setState(await action());
      setEditing(false);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  return (
    <div className="browser">
      {state.tabs.length > 0 && (
        <div className="browser-tabs" role="tablist" aria-label="Open pages">
          {state.tabs.map((tab) => {
            const label = tabLabel(tab);
            const active = tab.id === state.activeTab;
            return (
              <div key={tab.id} className={`browser-tab ${active ? "active" : ""}`}>
                <button type="button" role="tab" aria-selected={active} className="browser-tab-title" title={tab.url || label} onClick={() => void tabAction(() => browser!.selectTab(tab.id))}>
                  {tab.loading ? <span className="spinner" /> : tab.icon ? <img className="site-icon" src={tab.icon} alt="" /> : <IconGlobe width="13" height="13" />}
                  <span className="browser-tab-label">{label}</span>
                </button>
                <button type="button" className="browser-tab-close" aria-label={`Close ${label}`} title="Close tab" onClick={() => void tabAction(() => browser!.closeTab(tab.id))}>
                  <IconClose width="12" height="12" />
                </button>
              </div>
            );
          })}
          <button type="button" className="browser-tab-new icon-button" aria-label="New tab" title="New tab" onClick={() => void tabAction(() => browser!.newTab())}>
            <IconPlus width="14" height="14" />
          </button>
        </div>
      )}
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
          <button
            type="button"
            className={`icon-button browser-star ${saved ? "saved" : ""}`}
            aria-label={saved ? "Remove from saved pages" : "Save this page"}
            aria-pressed={saved}
            title={saved ? "Remove from saved pages" : "Save this page"}
            disabled={!state.url}
            onClick={() =>
              void (saved ? browser!.removeBookmark(state.url) : browser!.addBookmark(state.url, state.tabs.find((tab) => tab.id === state.activeTab)?.icon)).catch((caught: Error) =>
                setError(caught.message),
              )
            }
          >
            <IconStar width="16" height="16" />
          </button>
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
          !state.url && <StartPage saved={bookmarks} onOpen={(url) => void open(url)} />
        )}
      </div>
    </div>
  );
}

function StartPage({ saved, onOpen }: { saved: Bookmark[]; onOpen: (url: string) => void }) {
  return (
    <div className="browser-start">
      <div className="start-hero">
        <span className="start-hero-icon">
          <IconGlobe width="22" height="22" />
        </span>
        <h2>Use any dApp with your Safe</h2>
        <p className="muted">Open a dApp and it connects to your Safe. Every transaction it asks for comes back here for you to review and sign.</p>
      </div>
      <ul className="start-points">
        <li>
          <IconCheck width="14" height="14" /> Connects as your Safe
        </li>
        <li>
          <IconCheck width="14" height="14" /> Transactions become proposals
        </li>
        <li className="refused" title="Signing a message would expose your key without rotating it">
          <IconClose width="14" height="14" /> Message signing is refused
        </li>
      </ul>
      {saved.length > 0 && (
        <section className="start-section">
          <h3>Saved</h3>
          <div className="suggestions">
            {saved.map((item) => (
              <AppTile key={item.url} name={tabLabel(item)} note={host(item.url)} icon={item.icon} onOpen={() => onOpen(item.url)} />
            ))}
          </div>
        </section>
      )}
      <section className="start-section">
        <h3>Popular</h3>
        <div className="suggestions">
          {SUGGESTIONS.map((item) => (
            <AppTile key={item.url} name={item.name} note={item.note} colour={item.colour} onOpen={() => onOpen(item.url)} />
          ))}
        </div>
      </section>
      <p className="start-hint muted small">Or type any address in the bar above.</p>
    </div>
  );
}

function AppTile({ name, note, icon, colour, onOpen }: { name: string; note: string; icon?: string; colour?: string; onOpen: () => void }) {
  return (
    <button type="button" className="suggestion" onClick={onOpen}>
      {icon ? (
        <img className="suggestion-icon" src={icon} alt="" />
      ) : (
        <span className="suggestion-icon letter" style={{ background: colour ?? "var(--accent)" }}>
          {name.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="suggestion-text">
        <span className="suggestion-name">{name}</span>
        <span className="muted small">{note}</span>
      </span>
      <IconForward className="suggestion-arrow" width="14" height="14" />
    </button>
  );
}

const host = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

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
        !error && (
          <div className="note pending" role="status">
            <span className="spinner" />
            <span>Simulating the transaction against the chain…</span>
          </div>
        )
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
      {working && (
        <div className="note pending" role="status">
          <span className="spinner" />
          <span>{sendingNote(sole)}</span>
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
          {working ? sendingLabel(sole) : sendLabel(sole)}
        </button>
      </div>
    </section>
  );
}
