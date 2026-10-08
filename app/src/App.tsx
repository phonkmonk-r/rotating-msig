import { useEffect, useState } from "react";
import type { PublicClient, Address } from "viem";
import type SafeAppsSDK from "@safe-global/safe-apps-sdk";

import { connect, type Connection } from "./connection";
import { Dashboard } from "./Dashboard";
import { Setup } from "./Setup";
import { useSafeState } from "./useSafeState";

export function App() {
  const [connection, setConnection] = useState<Connection>();

  useEffect(() => {
    connect().then(setConnection, (error: Error) => setConnection({ mode: "unconfigured", reason: error.message }));
  }, []);

  return (
    <main className="app">
      <header className="header">
        <h1>Rotation Guard</h1>
        {connection && connection.mode !== "unconfigured" && (
          <span className="mode">{connection.mode === "safe" ? "Safe{Wallet}" : "Standalone, read-only"}</span>
        )}
      </header>
      {!connection && <p className="muted">Connecting…</p>}
      {connection?.mode === "unconfigured" && <Unconfigured reason={connection.reason} />}
      {connection && connection.mode !== "unconfigured" && (
        <Connected
          client={connection.client}
          safe={connection.safe}
          guard={connection.guard}
          sdk={connection.mode === "safe" ? connection.sdk : undefined}
        />
      )}
    </main>
  );
}

type Tab = "dashboard" | "setup";

function Connected({ client, safe, guard, sdk }: { client: PublicClient; safe: Address; guard?: Address; sdk?: SafeAppsSDK }) {
  const handle = useSafeState(client, safe, guard);
  const [tab, setTab] = useState<Tab>("dashboard");
  const installed = handle.state?.installed ?? false;

  useEffect(() => {
    if (handle.state && !handle.state.installed) setTab("setup");
  }, [handle.state?.installed]);

  return (
    <>
      <nav className="tabs">
        <button type="button" className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}>
          Dashboard
        </button>
        {!installed && (
          <button type="button" className={tab === "setup" ? "active" : ""} onClick={() => setTab("setup")}>
            Setup
          </button>
        )}
      </nav>
      {tab === "dashboard" && <Dashboard handle={handle} />}
      {tab === "setup" && handle.state && (
        <Setup client={client} state={handle.state} sdk={sdk} initialGuard={guard} onProposed={() => void handle.refresh()} />
      )}
    </>
  );
}

function Unconfigured({ reason }: { reason?: string }) {
  return (
    <section className="panel">
      {reason && <p className="error">{reason}</p>}
      <p>Open this app inside Safe{"{"}Wallet{"}"} as a custom Safe App, or standalone with an RPC and Safe address:</p>
      <pre>?rpc=http://127.0.0.1:8545&amp;safe=0xYourSafe</pre>
      <p className="muted">Add &amp;guard=0x… to inspect a guard that is deployed but not installed yet.</p>
    </section>
  );
}
