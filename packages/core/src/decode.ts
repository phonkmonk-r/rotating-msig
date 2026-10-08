import { decodeFunctionData, erc20Abi, formatEther, getAddress, hexToBigInt, hexToNumber, isAddressEqual, size, sliceHex, type Address, type Hex } from "viem";

import { multiSendCallOnlyAbi } from "./abi/multiSendCallOnly.js";
import { rotationGuardAbi } from "./abi/rotationGuard.js";
import { safeAbi } from "./abi/safe.js";
import { ZERO_ADDRESS } from "./addresses.js";
import type { MetaTx } from "./calls.js";

export type ActionKind = "transfer" | "token" | "safe-admin" | "guard-admin" | "call" | "escape" | "blocked";

export interface Action {
  kind: ActionKind;
  /** One line in plain language. */
  summary: string;
  to: Address;
  value: bigint;
}

export interface DecodeContext {
  safe: Address;
  guard?: Address;
  multiSendCallOnly: Address;
}

function short(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Splits a MultiSend payload into its calls. */
export function unpackMultiSend(packed: Hex): MetaTx[] {
  const txs: MetaTx[] = [];
  let offset = 0;
  while (offset < size(packed)) {
    const operation = hexToNumber(sliceHex(packed, offset, offset + 1)) === 1 ? 1 : 0;
    const to = getAddress(sliceHex(packed, offset + 1, offset + 21));
    const value = hexToBigInt(sliceHex(packed, offset + 21, offset + 53));
    const length = hexToNumber(sliceHex(packed, offset + 53, offset + 85));
    const data = length === 0 ? "0x" : sliceHex(packed, offset + 85, offset + 85 + length);
    txs.push({ operation, to, value, data });
    offset += 85 + length;
  }
  return txs;
}

/** Describes what a Safe transaction does, one action per call (MultiSend batches are expanded). */
export function decodeActions(tx: Pick<MetaTx, "to" | "value" | "data" | "operation">, context: DecodeContext): Action[] {
  if (tx.operation === 1) {
    if (!isAddressEqual(tx.to, context.multiSendCallOnly)) {
      return [{ kind: "blocked", summary: `Delegatecall to ${short(tx.to)}: the guard only allows MultiSendCallOnly and will reject this`, to: tx.to, value: tx.value }];
    }
    try {
      const { args } = decodeFunctionData({ abi: multiSendCallOnlyAbi, data: tx.data });
      return unpackMultiSend(args[0]).flatMap((call) => decodeActions(call, context));
    } catch {
      return [{ kind: "blocked", summary: "Unreadable MultiSend batch", to: tx.to, value: tx.value }];
    }
  }
  return [decodeCall(tx, context)];
}

function describeGuardCall(name: string, args: readonly unknown[]): string | undefined {
  switch (name) {
    case "addSlot": {
      const [config, threshold] = args as [{ owner: Address }, bigint];
      return `Add a signer whose first key is ${short(config.owner)}; require ${threshold} signature(s)`;
    }
    case "removeSlot": {
      const [slotId, threshold] = args as [bigint, bigint];
      return `Remove the signer in slot ${slotId}; require ${threshold} signature(s)`;
    }
    case "stage": {
      const [, slotId, entries] = args as [Address, bigint, readonly unknown[]];
      return `Stage ${entries.length} next key(s) for slot ${slotId}`;
    }
    case "forceRotate": {
      const [slotIds] = args as [readonly bigint[]];
      return `Rotate slot(s) ${slotIds.join(", ")} to their next keys`;
    }
    default:
      return undefined;
  }
}

function decodeCall(tx: Pick<MetaTx, "to" | "value" | "data">, context: DecodeContext): Action {
  const base = { to: tx.to, value: tx.value };
  if (tx.data === "0x" || size(tx.data) === 0) {
    return { ...base, kind: "transfer", summary: `Send ${formatEther(tx.value)} ETH to ${short(tx.to)}` };
  }

  if (isAddressEqual(tx.to, context.safe)) {
    try {
      const decoded = decodeFunctionData({ abi: safeAbi, data: tx.data });
      if (decoded.functionName === "setGuard" && isAddressEqual(decoded.args[0] as Address, ZERO_ADDRESS)) {
        return { ...base, kind: "escape", summary: "Escape hatch: remove the transaction guard. Signers of this transaction are not rotated; treat them as burned" };
      }
      if (decoded.functionName === "changeThreshold") {
        return { ...base, kind: "safe-admin", summary: `Require ${decoded.args[0]} signature(s) to execute` };
      }
      return { ...base, kind: "safe-admin", summary: `Safe: ${decoded.functionName}(${formatArgs(decoded.args)})` };
    } catch {
      return { ...base, kind: "call", summary: `Unknown call to the Safe itself (selector ${tx.data.slice(0, 10)})` };
    }
  }

  if (context.guard && isAddressEqual(tx.to, context.guard)) {
    try {
      const decoded = decodeFunctionData({ abi: rotationGuardAbi, data: tx.data });
      const friendly = describeGuardCall(decoded.functionName, decoded.args as readonly unknown[]);
      if (friendly) return { ...base, kind: "guard-admin", summary: friendly };
      return { ...base, kind: "guard-admin", summary: `Rotation guard: ${decoded.functionName}(${formatArgs(decoded.args, decoded.functionName === "stage")})` };
    } catch {
      return { ...base, kind: "call", summary: `Unknown call to the rotation guard (selector ${tx.data.slice(0, 10)})` };
    }
  }

  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    if (decoded.functionName === "transfer") {
      const [recipient, amount] = decoded.args as [Address, bigint];
      return { ...base, kind: "token", summary: `Transfer ${amount} units of token ${short(tx.to)} to ${short(recipient)}` };
    }
    if (decoded.functionName === "approve") {
      const [spender, amount] = decoded.args as [Address, bigint];
      return { ...base, kind: "token", summary: `Approve ${short(spender)} to spend ${amount} units of token ${short(tx.to)}` };
    }
  } catch {
    // Not an ERC-20 call.
  }

  const value = tx.value > 0n ? ` with ${formatEther(tx.value)} ETH` : "";
  return { ...base, kind: "call", summary: `Call ${short(tx.to)} (selector ${tx.data.slice(0, 10)})${value}` };
}

function formatArgs(args: readonly unknown[] | undefined, compact = false): string {
  if (!args) return "";
  return args
    .map((arg) => {
      if (Array.isArray(arg)) return compact ? `${arg.length} entries` : `[${arg.map(String).join(", ")}]`;
      if (typeof arg === "object" && arg !== null) return "{…}";
      if (typeof arg === "string" && arg.startsWith("0x") && arg.length === 42) return short(arg as Address);
      return String(arg);
    })
    .join(", ");
}
