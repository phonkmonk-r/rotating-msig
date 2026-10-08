import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatEther } from "viem";

import { desktop, type AddingView, type CreateStage, type CreatingView, type DesktopState, type JoinProgress } from "./api";
import { IconCheck, IconCopy, IconPlus } from "./icons";
import { JoinSafe } from "./JoinSafe";
import { Address, Avatar, Badge } from "./ui";

const CHECK_MS = 15_000;
const SEPOLIA = 11155111;

type Choice = "join" | "create" | "invite" | "added";

/** First connection: join an existing Safe, create a new one, or prepare a slot from an invite. */
export function Setup({ state, onDone, onCancel }: { state: DesktopState; onDone: () => void; onCancel?: () => void }) {
  const [choice, setChoice] = useState<Choice>();
  const [creating, setCreating] = useState<CreatingView | null>();
  const [adding, setAdding] = useState<AddingView | null>();

  const reload = useCallback(async () => {
    const [nextCreating, nextAdding] = await Promise.all([desktop!.creatingState(), desktop!.addingState()]);
    setCreating(nextCreating);
    setAdding(nextAdding);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  if (creating === undefined || adding === undefined) return null;
  if (adding) return <AddedRoom view={adding} onChange={() => void reload()} onDone={onDone} />;
  if (creating?.role === "creator") return <CreatorRoom view={creating} onChange={() => void reload()} onDone={onDone} />;
  if (creating?.role === "signer") return <SignerRoom view={creating} onChange={() => void reload()} onDone={onDone} />;

  if (choice === "join") return <JoinSafe initial={state} onDone={onDone} onCancel={() => setChoice(undefined)} />;
  if (choice === "create") return <CreateForm operator={state.vault.operator!} onBack={() => setChoice(undefined)} onPlanned={() => void reload()} />;
  if (choice === "invite") return <InviteForm onBack={() => setChoice(undefined)} onAccepted={() => void reload()} />;
  if (choice === "added") return <AddedForm onBack={() => setChoice(undefined)} onPrepared={() => void reload()} />;

  return (
    <div className="auth-card">
      <h2>Connect a Safe</h2>
      <p className="muted">Each signer runs this app with their own seed.</p>
      <div className="choices">
        <ChoiceButton title="Join a Safe" note="Its rotation is already set up" onClick={() => setChoice("join")} />
        <ChoiceButton title="Create a new Safe" note="You invite the other signers" onClick={() => setChoice("create")} />
        <ChoiceButton title="I have an invite" note="Someone is creating a Safe with you" onClick={() => setChoice("invite")} />
        <ChoiceButton title="I'm being added to a Safe" note="Its signers will add you as a new signer" onClick={() => setChoice("added")} />
      </div>
      {state.vault.operator && (
        <div className="operator-box">
          <span className="muted small">Your signer address. Send it to whoever creates the Safe.</span>
          <Address address={state.vault.operator} full />
        </div>
      )}
      {onCancel && (
        <div className="form-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function ChoiceButton({ title, note, onClick }: { title: string; note: string; onClick: () => void }) {
  return (
    <button type="button" className="choice" onClick={onClick}>
      <span className="choice-title">{title}</span>
      <span className="muted small">{note}</span>
    </button>
  );
}

function useDeriving() {
  const [progress, setProgress] = useState<JoinProgress>();
  useEffect(() => desktop!.onProgress(setProgress), []);
  const percent = progress?.stage === "deriving" && progress.total ? Math.round(((progress.done ?? 0) / progress.total) * 100) : undefined;
  return { progress, percent, reset: () => setProgress(undefined) };
}

function Progress({ label, percent }: { label: string; percent?: number }) {
  return (
    <div className="progress-block">
      <div className="progress-label">
        <span>{label}</span>
        {percent !== undefined && <span className="muted">{percent}%</span>}
      </div>
      <div className="bar">
        <div style={{ width: `${percent ?? 8}%` }} />
      </div>
    </div>
  );
}

function CreateForm({ operator, onBack, onPlanned }: { operator: string; onBack: () => void; onPlanned: () => void }) {
  const [chainId, setChainId] = useState(SEPOLIA);
  const [others, setOthers] = useState<string[]>([""]);
  const [threshold, setThreshold] = useState(2);
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const { percent } = useDeriving();

  const total = others.length + 1;
  const valid = others.every((value) => /^0x[0-9a-fA-F]{40}$/.test(value.trim()));

  async function submit() {
    setWorking(true);
    setError(undefined);
    try {
      await desktop!.createPlan(chainId, others.map((value) => value.trim()), threshold);
      onPlanned();
    } catch (caught) {
      setError((caught as Error).message);
      setWorking(false);
    }
  }

  return (
    <form
      className="auth-card wide"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !working) void submit();
      }}
    >
      <h2>Create a new Safe</h2>
      <p className="muted">List every signer's address; each one sends you theirs from this app's setup screen.</p>

      <label className="field">
        <span className="field-label">Network</span>
        <select value={chainId} onChange={(e) => setChainId(Number(e.target.value))} disabled={working}>
          <option value={SEPOLIA}>Sepolia (testnet)</option>
          <option value={1} disabled>
            Ethereum (rotation guard not deployed yet)
          </option>
        </select>
      </label>

      <div className="field">
        <span className="field-label">Signers</span>
        <div className="signer-rows">
          <div className="signer-row">
            <span className="slot-number">0</span>
            <Avatar address={operator} size={22} />
            <span className="mono small grow">{operator}</span>
            <Badge tone="accent">You</Badge>
          </div>
          {others.map((value, i) => (
            <div key={i} className="signer-row">
              <span className="slot-number">{i + 1}</span>
              <input
                placeholder="Signer address 0x…"
                spellCheck={false}
                value={value}
                disabled={working}
                onChange={(e) => setOthers(others.map((current, j) => (j === i ? e.target.value : current)))}
              />
              <button
                type="button"
                className="icon-button"
                title="Remove"
                aria-label="Remove signer"
                disabled={working}
                onClick={() => {
                  const next = others.filter((_, j) => j !== i);
                  setOthers(next);
                  setThreshold(Math.min(threshold, next.length + 1));
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="add-row" onClick={() => setOthers([...others, ""])} disabled={working}>
            <IconPlus /> Add signer
          </button>
        </div>
      </div>

      <label className="field">
        <span className="field-label">Signatures needed</span>
        <select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} disabled={working}>
          {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n} of {total}
            </option>
          ))}
        </select>
      </label>

      {working && <Progress label="Generating your keys" percent={percent} />}
      {error && <div className="note critical">{error}</div>}
      <div className="form-actions">
        <button type="button" onClick={onBack} disabled={working}>
          Back
        </button>
        <button type="submit" className="primary" disabled={!valid || working}>
          {working ? "Preparing…" : "Continue"}
        </button>
      </div>
    </form>
  );
}

function InviteForm({ onBack, onAccepted }: { onBack: () => void; onAccepted: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const { percent } = useDeriving();

  async function submit() {
    setWorking(true);
    setError(undefined);
    try {
      await desktop!.createAccept(code.trim());
      onAccepted();
    } catch (caught) {
      setError((caught as Error).message);
      setWorking(false);
    }
  }

  return (
    <form
      className="auth-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim() && !working) void submit();
      }}
    >
      <h2>Use an invite</h2>
      <p className="muted">Paste the invite from the Safe's creator. The app checks it and generates your keys for that Safe.</p>
      <label className="field">
        <span className="field-label">Invite</span>
        <textarea rows={4} spellCheck={false} placeholder="rotation-invite:…" value={code} onChange={(e) => setCode(e.target.value)} disabled={working} />
      </label>
      {working && <Progress label="Generating your keys" percent={percent} />}
      {error && <div className="note critical">{error.charAt(0).toUpperCase() + error.slice(1)}</div>}
      <div className="form-actions">
        <button type="button" onClick={onBack} disabled={working}>
          Back
        </button>
        <button type="submit" className="primary" disabled={!code.trim() || working}>
          {working ? "Preparing…" : "Continue"}
        </button>
      </div>
    </form>
  );
}

function CopyBox({ label, value, hint }: { label: string; value: string; hint: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="copy-box">
        <code>{value}</code>
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <IconCheck width="14" height="14" /> : <IconCopy />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <span className="field-hint">{hint}</span>
    </div>
  );
}

function SafeSummary({ view }: { view: CreatingView }) {
  return (
    <dl className="kv">
      <dt>Safe</dt>
      <dd>
        <Address address={view.safe} />
      </dd>
      <dt>Network</dt>
      <dd>{view.chainName}</dd>
      <dt>Signatures</dt>
      <dd>
        {view.threshold} of {view.slots.length}
      </dd>
    </dl>
  );
}

const STAGE_LABEL: Record<CreateStage, string> = {
  deploying: "Creating the Safe",
  installing: "Installing rotation",
  done: "Installed",
  joining: "Connecting",
};

function CreatorRoom({ view, onChange, onDone }: { view: CreatingView; onChange: () => void; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [stage, setStage] = useState<CreateStage>();
  const [working, setWorking] = useState(false);
  const { percent } = useDeriving();

  useEffect(() => desktop!.onCreateStage(setStage), []);

  async function add() {
    setError(undefined);
    try {
      await desktop!.createAdd(code.trim());
      setCode("");
      onChange();
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  async function launch() {
    setWorking(true);
    setError(undefined);
    try {
      await desktop!.createLaunch();
      onDone();
    } catch (caught) {
      setError((caught as Error).message);
      setWorking(false);
    }
  }

  const waiting = view.slots.filter((slot) => !slot.received).length;
  const short = view.balance !== undefined && view.estimatedCost !== undefined && BigInt(view.balance) < BigInt(view.estimatedCost);
  return (
    <div className="auth-card wide">
      <h2>New Safe</h2>
      <p className="muted">Nothing is on-chain yet. Send the invite to every other signer and paste back the slot package each one returns.</p>
      <SafeSummary view={view} />

      <CopyBox label="Invite" value={view.inviteCode} hint="Safe to share: it holds only addresses." />

      <div className="field">
        <span className="field-label">
          Slot packages <span className="muted">{waiting === 0 ? "all received" : `${waiting} to go`}</span>
        </span>
        <div className="signer-rows">
          {view.slots.map((slot) => (
            <div key={slot.slotId} className="signer-row">
              <span className="slot-number">{slot.slotId}</span>
              <Avatar address={slot.operator} size={22} />
              <span className="mono small grow">{slot.operator}</span>
              {slot.isMe ? <Badge tone="accent">You</Badge> : slot.received ? <Badge tone="ok">Received</Badge> : <Badge>Waiting</Badge>}
            </div>
          ))}
        </div>
      </div>

      {waiting > 0 && (
        <div className="field">
          <textarea rows={3} spellCheck={false} placeholder="Paste a slot package: rotation-slot:…" value={code} onChange={(e) => setCode(e.target.value)} />
          <div className="form-actions">
            <button type="button" onClick={() => void add()} disabled={!code.trim()}>
              Add package
            </button>
          </div>
        </div>
      )}

      {view.ready && view.balance !== undefined && (
        <div className={`note ${short ? "warning" : "ok"}`}>
          <span>
            Your address pays the gas: about {formatEther(BigInt(view.estimatedCost ?? "0")).slice(0, 8)} ETH; it holds {formatEther(BigInt(view.balance)).slice(0, 8)} ETH.
          </span>
        </div>
      )}
      {working && <Progress label={stage ? STAGE_LABEL[stage] : "Starting"} percent={stage === "joining" ? percent : undefined} />}
      {error && <div className="note critical">{error.charAt(0).toUpperCase() + error.slice(1)}</div>}

      <div className="form-actions">
        <button
          type="button"
          disabled={working}
          onClick={() => {
            void desktop!.createCancel().then(onChange);
          }}
        >
          Discard
        </button>
        <button type="button" className="primary" disabled={!view.ready || working} onClick={() => void launch()}>
          {working ? "Creating…" : "Create Safe"}
        </button>
      </div>
    </div>
  );
}

function SignerRoom({ view, onChange, onDone }: { view: CreatingView; onChange: () => void; onDone: () => void }) {
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const { percent, progress } = useDeriving();

  const check = useCallback(async () => {
    setChecking(true);
    setError(undefined);
    try {
      if (await desktop!.createCheck()) onDone();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setChecking(false);
    }
  }, [onDone]);

  useEffect(() => {
    const timer = setInterval(() => void check(), CHECK_MS);
    return () => clearInterval(timer);
  }, [check]);

  const me = view.slots.find((slot) => slot.isMe);
  return (
    <div className="auth-card wide">
      <h2>Joining a new Safe</h2>
      <p className="muted">Your keys for slot {me?.slotId} are ready. Send your slot package to the creator; this screen continues once they create the Safe.</p>
      <SafeSummary view={view} />
      {view.myPackage && <CopyBox label="Your slot package" value={view.myPackage} hint="Holds only addresses and proofs, never keys." />}
      <div className="note pending">
        <span className="spinner" />
        <span>Waiting for the creator to create the Safe</span>
      </div>
      {checking && progress && <Progress label="Connecting" percent={percent} />}
      {error && <div className="note critical">{error.charAt(0).toUpperCase() + error.slice(1)}</div>}
      <div className="form-actions">
        <button type="button" onClick={() => void desktop!.createCancel().then(onChange)} disabled={checking}>
          Leave
        </button>
        <button type="button" className="primary" onClick={() => void check()} disabled={checking}>
          {checking ? "Checking…" : "Check now"}
        </button>
      </div>
    </div>
  );
}

function AddedForm({ onBack, onPrepared }: { onBack: () => void; onPrepared: () => void }) {
  const [safe, setSafe] = useState("");
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const { percent } = useDeriving();
  const valid = /^0x[0-9a-fA-F]{40}$/.test(safe.trim());

  async function submit() {
    setWorking(true);
    setError(undefined);
    try {
      await desktop!.addingPrepare(safe.trim());
      onPrepared();
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message.charAt(0).toUpperCase() + message.slice(1));
      setWorking(false);
    }
  }

  return (
    <form
      className="auth-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !working) void submit();
      }}
    >
      <h2>Join as a new signer</h2>
      <p className="muted">Enter the Safe's address. The app generates your keys for its next slot and gives you a package for its signers.</p>
      <label className="field">
        <span className="field-label">Safe address</span>
        <input placeholder="0x…" spellCheck={false} value={safe} onChange={(e) => setSafe(e.target.value)} disabled={working} />
      </label>
      {working && <Progress label="Generating your keys" percent={percent} />}
      {error && <div className="note critical">{error}</div>}
      <div className="form-actions">
        <button type="button" onClick={onBack} disabled={working}>
          Back
        </button>
        <button type="submit" className="primary" disabled={!valid || working}>
          {working ? "Preparing…" : "Continue"}
        </button>
      </div>
    </form>
  );
}

function AddedRoom({ view, onChange, onDone }: { view: AddingView; onChange: () => void; onDone: () => void }) {
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const { percent, progress } = useDeriving();

  const check = useCallback(async () => {
    setChecking(true);
    setError(undefined);
    try {
      if (await desktop!.addingCheck()) onDone();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setChecking(false);
    }
  }, [onDone]);

  useEffect(() => {
    const timer = setInterval(() => void check(), CHECK_MS);
    return () => clearInterval(timer);
  }, [check]);

  return (
    <div className="auth-card wide">
      <h2>Waiting to be added</h2>
      <p className="muted">
        Send this package to one of the Safe's signers. They add you from Signers, Add a signer; once another signer executes it, this screen continues.
      </p>
      <dl className="kv">
        <dt>Safe</dt>
        <dd>
          <Address address={view.safe} />
        </dd>
        <dt>Network</dt>
        <dd>{view.chainName}</dd>
        <dt>Your slot</dt>
        <dd>{view.slotId}</dd>
      </dl>
      <CopyBox label="Your slot package" value={view.myPackage} hint="Holds only addresses and proofs, never keys." />
      <div className="note pending">
        <span className="spinner" />
        <span>Waiting for the signers to add you</span>
      </div>
      {checking && progress && <Progress label="Connecting" percent={percent} />}
      {error && <div className="note critical">{error.charAt(0).toUpperCase() + error.slice(1)}</div>}
      <div className="form-actions">
        <button type="button" onClick={() => void desktop!.addingCancel().then(onChange)} disabled={checking}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={() => void check()} disabled={checking}>
          {checking ? "Checking…" : "Check now"}
        </button>
      </div>
    </div>
  );
}
