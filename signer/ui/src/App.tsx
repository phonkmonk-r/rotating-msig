import { useCallback, useEffect, useState, type ReactNode } from "react";

import { api, browser, canConnect, desktop, type DappRequest, type DesktopState } from "./api";
import { useSignerData } from "./data";
import { short } from "./format";
import { IconGlobe, IconLock, IconOverview, IconRefresh, IconSettings, IconSigners, IconTransactions, Logo } from "./icons";
import { JoinSafe } from "./JoinSafe";
import { Setup } from "./Setup";
import { Browse } from "./pages/Browse";
import { Overview } from "./pages/Overview";
import { Settings } from "./pages/Settings";
import { Signers } from "./pages/Signers";
import { Transactions } from "./pages/Transactions";
import { Avatar } from "./ui";
import { AddProfile, ConnectLedger, ProfilePicker, UnlockWallet } from "./Wallet";

export function App() {
  const [desktopState, setDesktopState] = useState<DesktopState>();
  const [changingSafe, setChangingSafe] = useState(false);
  const [pendingSafe, setPendingSafe] = useState<string>();
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    if (desktop) setDesktopState(await desktop.state());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!desktop) {
    if (!canConnect) {
      return (
        <AuthLayout>
          <div className="auth-card">
            <h2>Open the session link</h2>
            <p className="muted">Use the link printed by rotation-signer in your terminal.</p>
          </div>
        </AuthLayout>
      );
    }
    return <Shell />;
  }

  if (!desktopState) return <div className="boot" />;

  const { profiles, profile } = desktopState;
  if (profiles.length === 0 || adding) {
    return (
      <AuthLayout>
        <AddProfile
          suggestedName={`Wallet ${profiles.length + 1}`}
          onDone={(safe) => {
            setAdding(false);
            setPendingSafe(safe);
            void reload();
          }}
          onCancel={profiles.length > 0 ? () => setAdding(false) : undefined}
        />
      </AuthLayout>
    );
  }
  if (!profile) {
    return (
      <AuthLayout>
        <ProfilePicker profiles={profiles} onPicked={() => void reload()} onAdd={() => setAdding(true)} />
      </AuthLayout>
    );
  }
  if (!desktopState.vault.unlocked) {
    const switchProfile = () => {
      setPendingSafe(undefined);
      void reload();
    };
    return (
      <AuthLayout>
        {profile.kind === "ledger" ? (
          <ConnectLedger name={profile.name} operator={profile.operator} onDone={() => void reload()} onSwitch={switchProfile} />
        ) : (
          <UnlockWallet name={profile.name} operator={profile.operator} onDone={() => void reload()} onSwitch={switchProfile} />
        )}
      </AuthLayout>
    );
  }
  if (!desktopState.configured || changingSafe) {
    if (!pendingSafe) {
      return (
        <AuthLayout>
          <Setup
            state={desktopState}
            onDone={() => {
              setChangingSafe(false);
              void reload();
            }}
            onCancel={desktopState.configured ? () => setChangingSafe(false) : undefined}
          />
        </AuthLayout>
      );
    }
    return (
      <AuthLayout>
        <JoinSafe
          initial={desktopState}
          initialSafe={pendingSafe}
          autoStart={pendingSafe !== undefined}
          onDone={() => {
            setChangingSafe(false);
            setPendingSafe(undefined);
            void reload();
          }}
          onCancel={desktopState.configured ? () => setChangingSafe(false) : undefined}
        />
      </AuthLayout>
    );
  }

  return (
    <Shell
      desktopState={desktopState}
      onChangeSafe={() => setChangingSafe(true)}
      onSwitchProfile={() => {
        void desktop!.deselectProfile().then(() => reload());
      }}
      onProfileChanged={() => void reload()}
      onLock={() => {
        void desktop!.lock().then(() => reload());
      }}
    />
  );
}

function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-brand">
        <Logo />
        <span>Keyturn</span>
      </div>
      {children}
    </div>
  );
}

type Page = "overview" | "transactions" | "browse" | "signers" | "settings";

