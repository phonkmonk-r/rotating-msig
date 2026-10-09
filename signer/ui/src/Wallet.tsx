import { useState } from "react";

import { desktop, type ProfileView } from "./api";
import { short } from "./format";
import { MIN_PASSWORD, profileFormProblems, seedWordCount } from "./lib/profileForm";
import { IconPlus } from "./icons";
import { Avatar, Badge } from "./ui";

type Kind = "seed" | "ledger";

/** Adds a profile: a seed phrase encrypted on this device, or a Ledger. The first one also asks for the Safe. */
export function AddProfile({ suggestedName, onDone, onCancel }: { suggestedName: string; onDone: (safe: string) => void; onCancel?: () => void }) {
  const [kind, setKind] = useState<Kind>("seed");
  const [name, setName] = useState(suggestedName);
  const [mnemonic, setMnemonic] = useState("");
  const [safe, setSafe] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  const words = seedWordCount(mnemonic);
  const problems = profileFormProblems({ kind, name, mnemonic, safe, password, confirm });
  const validSafe = !problems.includes("safe");
  const mismatch = confirm !== "" && confirm !== password;
  const ready = problems.length === 0 && !working;

  async function submit() {
    setWorking(true);
    setError(undefined);
    try {
      if (kind === "seed") await desktop!.addSeedProfile(name, mnemonic, password);
      else await desktop!.addLedgerProfile(name);
      setMnemonic("");
      setPassword("");
      setConfirm("");
      onDone(safe.trim());
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message.charAt(0).toUpperCase() + message.slice(1));
    } finally {
      setWorking(false);
    }
  }

  return (
    <form
      className="auth-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void submit();
      }}
    >
      <h2>Add a profile</h2>
      <p className="muted">Each profile is one wallet with its own Safe. Seeds are encrypted and never leave this device.</p>

      <div className="segmented full">
        <button type="button" className={kind === "seed" ? "active" : ""} onClick={() => setKind("seed")}>
          Seed phrase
        </button>
        <button type="button" className={kind === "ledger" ? "active" : ""} onClick={() => setKind("ledger")}>
          Ledger
        </button>
      </div>

      <label className="field">
        <span className="field-label">Profile name</span>
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>

      {kind === "seed" ? (
        <label className="field">
          <span className="field-label">
            Seed phrase {words > 0 && <span className="muted">{words} words</span>}
          </span>
          <textarea rows={3} spellCheck={false} autoComplete="off" value={mnemonic} onChange={(e) => setMnemonic(e.target.value)} placeholder="12 or 24 words" />
        </label>
      ) : (
        <div className="note pending">
          <span>Connect your Ledger, unlock it and open the Ethereum app. The app reads only addresses; every signature is confirmed on the device.</span>
        </div>
      )}

      <label className="field">
        <span className="field-label">
          Safe address <span className="muted">optional</span>
        </span>
        <input placeholder="Leave empty to create a Safe or use an invite" spellCheck={false} value={safe} onChange={(e) => setSafe(e.target.value)} />
        {!validSafe && <span className="field-error">Not a valid address</span>}
      </label>

      {kind === "seed" && (
        <>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Password</span>
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Confirm</span>
              <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
          </div>
          <span className={`field-hint ${mismatch ? "field-error" : ""}`}>{mismatch ? "Passwords don't match" : `At least ${MIN_PASSWORD} characters. It can't be recovered.`}</span>
        </>
      )}

      {error && <div className="note critical">{error}</div>}
      <div className="form-actions">
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={working}>
            Cancel
          </button>
        )}
        <button type="submit" className="primary" disabled={!ready}>
          {working ? (kind === "seed" ? "Encrypting…" : "Connecting…") : kind === "seed" ? "Add profile" : "Connect Ledger"}
        </button>
      </div>
    </form>
  );
}

