import { useState } from "react";

import { api, type Exposure, type ProposalResult } from "../api";
import { IconAlert } from "../icons";

/**
 * The fix for keys that signed something that never went through: one force-rotate of every exposed slot, proposed
 * at the current nonce so it also cancels the lost transaction. Preview first, then sign and propose.
 */
export function Recover({ exposure, onProposed }: { exposure: Exposure; onProposed?: () => void }) {
  const [review, setReview] = useState<ProposalResult & { slotIds: number[] }>();
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  async function run(step: () => Promise<void>) {
    setWorking(true);
    setError(undefined);
    try {
      await step();
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message.charAt(0).toUpperCase() + message.slice(1));
    } finally {
      setWorking(false);
    }
  }

  const slots = exposure.slotIds.map((slotId) => `slot ${slotId}`).join(", ");
  if (done) return <p className="muted small">Proposed #{done}: fresh keys for {slots}. Another signer executes it from Transactions, and everyone who signed rotates.</p>;
  return (
    <div className="recover">
      <p className="small">
        Transaction #{exposure.nonce} was signed but never went through, so the keys of {slots} are public without having rotated. Replacing them is one transaction: it
        gives each of those slots its next key and takes the place of #{exposure.nonce}.
      </p>
      {review && (
        <div className="review-panel">
          {review.actions.map((action, i) => (
            <div key={i} className={`tx-action ${action.kind}`}>
              {action.summary}
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="note critical">
          <IconAlert width="15" height="15" />
          <span>{error}</span>
        </div>
      )}
      <div className="tx-footer">
        {review ? (
          <button
            type="button"
            className="primary"
            disabled={working}
            onClick={() =>
              void run(async () => {
                setDone((await api.recover(false)).nonce);
                onProposed?.();
              })
            }
          >
            {working ? "Signing…" : "Sign & propose"}
          </button>
        ) : (
          <button type="button" className="primary" disabled={working} onClick={() => void run(async () => setReview(await api.recover(true)))}>
            {working ? "Checking…" : "Replace exposed keys"}
          </button>
        )}
      </div>
    </div>
  );
}
