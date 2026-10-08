import { useState } from "react";

import { desktop } from "./api";
import { short } from "./format";

const MIN_PASSWORD = 10;

/** First launch: import the seed phrase into the encrypted vault. */
export function ImportWallet({ onDone }: { onDone: () => void }) {
  const [mnemonic, setMnemonic] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  const words = mnemonic.trim() === "" ? 0 : mnemonic.trim().split(/\s+/).length;
  const mismatch = confirm !== "" && confirm !== password;
  const ready = (words === 12 || words === 24) && password.length >= MIN_PASSWORD && password === confirm && !working;

  async function submit() {
    setWorking(true);
    setError(undefined);
    try {
      await desktop!.createVault(mnemonic, password);
      setMnemonic("");
      setPassword("");
      setConfirm("");
      onDone();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="panel setup">
      <h2>Import your wallet</h2>
      <p className="muted">
        Enter your seed phrase. It is encrypted with your password and stored only on this computer. The app uses it for two
        things: your first account pays for staging and gas, and your rotation keys are derived from it for signing.
      </p>
      <div className="field">
        <label htmlFor="mnemonic">Seed phrase</label>
        <textarea
          id="mnemonic"
          rows={3}
          spellCheck={false}
          autoComplete="off"
          value={mnemonic}
          onChange={(e) => setMnemonic(e.target.value)}
          placeholder="12 or 24 words, separated by spaces"
        />
        <p className="muted small">{words > 0 && `${words} words`}</p>
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <p className="muted small">At least {MIN_PASSWORD} characters. You will need it every time you open the app; it cannot be recovered.</p>
      </div>
      <div className="field">
        <label htmlFor="confirm">Confirm password</label>
        <input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {mismatch && <p className="small error-text">Passwords do not match</p>}
      </div>
      {error && <p className="banner critical">{error}</p>}
      <div className="tx-actions">
        <button type="button" className="primary" disabled={!ready} onClick={() => void submit()}>
          {working ? "Encrypting…" : "Import wallet"}
        </button>
      </div>
    </section>
  );
}

/** Later launches: unlock the vault. */
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
    <section className="panel setup unlock">
      <h2>Unlock your wallet</h2>
      {operator && (
        <p className="muted">
          Wallet <span className="mono">{short(operator)}</span>
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor="unlock-password">Password</label>
          <input id="unlock-password" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="banner critical">{error}</p>}
        <div className="tx-actions">
          <button type="submit" className="primary" disabled={password === "" || working}>
            {working ? "Unlocking…" : "Unlock"}
          </button>
        </div>
      </form>
    </section>
  );
}