/** Lists the profiles on this device; choosing one leads to its unlock screen. */
export function ProfilePicker({ profiles, onPicked, onAdd }: { profiles: ProfileView[]; onPicked: () => void; onAdd: () => void }) {
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const [confirm, setConfirm] = useState("");

  async function remove(profile: ProfileView) {
    setError(undefined);
    try {
      await desktop!.removeProfile(profile.id);
      setRemoving(undefined);
      setConfirm("");
      onPicked();
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  return (
    <div className="auth-card">
      <h2>Choose a profile</h2>
      <div className="profile-list">
        {profiles.map((profile) => (
          <div key={profile.id} className="profile-row">
            <div className="profile-row-main">
              <button
                type="button"
                className="profile-option"
                onClick={() => {
                  desktop!.selectProfile(profile.id).then(onPicked, (caught: Error) => setError(caught.message));
                }}
              >
                <Avatar address={profile.operator} size={34} />
                <span className="profile-option-text">
                  <span className="profile-option-name">{profile.name}</span>
                  <span className="muted small mono">
                    {profile.safe ? `Safe ${short(profile.safe)}${profile.safeCount > 1 ? ` +${profile.safeCount - 1}` : ""}` : short(profile.operator)}
                  </span>
                </span>
                <Badge tone={profile.kind === "ledger" ? "accent" : "neutral"}>{profile.kind === "ledger" ? "Ledger" : "Seed"}</Badge>
              </button>
              <button
                type="button"
                className="icon-button"
                title="Remove from this computer"
                aria-label={`Remove ${profile.name}`}
                onClick={() => {
                  setConfirm("");
                  setRemoving(removing === profile.id ? undefined : profile.id);
                }}
              >
                ✕
              </button>
            </div>
            {removing === profile.id && (
              <div className="profile-remove">
                <p className="muted small">
                  {profile.kind === "seed"
                    ? "Deletes this profile's encrypted seed, settings and key lists from this computer. Your Safes, your signer slots and your funds are not affected, and you can add the seed again here or on another computer. Without your own backup of the seed phrase, its keys are gone."
                    : "Forgets this Ledger and its settings on this computer. The keys stay on the device; your Safes are not affected."}{" "}
                  Type the profile name to confirm.
                </p>
                <div className="inline-edit">
                  <input value={confirm} placeholder={profile.name} onChange={(e) => setConfirm(e.target.value)} />
                  <button type="button" className="danger" disabled={confirm !== profile.name} onClick={() => void remove(profile)}>
                    Remove
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {error && <div className="note critical">{error}</div>}
      <button type="button" className="add-row" onClick={onAdd}>
        <IconPlus /> Add a profile
      </button>
    </div>
  );
}

function ProfileHeader({ name, operator }: { name: string; operator: string }) {
  return (
    <div className="unlock-account">
      <Avatar address={operator} size={48} />
      <span className="profile-option-name">{name}</span>
      <span className="mono small">{short(operator)}</span>
    </div>
  );
}

function SwitchProfile({ onSwitch }: { onSwitch: () => void }) {
  return (
    <button type="button" className="link-button" onClick={() => void desktop!.deselectProfile().then(onSwitch)}>
      Use another profile
    </button>
  );
}

/** Later launches of a seed profile: password only. */
export function UnlockWallet({ name, operator, onDone, onSwitch }: { name: string; operator?: string; onDone: () => void; onSwitch: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  async function submit() {
    setWorking(true);
    setError(undefined);
    try {
      await desktop!.unlock(password);
      setPassword("");
      onDone();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <form
      className="auth-card narrow"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {operator && <ProfileHeader name={name} operator={operator} />}
      <label className="field">
        <span className="field-label">Password</span>
        <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <div className="note critical">{error.charAt(0).toUpperCase() + error.slice(1)}</div>}
      <button type="submit" className="primary block" disabled={password === "" || working}>
        {working ? "Unlocking…" : "Unlock"}
      </button>
      <SwitchProfile onSwitch={onSwitch} />
    </form>
  );
}

/** Later launches of a Ledger profile: the same device must be connected with the Ethereum app open. */
export function ConnectLedger({ name, operator, onDone, onSwitch }: { name: string; operator: string; onDone: () => void; onSwitch: () => void }) {
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  async function connect() {
    setWorking(true);
    setError(undefined);
    try {
      await desktop!.connectLedger();
      onDone();
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message.charAt(0).toUpperCase() + message.slice(1));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="auth-card narrow">
      <ProfileHeader name={name} operator={operator} />
      <p className="muted center">Connect this Ledger, unlock it and open the Ethereum app.</p>
      {error && <div className="note critical">{error}</div>}
      <button type="button" className="primary block" disabled={working} onClick={() => void connect()}>
        {working ? "Connecting…" : "Connect Ledger"}
      </button>
      <SwitchProfile onSwitch={onSwitch} />
    </div>
  );
}
