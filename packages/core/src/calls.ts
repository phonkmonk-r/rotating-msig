import { concatHex, encodeFunctionData, encodePacked, size, type Address, type Hex } from "viem";

import { rotationGuardAbi } from "./abi/rotationGuard.js";
import { multiSendCallOnlyAbi } from "./abi/multiSendCallOnly.js";
import { safeAbi } from "./abi/safe.js";
import { MAINNET, ZERO_ADDRESS } from "./addresses.js";
import type { SlotConfig, StageEntry } from "./tree.js";

export const OPERATION_CALL = 0;
export const OPERATION_DELEGATECALL = 1;

/** One Safe transaction, in the shape the Safe Apps SDK and Transaction Service use. */
export interface MetaTx {
  to: Address;
  value: bigint;
  data: Hex;
  operation: typeof OPERATION_CALL | typeof OPERATION_DELEGATECALL;
}

function call(to: Address, data: Hex): MetaTx {
  return { to, value: 0n, data, operation: OPERATION_CALL };
}

/** Calls the Safe makes on itself. */
export const safeCalls = {
  enableModule: (safe: Address, module: Address) => call(safe, encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [module] })),
  setGuard: (safe: Address, guard: Address) => call(safe, encodeFunctionData({ abi: safeAbi, functionName: "setGuard", args: [guard] })),
  setModuleGuard: (safe: Address, guard: Address) =>
    call(safe, encodeFunctionData({ abi: safeAbi, functionName: "setModuleGuard", args: [guard] })),
  changeThreshold: (safe: Address, threshold: number) =>
    call(safe, encodeFunctionData({ abi: safeAbi, functionName: "changeThreshold", args: [BigInt(threshold)] })),
  /** The escape hatch: exactly `setGuard(address(0))` on the Safe itself. Its signers are not rotated; treat them as burned. */
  escape: (safe: Address) => call(safe, encodeFunctionData({ abi: safeAbi, functionName: "setGuard", args: [ZERO_ADDRESS] })),
};

/** Calls on RotationGuard. All but `stage` must come from the Safe itself. */
export const guardCalls = {
  initialize: (guard: Address, oldOwners: readonly Address[], configs: readonly SlotConfig[]) =>
    call(guard, encodeFunctionData({ abi: rotationGuardAbi, functionName: "initialize", args: [oldOwners, configs] })),
  addSlot: (guard: Address, config: SlotConfig, newThreshold: number) =>
    call(guard, encodeFunctionData({ abi: rotationGuardAbi, functionName: "addSlot", args: [config, BigInt(newThreshold)] })),
  removeSlot: (guard: Address, slotId: number, newThreshold: number) =>
    call(guard, encodeFunctionData({ abi: rotationGuardAbi, functionName: "removeSlot", args: [BigInt(slotId), BigInt(newThreshold)] })),
  setRoot: (guard: Address, slotId: number, root: Hex, treeSize: number, startIndex: number, cid: string) =>
    call(guard, encodeFunctionData({ abi: rotationGuardAbi, functionName: "setRoot", args: [BigInt(slotId), root, treeSize, startIndex, cid] })),
  skipTo: (guard: Address, slotId: number, index: number) =>
    call(guard, encodeFunctionData({ abi: rotationGuardAbi, functionName: "skipTo", args: [BigInt(slotId), index] })),
  forceRotate: (guard: Address, slotIds: readonly number[]) =>
    call(guard, encodeFunctionData({ abi: rotationGuardAbi, functionName: "forceRotate", args: [slotIds.map(BigInt)] })),
  /** Permissionless: may be sent by any non-owner account, or included in a Safe batch. */
  stage: (guard: Address, safe: Address, slotId: number, entries: readonly StageEntry[]) =>
    call(guard, encodeFunctionData({ abi: rotationGuardAbi, functionName: "stage", args: [safe, BigInt(slotId), entries] })),
};

/** Packs calls in MultiSend's format. Only plain calls: the guard only allows delegatecall to MultiSendCallOnly. */
export function encodeMultiSend(txs: readonly MetaTx[]): Hex {
  return concatHex(
    txs.map((tx) => {
      if (tx.operation !== OPERATION_CALL) throw new Error("MultiSendCallOnly batches cannot contain delegatecalls");
      return encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [tx.operation, tx.to, tx.value, BigInt(size(tx.data)), tx.data]);
    }),
  );
}

/**
 * Wraps calls in one delegatecall to the guard's allowlisted MultiSendCallOnly. The app builds batches itself and
 * proposes a single transaction, rather than letting the wallet choose a MultiSend deployment the guard may reject.
 */
export function batch(txs: readonly MetaTx[], multiSendCallOnly: Address = MAINNET.multiSendCallOnly): MetaTx {
  if (txs.length === 0) throw new Error("empty batch");
  if (txs.length === 1) return txs[0]!;
  return {
    to: multiSendCallOnly,
    value: 0n,
    data: encodeFunctionData({ abi: multiSendCallOnlyAbi, functionName: "multiSend", args: [encodeMultiSend(txs)] }),
    operation: OPERATION_DELEGATECALL,
  };
}

export interface InstallPlan {
  safe: Address;
  guard: Address;
  /** Current owners, in slot order: `oldOwners[i]` is replaced by `configs[i].owner`. */
  oldOwners: readonly Address[];
  configs: readonly SlotConfig[];
  /** Entries to stage per slot, starting at each config's `startIndex + 1`. */
  stage: readonly (readonly StageEntry[])[];
  multiSendCallOnly?: Address;
}

/**
 * The setup calls, unbatched: enable module, set both guards, initialize, stage. Safe{Wallet} batches a list sent
 * through the Safe Apps SDK itself; this is safe for setup because the guard is not active until the batch completes.
 */
export function installCalls(plan: InstallPlan): MetaTx[] {
  if (plan.oldOwners.length !== plan.configs.length) throw new Error("one config is needed per current owner");
  if (plan.stage.length !== plan.configs.length) throw new Error("one stage list is needed per slot");
  plan.configs.forEach((config, slot) => {
    const first = plan.stage[slot]?.[0];
    if (first && first.index !== config.startIndex + 1) {
      throw new Error(`slot ${slot}: staging must start at index ${config.startIndex + 1}, not ${first.index}`);
    }
  });
  return [
    safeCalls.enableModule(plan.safe, plan.guard),
    safeCalls.setGuard(plan.safe, plan.guard),
    safeCalls.setModuleGuard(plan.safe, plan.guard),
    guardCalls.initialize(plan.guard, plan.oldOwners, plan.configs),
    ...plan.stage.flatMap((entries, slot) => (entries.length > 0 ? [guardCalls.stage(plan.guard, plan.safe, slot, entries)] : [])),
  ];
}

/** The setup calls as one delegatecall to MultiSendCallOnly, for executing outside Safe{Wallet}. */
export function installTx(plan: InstallPlan): MetaTx {
  return batch(installCalls(plan), plan.multiSendCallOnly);
}
