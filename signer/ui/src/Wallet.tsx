import { useState } from "react";

import { desktop } from "./api";
import { short } from "./format";
import { Avatar } from "./ui";

const MIN_PASSWORD = 10;

/** First launch: seed, password and, when joining an existing Safe, its address. Everything else is worked out by the app. */
export function ImportWallet({ onDone }: { onDone: (safe: string) => void }) {
  const [mnemonic, setMnemonic] = useState("");
  const [safe, setSafe] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  const words = mnemonic.trim() === "" ? 0 : mnemonic.trim().split(/\s+/).length;
  const validSafe = safe.trim() === "" || /^0x[0-9a-fA-F]{40}$/.test(safe.trim());
  const mismatch = confirm !== "" && confirm !== password;
  const ready = (words === 12 || words === 24) && validSafe && password.length >= MIN_PASSWORD && password === confirm && !working;

  async function submit() {
    setWorking(true);
    setError(undefined);
    try {
      await desktop!.createVault(mnemonic, password);
      setMnemonic("");
      setPassword("");
      setConfirm("");
      onDone(safe.trim());
    } catch (caught) {
      setError((caught as Error).message);
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
      <h2>Set up your signer</h2>
      <p className="muted">Your seed phrase is encrypted and never leaves this device.</p>

      <label className="field">
        <span className="field-label">
          Seed phrase {words > 0 && <span className="muted">{words} words</span>}
        </span>
        <textarea rows={3} spellCheck={false} autoComplete="off" value={mnemonic} onChange={(e) => setMnemonic(e.target.value)} placeholder="12 or 24 words" />
      </label>

      <label className="field">
        <span className="field-label">
          Safe address <span className="muted">optional</span>
        </span>
        <input placeholder="Leave empty to create a Safe or use an invite" spellCheck={false} value={safe} onChange={(e) => setSafe(e.target.value)} />
        {safe !== "" && !validSafe && <span className="field-error">Not a valid address</span>}
      </label>

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

      {error && <div className="note critical">{error}</div>}
      <button type="submit" className="primary block" disabled={!ready}>
        {working ? "Encrypting…" : "Continue"}
      </button>
    </form>
  );
}

/** Later launches: password only. */
export function UnlockWallet({ operator, onDone }: { operator?: string; onDone: () => void }) {
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
      {operator && (
        <div className="unlock-account">
          <Avatar address={operator} size={48} />
          <span className="mono">{short(operator)}</span>
        </div>
      )}
      <h2 className="center">Welcome back</h2>
      <label className="field">
        <span className="field-label">Password</span>
        <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <div className="note critical">{error.charAt(0).toUpperCase() + error.slice(1)}</div>}
      <button type="submit" className="primary block" disabled={password === "" || working}>
        {working ? "Unlocking…" : "Unlock"}
      </button>
    </form>
  );
}
