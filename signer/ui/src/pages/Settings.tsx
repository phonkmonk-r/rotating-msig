import { useState } from "react";

import { desktop, type DesktopState, type StatusView } from "../api";
import { IconLock } from "../icons";
import { Address, Badge, PageHeader } from "../ui";

export function Settings({
  status,
  desktopState,
  onChangeSafe,
  onLock,
  onProfileChanged,
  onSwitchProfile,
}: {
  status: StatusView;
  desktopState: DesktopState;
  onChangeSafe: () => void;
  onLock: () => void;
  onProfileChanged: () => void;
  onSwitchProfile: () => void;
}) {
  const settings = desktopState.settings;
  const profile = desktopState.profile;
  const [name, setName] = useState(profile?.name ?? "");
  const [confirmRemove, setConfirmRemove] = useState("");
  const [error, setError] = useState<string>();

  async function run(action: () => Promise<unknown>, after: () => void) {
    setError(undefined);
    try {
      await action();
      after();
    } catch (caught) {
      setError((caught as Error).message);
    }
  }
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

      {profile && (
        <section className="card">
          <h2 className="card-title">
            Profile <Badge tone={profile.kind === "ledger" ? "accent" : "neutral"}>{profile.kind === "ledger" ? "Ledger" : "Seed phrase"}</Badge>
          </h2>
          <dl className="kv">
            <dt>Name</dt>
            <dd className="inline-edit">
              <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
              <button type="button" disabled={name.trim() === "" || name === profile.name} onClick={() => void run(() => desktop!.renameProfile(profile.id, name), onProfileChanged)}>
                Rename
              </button>
            </dd>
            <dt>Gas account</dt>
            <dd>
              <Address address={profile.operator} chainId={status.chainId} full />
            </dd>
            <dt>Keys</dt>
            <dd>{profile.kind === "ledger" ? "On the Ledger; every signature is confirmed on the device" : "Seed encrypted on this device"}</dd>
          </dl>
          <div className="card-actions">
            <button type="button" onClick={onLock}>
              <IconLock width="15" height="15" /> Lock
            </button>
            <button type="button" onClick={onSwitchProfile}>
              Switch profile
            </button>
          </div>
          <details className="danger-zone">
            <summary>Remove this profile</summary>
            <p className="muted small">
              {profile.kind === "seed"
                ? "Deletes the encrypted seed and this profile's settings from this device. Without your own backup of the seed phrase, its keys are gone for good."
                : "Forgets this Ledger and its settings. The keys stay on the device."}{" "}
              Type the profile name to confirm.
            </p>
            <div className="inline-edit">
              <input value={confirmRemove} placeholder={profile.name} onChange={(e) => setConfirmRemove(e.target.value)} />
              <button type="button" className="danger" disabled={confirmRemove !== profile.name} onClick={() => void run(() => desktop!.removeProfile(profile.id), onProfileChanged)}>
                Remove
              </button>
            </div>
          </details>
          {error && <div className="note critical">{error}</div>}
        </section>
      )}

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
