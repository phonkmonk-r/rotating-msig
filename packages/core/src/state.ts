import { getAddress, hexToBigInt, isAddressEqual, type Address, type Hex, type PublicClient } from "viem";

import { rotationGuardAbi } from "./abi/rotationGuard.js";
import { safeAbi } from "./abi/safe.js";
import { GUARD_STORAGE_SLOT, MODULE_GUARD_STORAGE_SLOT, ZERO_ADDRESS } from "./addresses.js";

export interface SlotState {
  slotId: number;
  root: Hex;
  owner: Address;
  size: number;
  /** Tree index of the current owner. */
  ownerIndex: number;
  /** Tree index the next stage entry must use. */
  nextStageIndex: number;
  staged: Address[];
  /** Tree addresses never used as owner or staged. */
  unstaged: number;
  ownerBalance: bigint;
}

export interface SafeState {
  safe: Address;
  chainId: number;
  owners: Address[];
  threshold: number;
  nonce: bigint;
  balance: bigint;
  guard: Address;
  moduleGuard: Address;
  /** The guard read from the Safe's storage is enabled as module, transaction guard and module guard. */
  installed: boolean;
  epoch: bigint;
  slots: SlotState[];
  /** Owners not tracked by any slot. Only possible when the guard is not installed (or broken). */
  unmanagedOwners: Address[];
  bufferSize: number;
}

async function storageAddress(client: PublicClient, safe: Address, slot: Hex): Promise<Address> {
  const word = await client.readContract({ address: safe, abi: safeAbi, functionName: "getStorageAt", args: [hexToBigInt(slot), 1n] });
  return getAddress(`0x${word.slice(-40)}`);
}

/**
 * Reads everything the app needs about a Safe and its RotationGuard. `guardAddress` defaults to the transaction guard
 * set on the Safe; pass it explicitly to inspect a guard that is not installed yet.
 */
export async function readSafeState(client: PublicClient, safe: Address, guardAddress?: Address): Promise<SafeState> {
  const [chainId, owners, threshold, nonce, balance, guard, moduleGuard] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
    client.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }),
    client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" }),
    client.getBalance({ address: safe }),
    storageAddress(client, safe, GUARD_STORAGE_SLOT),
    storageAddress(client, safe, MODULE_GUARD_STORAGE_SLOT),
  ]);

  const target = guardAddress ?? guard;
  const base = {
    safe: getAddress(safe),
    chainId,
    owners: [...owners],
    threshold: Number(threshold),
    nonce,
    balance,
    guard,
    moduleGuard,
  };
  if (isAddressEqual(target, ZERO_ADDRESS)) {
    return { ...base, installed: false, epoch: 0n, slots: [], unmanagedOwners: [...owners], bufferSize: 0 };
  }

  const [moduleEnabled, config, bufferSize] = await Promise.all([
    client.readContract({ address: safe, abi: safeAbi, functionName: "isModuleEnabled", args: [target] }),
    client.readContract({ address: target, abi: rotationGuardAbi, functionName: "getConfig", args: [safe] }),
    client.readContract({ address: target, abi: rotationGuardAbi, functionName: "BUFFER_SIZE" }),
  ]);
  const installed = moduleEnabled && isAddressEqual(guard, target) && isAddressEqual(moduleGuard, target);

  const slots: SlotState[] = [];
  const unmanagedOwners: Address[] = [];
  await Promise.all(
    owners.map(async (owner) => {
      const [found, slotId] = await client.readContract({ address: target, abi: rotationGuardAbi, functionName: "slotOf", args: [safe, owner] });
      if (!found) {
        unmanagedOwners.push(owner);
        return;
      }
      const [view, ownerBalance] = await Promise.all([
        client.readContract({ address: target, abi: rotationGuardAbi, functionName: "getSlot", args: [safe, slotId] }),
        client.getBalance({ address: owner }),
      ]);
      slots.push({
        slotId: Number(slotId),
        root: view.root,
        owner: view.owner,
        size: view.size,
        ownerIndex: view.nextIndex - 1,
        nextStageIndex: view.nextStageIndex,
        staged: [...view.staged],
        unstaged: view.size - view.nextStageIndex,
        ownerBalance,
      });
    }),
  );
  slots.sort((a, b) => a.slotId - b.slotId);

  return { ...base, installed, epoch: config[0], slots, unmanagedOwners, bufferSize: Number(bufferSize) };
}

export type Severity = "critical" | "warning";

export interface Finding {
  severity: Severity;
  slotId?: number;
  message: string;
}

export interface AssessOptions {
  /** An owner below this balance cannot be the executor. */
  minOwnerGas?: bigint;
  /** Buffers below this depth should be refilled. */
  lowBuffer?: number;
  /** Warn when fewer than this fraction of a tree's addresses are left unused. */
  lowTreeFraction?: number;
}

/** Turns state into findings the dashboard shows and the executor pre-flight blocks on. */
export function assess(state: SafeState, options: AssessOptions = {}): Finding[] {
  const { minOwnerGas = 5_000_000_000_000_000n, lowBuffer = 2, lowTreeFraction = 0.1 } = options;
  const findings: Finding[] = [];
  if (!state.installed) {
    findings.push({ severity: "critical", message: "RotationGuard is not installed as module, transaction guard and module guard" });
    return findings;
  }
  for (const owner of state.unmanagedOwners) {
    findings.push({ severity: "critical", message: `owner ${owner} has no slot` });
  }
  for (const slot of state.slots) {
    const left = slot.staged.length + slot.unstaged;
    if (slot.staged.length === 0) {
      findings.push({ severity: "critical", slotId: slot.slotId, message: "no staged address: any transaction this owner signs will revert" });
    } else if (slot.staged.length < lowBuffer) {
      findings.push({ severity: "warning", slotId: slot.slotId, message: `only ${slot.staged.length} staged address left; refill the buffer` });
    }
    if (left === 0) {
      findings.push({ severity: "critical", slotId: slot.slotId, message: "tree exhausted: commit a new root with setRoot" });
    } else if (left < slot.size * lowTreeFraction) {
      findings.push({ severity: "warning", slotId: slot.slotId, message: `${left} of ${slot.size} tree addresses left; prepare a new tree` });
    }
    if (slot.ownerBalance < minOwnerGas) {
      findings.push({ severity: "warning", slotId: slot.slotId, message: "owner has too little ETH to execute; the keeper should top it up" });
    }
  }
  return findings;
}
