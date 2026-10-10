import { useState } from "react";

import { desktop, type ProfileView } from "./api";
import { short } from "./format";
import { checkedWordsMatch, newSeedPhrase, pickCheckedWords, positionsLabel } from "./lib/newSeed";
import { MIN_PASSWORD, profileFormProblems, seedWordCount } from "./lib/profileForm";
import { IconPlus } from "./icons";
import { Avatar, Badge } from "./ui";

type Kind = "seed" | "new" | "ledger";

/** Adds a profile: an imported or newly created seed phrase encrypted on this device, or a Ledger. The first one also asks for the Safe. */
export function AddProfile({ suggestedName, onDone, onCancel }: { suggestedName: string; onDone: (safe: string) => void; onCancel?: () => void }) {
  const [kind, setKind] = useState<Kind>("seed");
  const [name, setName] = useState(suggestedName);
  const [mnemonic, setMnemonic] = useState("");
  const [draft, setDraft] = useState(newSeedPhrase);
  const [created, setCreated] = useState<string>();
  const [safe, setSafe] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  const words = seedWordCount(mnemonic);
  const seed = kind === "new" ? (created ?? "") : mnemonic;
  const problems = profileFormProblems({ kind: kind === "ledger" ? "ledger" : "seed", name, mnemonic: seed, safe, password, confirm });
  const validSafe = !problems.includes("safe");
  const mismatch = confirm !== "" && confirm !== password;
  const ready = problems.length === 0 && !working;

  async function submit() {
    setWorking(true);
    setError(undefined);
    try {
      if (kind === "ledger") await desktop!.addLedgerProfile(name);
      else await desktop!.addSeedProfile(name, seed, password);
      setMnemonic("");
      setDraft("");
      setCreated(undefined);
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
        <button type="button" className={kind === "new" ? "active" : ""} onClick={() => setKind("new")}>
          New seed
        </button>
        <button type="button" className={kind === "ledger" ? "active" : ""} onClick={() => setKind("ledger")}>
          Ledger
        </button>
      </div>

      <label className="field">
        <span className="field-label">Profile name</span>
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>

      {kind === "new" ? (
        <NewSeed phrase={draft} onRegenerate={() => setDraft(newSeedPhrase())} confirmed={created !== undefined} onConfirmed={setCreated} />
      ) : kind === "seed" ? (
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

      {(kind !== "new" || created) && (
        <label className="field">
          <span className="field-label">
            Safe address <span className="muted">optional</span>
          </span>
          <input placeholder="Leave empty to create a Safe or use an invite" spellCheck={false} value={safe} onChange={(e) => setSafe(e.target.value)} />
          {!validSafe && <span className="field-error">Not a valid address</span>}
        </label>
      )}

      {((kind === "new" && created) || kind === "seed") && (
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
        {(kind !== "new" || created) && (
          <button type="submit" className="primary" disabled={!ready}>
            {working ? (kind === "ledger" ? "Connecting…" : "Encrypting…") : { seed: "Add profile", new: "Create profile", ledger: "Connect Ledger" }[kind]}
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Creates a seed phrase, shows it to write down, then asks for a few of its words before handing it back.
 * @param phrase The generated phrase, kept by the form so switching tabs does not replace it.
 * @param onRegenerate Replaces the phrase with fresh words.
 * @param confirmed Whether the check passed; the step then shows only that it is done.
 * @param onConfirmed Receives the phrase after the check passes, or undefined to show the words again.
 */
function NewSeed({ phrase, onRegenerate, confirmed, onConfirmed }: { phrase: string; onRegenerate: () => void; confirmed: boolean; onConfirmed: (phrase: string | undefined) => void }) {
  const [stage, setStage] = useState<"write" | "check">("write");
  const [written, setWritten] = useState(false);
  const [checked, setChecked] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [wrong, setWrong] = useState(false);
  const words = phrase.split(" ");

  if (confirmed) {
    return (
      <div className="note ok">
        <span>
          Backup checked. Keep your written copy safe: it is the only way to restore this profile.{" "}
          <button type="button" className="link" onClick={() => (onConfirmed(undefined), setStage("write"), setWritten(false))}>
            Show the words again
          </button>
        </span>
      </div>
    );
  }

  if (stage === "write") {
    return (
      <>
        <div className="note warning">
          <span>Write these 12 words on paper, in order. Anyone who has them controls this wallet, and without them it can't be restored. Don't screenshot, copy or store them online.</span>
        </div>
        <ol className="seed-grid">
          {words.map((word, i) => (
            <li key={i} className="seed-word">
              <span className="seed-index">{i + 1}</span>
              {word}
            </li>
          ))}
        </ol>
        <div className="seed-actions">
          <label className="checkbox">
            <input type="checkbox" checked={written} onChange={(e) => setWritten(e.target.checked)} />
            <span>I wrote down all 12 words in order</span>
          </label>
          <button type="button" className="link" onClick={() => (onRegenerate(), setWritten(false))}>
            New words
          </button>
        </div>
        <button
          type="button"
          className="primary"
          disabled={!written}
          onClick={() => {
            setChecked(pickCheckedWords(words.length));
            setAnswers({});
            setWrong(false);
            setStage("check");
          }}
        >
          Check my backup
        </button>
      </>
    );
  }

  const complete = checked.every((i) => (answers[i] ?? "").trim() !== "");
  function verify() {
    if (checkedWordsMatch(phrase, checked, answers)) onConfirmed(phrase);
    else setWrong(true);
  }

  return (
    <>
      <p className="muted small">From your written copy, enter words {positionsLabel(checked)}.</p>
      <ol className="seed-grid">
        {words.map((_, i) => (
          <li key={i} className={`seed-word ${checked.includes(i) ? "asked" : "hidden"}`}>
            <span className="seed-index">{i + 1}</span>
            {checked.includes(i) ? (
              <input
                aria-label={`Word ${i + 1}`}
                spellCheck={false}
                autoComplete="off"
                autoFocus={i === checked[0]}
                value={answers[i] ?? ""}
                onChange={(e) => (setAnswers({ ...answers, [i]: e.target.value }), setWrong(false))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (complete) verify();
                  }
                }}
              />
            ) : (
              "•••••"
            )}
          </li>
        ))}
      </ol>
      {wrong && <span className="field-error">Those words don't match. Check your copy, or go back to the words.</span>}
      <div className="form-actions">
        <button type="button" onClick={() => (setStage("write"), setWritten(false))}>
          Back to the words
        </button>
        <button type="button" className="primary" disabled={!complete} onClick={verify}>
          Confirm
        </button>
      </div>
    </>
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