function Shell({
  desktopState,
  onChangeSafe,
  onLock,
  onSwitchProfile,
  onProfileChanged,
}: {
  desktopState?: DesktopState;
  onChangeSafe?: () => void;
  onLock?: () => void;
  onSwitchProfile?: () => void;
  onProfileChanged?: () => void;
}) {
  const data = useSignerData();
  const [page, setPage] = useState<Page>(() => (window.location.hash.match(/page=(\w+)/)?.[1] as Page | undefined) ?? "overview");
  const { status, queue, refresh } = data;
  const waiting = queue.filter((item) => item.verdict.action !== "none").length;
  const [dappRequest, setDappRequest] = useState<DappRequest | null>(null);

  useEffect(() => {
    if (!browser) return;
    void browser.pending().then(setDappRequest);
    return browser.onRequest((request) => {
      setDappRequest(request);
      if (request) setPage("browse");
      else void refresh();
    });
  }, [refresh]);

  const nav: { id: Page; label: string; icon: ReactNode; count?: number }[] = [
    { id: "overview", label: "Overview", icon: <IconOverview /> },
    { id: "transactions", label: "Transactions", icon: <IconTransactions />, count: waiting + data.draft.items.length },
    ...(browser ? [{ id: "browse" as const, label: "Browse dApps", icon: <IconGlobe />, count: dappRequest ? 1 : 0 }] : []),
    { id: "signers", label: "Signers", icon: <IconSigners /> },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <span>Keyturn</span>
        </div>

        {status && (
          <div className="safe-chip" title={status.safe}>
            <Avatar address={status.safe} size={30} />
            <div>
              <div className="safe-chip-name">Safe</div>
              <div className="mono small">{short(status.safe)}</div>
            </div>
            <span className={`network ${status.chainId === 1 ? "mainnet" : "testnet"}`}>{status.chainId === 1 ? "Ethereum" : status.chainName}</span>
          </div>
        )}

        <nav className="nav">
          {nav.map((item) => (
            <button key={item.id} type="button" className={page === item.id ? "nav-item active" : "nav-item"} onClick={() => setPage(item.id)}>
              {item.icon}
              <span>{item.label}</span>
              {item.count !== undefined && item.count > 0 && <span className="count">{item.count}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          {status && (
            <label className="queue-toggle" title="When on, new transactions are collected in a queue and proposed together">
              <span className="queue-toggle-text">
                Queue transactions
                {data.draft.items.length > 0 && <span className="count">{data.draft.items.length}</span>}
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={data.draft.enabled}
                onChange={(e) => {
                  void api.draftMode(e.target.checked).then(() => data.refresh());
                }}
              />
              <span className="switch" aria-hidden="true" />
            </label>
          )}
          {desktopState?.profile && onSwitchProfile && (
            <button type="button" className="profile-chip" onClick={onSwitchProfile} title="Lock and switch to another profile">
              <Avatar address={desktopState.profile.operator} size={22} />
              <span className="profile-chip-name">{desktopState.profile.name}</span>
              <span className="muted small">Switch</span>
            </button>
          )}
          {desktopState && (
            <button type="button" className={page === "settings" ? "nav-item active" : "nav-item"} onClick={() => setPage("settings")}>
              <IconSettings />
              <span>Settings</span>
            </button>
          )}
          {onLock && (
            <button type="button" className="nav-item" onClick={onLock}>
              <IconLock />
              <span>Lock</span>
            </button>
          )}
          <button type="button" className="sync" onClick={() => void data.refresh()} title="Refresh now">
            <IconRefresh width="14" height="14" className={data.refreshing ? "spin" : ""} />
            <span>{data.updatedAt ? `Synced ${data.updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Syncing…"}</span>
          </button>
        </div>
      </aside>

      <main className={page === "browse" ? "content full" : "content"}>
        {data.error && <div className="note critical banner-top">Can't reach the signer: {data.error}</div>}
        {status?.queueError && <div className="note warning banner-top">Transaction Service unavailable: pending transactions may be missing.</div>}
        {!status && !data.error && <div className="loading">Loading…</div>}
        {status && page === "overview" && <Overview status={status} queue={queue} onOpenTransactions={() => setPage("transactions")} />}
        {status && page === "transactions" && <Transactions status={status} queue={queue} draft={data.draft} onBusy={data.setBusy} onRefresh={() => void data.refresh()} />}
        {status && page === "browse" && <Browse status={status} request={dappRequest} queueMode={data.draft.enabled} />}
        {status && page === "signers" && <Signers status={status} pending={queue.length} queueMode={data.draft.enabled} onQueued={() => void data.refresh()} />}
        {status && page === "settings" && desktopState && <Settings status={status} desktopState={desktopState} onChangeSafe={onChangeSafe!} onLock={onLock!} onProfileChanged={onProfileChanged!} onSwitchProfile={onSwitchProfile!} />}
      </main>
    </div>
  );
}
