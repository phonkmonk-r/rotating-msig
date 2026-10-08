import { isAddressEqual, type Address } from "viem";

import { decodeActions, type Action, type DecodeContext } from "./decode.js";
import { type OwnerSignature } from "./safetx.js";
import type { SafeState } from "./state.js";
import type { Confirmation, PendingTx } from "./txservice.js";

export interface Verdict {
  /** The one action this signer may take on this transaction, or none. */
  action: "confirm" | "execute" | "none";
  /** Why no action is allowed (empty when `action` is not "none"). */
  blockers: string[];
  /** Allowed, but the signer should know. */
  warnings: string[];
  /** Plain-language description of what the transaction does. */
  actions: Action[];
  /** Current owners whose confirmations count. */
  validConfirmations: Confirmation[];
  /** For execute: the confirmations to submit alongside the executor's own signature. */
  executeWith?: OwnerSignature[];
}

export interface EvaluateInput {
  state: SafeState;
  pending: PendingTx;
  /** Every pending transaction, used to count owners exposed by confirmations elsewhere in the queue. */
  queue: readonly PendingTx[];
  /** The signer's current owner address. */
  me: Address;
  decode: DecodeContext;
  /** ETH the executor needs for gas; omit to skip the check. */
  executionCost?: bigint;
  myBalance?: bigint;
}

const isOwner = (state: SafeState, address: Address) => state.owners.some((owner) => isAddressEqual(owner, address));

/** Confirmations that count toward the guard: from current owners, as ECDSA or eth_sign signatures. */
function usableConfirmations(state: SafeState, pending: PendingTx): Confirmation[] {
  return pending.confirmations.filter((c) => isOwner(state, c.owner) && (c.signatureType === "EOA" || c.signatureType === "ETH_SIGN"));
}

/**
 * Decides whether `me` may confirm or execute `pending`, enforcing the rules the guard and the design depend on:
 * the last signer executes; no more than threshold - 1 off-chain confirmations; transactions in nonce order; every
 * involved slot has a staged address; and confirmations never expose a full threshold of keys before rotation.
 */
export function evaluate(input: EvaluateInput): Verdict {
  const { state, pending, queue, me, decode } = input;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const actions = decodeActions(pending.tx, decode);
  const threshold = state.threshold;
  const valid = usableConfirmations(state, pending);
  const verdict = (action: Verdict["action"], extra: Partial<Verdict> = {}): Verdict => ({
    action: blockers.length > 0 ? "none" : action,
    blockers,
    warnings,
    actions,
    validConfirmations: valid,
    ...extra,
  });

  if (!state.installed) blockers.push("the rotation guard is not installed on this Safe");
  if (!isOwner(state, me)) blockers.push("your key is not a current owner; it may have rotated out, so reload your current index");
  if (pending.tx.nonce < state.nonce) blockers.push(`nonce ${pending.tx.nonce} is already used; this transaction can never execute`);
  if (pending.tx.nonce > state.nonce) blockers.push(`transactions run in order: nonce ${state.nonce} must execute first`);
  if (actions.some((a) => a.kind === "blocked")) blockers.push("the guard would reject this transaction");
  if (actions.some((a) => a.kind === "escape")) warnings.push("escape hatch: nobody rotates in this transaction; every signer's key must be treated as burned");

  for (const confirmation of pending.confirmations) {
    if (!isOwner(state, confirmation.owner)) {
      warnings.push(`${confirmation.owner} confirmed before rotating out; that confirmation no longer counts`);
    } else if (confirmation.signatureType === "APPROVED_HASH") {
      warnings.push(`${confirmation.owner} approved on-chain (approveHash); the guard rejects that form and the key is exposed, so force-rotate that slot`);
    } else if (confirmation.signatureType === "CONTRACT_SIGNATURE") {
      warnings.push(`${confirmation.owner} gave a contract signature, which the guard rejects`);
    }
  }

  const slotOf = (owner: Address) => state.slots.find((slot) => isAddressEqual(slot.owner, owner));
  const requireStaged = (owner: Address, who: string) => {
    const slot = slotOf(owner);
    if (!slot) blockers.push(`${who} has no slot in the rotation guard`);
    else if (slot.staged.length === 0) blockers.push(`${who} (slot ${slot.slotId}) has no staged address; refill the buffer first`);
  };

  const confirmedByMe = valid.some((c) => isAddressEqual(c.owner, me));
  if (confirmedByMe) {
    blockers.push("you already confirmed; a different signer must execute");
    return verdict("none");
  }

  if (valid.length >= threshold - 1) {
    const chosen = valid.slice(0, threshold - 1);
    if (valid.length > threshold - 1) {
      const extra = valid.slice(threshold - 1).map((c) => c.owner);
      warnings.push(`${extra.length} extra confirmation(s) from ${extra.join(", ")} will not be submitted; those keys are exposed and should be force-rotated`);
    }
    requireStaged(me, "you");
    for (const confirmation of chosen) requireStaged(confirmation.owner, confirmation.owner);
    if (input.executionCost !== undefined && input.myBalance !== undefined && input.myBalance < input.executionCost) {
      blockers.push("your current owner address does not have enough ETH for gas; ask the keeper to top it up");
    }
    return verdict("execute", { executeWith: chosen.map((c) => ({ owner: c.owner, data: c.signature })) });
  }

  requireStaged(me, "you");
  const exposedElsewhere = new Set<string>();
  for (const other of queue) {
    if (other.safeTxHash === pending.safeTxHash) continue;
    for (const c of usableConfirmations(state, other)) exposedElsewhere.add(c.owner.toLowerCase());
  }
  const exposedAfter = new Set([...exposedElsewhere, ...valid.map((c) => c.owner.toLowerCase()), me.toLowerCase()]);
  if (exposedAfter.size >= threshold) {
    blockers.push(
      `confirming would leave ${exposedAfter.size} owners with exposed but unrotated keys (threshold ${threshold}); execute or replace the other pending transactions first`,
    );
  }
  return verdict("confirm");
}
