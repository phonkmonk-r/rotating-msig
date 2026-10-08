import { useState, type ReactNode } from "react";

import { explorer, short } from "./format";
import { IconCheck, IconCopy, IconExternal } from "./icons";

/** A small deterministic colour disc for an address, so signers are recognisable at a glance. */
export function Avatar({ address, size = 28 }: { address: string; size?: number }) {
  const hue = parseInt(address.slice(2, 8), 16) % 360;
  const hue2 = (hue + 50) % 360;
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${hue} 65% 55%), hsl(${hue2} 70% 42%))` }}
      aria-hidden="true"
    />
  );
}

/** A shortened address with copy and explorer actions. */
export function Address({ address, chainId, full = false }: { address: string; chainId?: number; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  const link = chainId ? explorer(chainId, "address", address) : undefined;
  return (
    <span className="address">
      <span className="mono" title={address}>
        {full ? address : short(address)}
      </span>
      <button
        type="button"
        className="icon-button small"
        title="Copy address"
        onClick={() => {
          void navigator.clipboard.writeText(address).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <IconCheck width="14" height="14" /> : <IconCopy />}
      </button>
      {link && (
        <a className="icon-button small" href={link} target="_blank" rel="noreferrer" title="View on explorer">
          <IconExternal />
        </a>
      )}
    </span>
  );
}

export function Dots({ filled, total }: { filled: number; total: number }) {
  return (
    <span className="dots" aria-label={`${filled} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={i < filled ? "dot on" : "dot"} />
      ))}
    </span>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warning" | "critical" | "accent"; children: ReactNode }) {
  return <span className={`badge-pill ${tone}`}>{children}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
