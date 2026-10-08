import { useEffect, useState } from "react";

import { connect, type Connection } from "./connection";
import { Dashboard } from "./Dashboard";

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
      {connection && connection.mode !== "unconfigured" && <Dashboard client={connection.client} safe={connection.safe} guard={connection.guard} />}
    </main>
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
