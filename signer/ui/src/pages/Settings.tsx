import type { DesktopState, StatusView } from "../api";
import { IconLock } from "../icons";
import { Address, PageHeader } from "../ui";

export function Settings({
  status,
  desktopState,
  onChangeSafe,
  onLock,
}: {
  status: StatusView;
  desktopState: DesktopState;
  onChangeSafe: () => void;
  onLock: () => void;
}) {
  const settings = desktopState.settings;
  return (
    <>
      <PageHeader title="Settings" />
      <section className="card">
        <h2 className="card-title">Safe</h2>
        <dl className="kv">
          <dt>Address</dt>
          <dd>
            <Address address={status.safe} chainId={status.chainId} full />
          </dd>
          <dt>Network</dt>
          <dd>{status.chainName}</dd>
          <dt>Your slot</dt>
          <dd>{status.me ? status.me.slotId : "Unknown"}</dd>
        </dl>
        <div className="card-actions">
          <button type="button" onClick={onChangeSafe}>
            Change Safe or network
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Wallet</h2>
        <dl className="kv">
          <dt>Operator account</dt>
          <dd>{desktopState.vault.operator && <Address address={desktopState.vault.operator} chainId={status.chainId} full />}</dd>
          <dt>Storage</dt>
          <dd>Encrypted on this device</dd>
        </dl>
        <div className="card-actions">
          <button type="button" onClick={onLock}>
            <IconLock width="15" height="15" /> Lock
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Connection</h2>
        <dl className="kv">
          <dt>Read RPC</dt>
          <dd>{settings?.rpc ? new URL(settings.rpc).host : "Public RPCs"}</dd>
          <dt>Execution RPC</dt>
          <dd>{status.executionHost}</dd>
        </dl>
      </section>
    </>
  );
}
