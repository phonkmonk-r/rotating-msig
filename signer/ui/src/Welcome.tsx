import type { ReactNode } from "react";

import { IconKey, IconLock, IconRefresh, IconSigners, Logo } from "./icons";

/** First launch, before any profile exists: what the app does, then Get started. */
export function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="welcome">
      <section className="welcome-hero">
        <Logo size={76} />
        <h1>Cicada</h1>
        <p className="welcome-tagline">A Safe multisig that sheds its keys. Every signature is the last one its key ever makes.</p>
        <button type="button" className="primary large" onClick={onStart}>
          Get started
        </button>
        <p className="muted small">Seed phrase or Ledger. Your Safe stays a standard Safe.</p>
      </section>

      <div className="welcome-cards">
        <Step icon={<IconKey />} title="One key, one signature">
          Each signer holds a slot in the Safe and signs with that slot's current key. The guard replaces the key in the owner list in the same transaction, so a key that has signed is never an owner again.
        </Step>
        <Step icon={<IconRefresh />} title="Next keys, committed ahead">
          Your next keys come from a list you committed when you joined, and the app keeps a few of them staged on-chain. Even if someone could break a public key, there is nothing exposed left to break.
        </Step>
        <Step icon={<IconSigners />} title="Nothing to switch">
          Cicada reads the chain to find which address is yours right now, then proposes, confirms and executes with it. No accounts to add or swap after a rotation, and you can still watch the Safe in Safe{"{"}Wallet{"}"}.
        </Step>
      </div>

      <section className="welcome-note">
        <IconLock />
        <p>
          <strong>Addresses only.</strong> Cicada works from addresses it reads on-chain. With a Ledger, your keys never leave the device and every signature is confirmed on its screen. With a seed phrase, the seed is encrypted on this computer with your password, and only the key in use is derived, at the moment it signs.
        </p>
      </section>
    </div>
  );
}

function Step({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="card welcome-card">
      <div className="card-icon">{icon}</div>
      <h2>{title}</h2>
      <p className="muted">{children}</p>
    </section>
  );
}
