import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, isAddress, isAddressEqual, isHex, type Address, type Hex } from "viem";

import { multiSendCallOnlyAbi } from "./abi/multiSendCallOnly.js";
import { unpackMultiSend } from "./decode.js";

import { batch, guardCalls, safeCalls, type MetaTx } from "./calls.js";
import { decodePackage } from "./create.js";

/** A call requested by a dApp, as it arrives from the browser (values are decimal or 0x-hex wei). */
export interface DappCall {
  to: string;
  value?: string;
  data?: string;
}

/**
 * What the app can propose: plain transfers, guard maintenance, and calls requested by a dApp in the built-in browser
 * (several calls are batched through MultiSendCallOnly).
 */
export type ProposalInput =
  | { kind: "eth"; to: string; amount: string }
  | { kind: "erc20"; token: string; to: string; amount: string }
  | { kind: "force-rotate"; slotIds: number[] }
  | { kind: "calls"; origin: string; calls: DappCall[] }
  | { kind: "threshold"; threshold: number }
  | { kind: "add-signer"; package: string; threshold: number }
  | { kind: "remove-signer"; slotId: number; threshold: number }
  | { kind: "escape" }
  | { kind: "batch"; items: ProposalInput[] };

/** Most actions one queued batch may hold. */
export const MAX_BATCH_ITEMS = 30;

/** Most calls one dApp request may batch. */
export const MAX_DAPP_CALLS = 20;

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

function quantity(value: string | undefined): bigint {
  if (value === undefined || value === "" || value === "0x") return 0n;
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(value)) throw new Error("value is not a number");
  return BigInt(value);
}

/**
 * Validates a dApp's call. dApps may not call the Safe or the guard: owner, threshold, module and guard changes are
 * proposed only from the app's own screens.
 */
export function dappCall(call: DappCall, context: { safe: Address; guard: Address }): MetaTx {
  const to = address(call.to ?? "", "call target");
  if (to === getAddress(context.safe)) throw new Error("dApps cannot call the Safe itself (owner and setting changes)");
  if (to === getAddress(context.guard)) throw new Error("dApps cannot call the rotation guard");
  const data = call.data === undefined || call.data === "" ? "0x" : call.data;
  if (!isHex(data, { strict: true }) || data.length % 2 !== 0) throw new Error("call data is not hex");
  return { to, value: quantity(call.value), data: data as Hex, operation: 0 };
}

/** Turns a proposal into the Safe call it makes. Amounts are in base units (wei, or the token's smallest unit). */
export function buildProposal(input: ProposalInput, context: { safe: Address; guard: Address; multiSendCallOnly?: Address }): MetaTx {
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
    case "threshold":
      return safeCalls.changeThreshold(context.safe, input.threshold);
    case "remove-signer":
      return guardCalls.removeSlot(context.guard, input.slotId, input.threshold);
    case "add-signer": {
      // The new slot's first key becomes an owner and its next keys are staged in the same transaction.
      const pkg = decodePackage(input.package);
      return batch(
        [guardCalls.addSlot(context.guard, pkg.config, input.threshold), guardCalls.stage(context.guard, context.safe, pkg.slotId, pkg.stage)],
        context.multiSendCallOnly,
      );
    }
    case "escape":
      return safeCalls.escape(context.safe);
    case "batch":
      return batch(batchCalls(input.items, context), context.multiSendCallOnly);
    case "calls": {
      if (input.calls.length === 0) throw new Error("the dApp sent no calls");
      if (input.calls.length > MAX_DAPP_CALLS) throw new Error(`at most ${MAX_DAPP_CALLS} calls per request`);
      return batch(
        input.calls.map((call) => dappCall(call, context)),
        context.multiSendCallOnly,
      );
    }
  }
}

/**
 * The plain calls a queued batch makes, in order: each item is built on its own and nested MultiSend batches are
 * flattened, since MultiSendCallOnly cannot delegatecall into itself. The escape hatch must stay a transaction of its
 * own (the guard recognizes it only as the whole transaction).
 */
export function batchCalls(items: readonly ProposalInput[], context: { safe: Address; guard: Address; multiSendCallOnly?: Address }): MetaTx[] {
  if (items.length === 0) throw new Error("the queue is empty");
  if (items.length > MAX_BATCH_ITEMS) throw new Error(`at most ${MAX_BATCH_ITEMS} actions per batch`);
  return items.flatMap((item) => {
    if (item.kind === "batch") throw new Error("batches cannot be nested");
    if (item.kind === "escape") throw new Error("the escape hatch cannot be batched");
    const tx = buildProposal(item, context);
    if (tx.operation === 0) return [tx];
    if (!context.multiSendCallOnly || !isAddressEqual(tx.to, context.multiSendCallOnly)) throw new Error("unexpected delegatecall in a batch item");
    return unpackMultiSend(decodeFunctionData({ abi: multiSendCallOnlyAbi, data: tx.data }).args[0]);
  });
}
