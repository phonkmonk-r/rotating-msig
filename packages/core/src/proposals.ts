import { encodeFunctionData, erc20Abi, getAddress, isAddress, type Address } from "viem";

import { guardCalls, type MetaTx } from "./calls.js";

/** What the app can propose in v1: plain transfers and guard maintenance. */
export type ProposalInput =
  | { kind: "eth"; to: string; amount: string }
  | { kind: "erc20"; token: string; to: string; amount: string }
  | { kind: "force-rotate"; slotIds: number[] };

function address(value: string, field: string): Address {
  if (!isAddress(value, { strict: false })) throw new Error(`${field} is not a valid address`);
  return getAddress(value);
}

function positiveAmount(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error("amount must be a whole number of base units");
  const amount = BigInt(value);
  if (amount <= 0n) throw new Error("amount must be greater than zero");
  return amount;
}

/** Turns a proposal into the Safe call it makes. Amounts are in base units (wei, or the token's smallest unit). */
export function buildProposal(input: ProposalInput, context: { safe: Address; guard: Address }): MetaTx {
  switch (input.kind) {
    case "eth": {
      const to = address(input.to, "recipient");
      if (to === getAddress(context.safe)) throw new Error("the recipient is the Safe itself");
      return { to, value: positiveAmount(input.amount), data: "0x", operation: 0 };
    }
    case "erc20": {
      const token = address(input.token, "token");
      const to = address(input.to, "recipient");
      return { to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, positiveAmount(input.amount)] }), operation: 0 };
    }
    case "force-rotate": {
      if (input.slotIds.length === 0) throw new Error("choose at least one slot");
      if (new Set(input.slotIds).size !== input.slotIds.length) throw new Error("each slot can be rotated once");
      return guardCalls.forceRotate(context.guard, input.slotIds);
    }
  }
}
