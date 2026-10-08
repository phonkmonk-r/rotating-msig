import { useCallback, useEffect, useState, type ReactNode } from "react";

import { canConnect, desktop, type DesktopState } from "./api";
import { useSignerData } from "./data";
import { short } from "./format";
import { IconLock, IconOverview, IconRefresh, IconSettings, IconSigners, IconTransactions, Logo } from "./icons";
import { JoinSafe } from "./JoinSafe";
import { Overview } from "./pages/Overview";
import { Settings } from "./pages/Settings";
import { Signers } from "./pages/Signers";
import { Transactions } from "./pages/Transactions";
import { Avatar } from "./ui";
import { ImportWallet, UnlockWallet } from "./Wallet";

export function App() {
  const [desktopState, setDesktopState] = useState<DesktopState>();
  const [changingSafe, setChangingSafe] = useState(false);
  const [pendingSafe, setPendingSafe] = useState<string>();

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

  if (!desktopState.vault.exists) {
    return (
      <AuthLayout>
        <ImportWallet
          onDone={(safe) => {
            setPendingSafe(safe);
            void reload();
          }}
        />
      </AuthLayout>
    );
  }
  if (!desktopState.vault.unlocked) {
    return (
      <AuthLayout>
        <UnlockWallet operator={desktopState.vault.operator} onDone={() => void reload()} />
      </AuthLayout>
    );
  }
  if (!desktopState.configured || changingSafe) {
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
        <span>Rotation Signer</span>
      </div>
      {children}
    </div>
  );
}

type Page = "overview" | "transactions" | "signers" | "settings";

function Shell({ desktopState, onChangeSafe, onLock }: { desktopState?: DesktopState; onChangeSafe?: () => void; onLock?: () => void }) {
  const data = useSignerData();
  const [page, setPage] = useState<Page>(() => (window.location.hash.match(/page=(\w+)/)?.[1] as Page | undefined) ?? "overview");
  const { status, queue } = data;
  const waiting = queue.filter((item) => item.verdict.action !== "none").length;

  const nav: { id: Page; label: string; icon: ReactNode; count?: number }[] = [
    { id: "overview", label: "Overview", icon: <IconOverview /> },
    { id: "transactions", label: "Transactions", icon: <IconTransactions />, count: waiting },
    { id: "signers", label: "Signers", icon: <IconSigners /> },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <span>Rotation Signer</span>
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

      <main className="content">
        {data.error && <div className="note critical banner-top">Can't reach the signer: {data.error}</div>}
        {status?.queueError && <div className="note warning banner-top">Transaction Service unavailable: pending transactions may be missing.</div>}
        {!status && !data.error && <div className="loading">Loading…</div>}
        {status && page === "overview" && <Overview status={status} queue={queue} onOpenTransactions={() => setPage("transactions")} />}
        {status && page === "transactions" && <Transactions status={status} queue={queue} onBusy={data.setBusy} onRefresh={() => void data.refresh()} />}
        {status && page === "signers" && <Signers status={status} />}
        {status && page === "settings" && desktopState && <Settings status={status} desktopState={desktopState} onChangeSafe={onChangeSafe!} onLock={onLock!} />}
      </main>
    </div>
  );
}
