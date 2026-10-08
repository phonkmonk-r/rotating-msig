import type { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { isAddressEqual, type Address, type PublicClient } from "viem";

import { rotationGuardAbi } from "./abi/rotationGuard.js";
import { deploymentsFor } from "./addresses.js";
import type { InstallPlan } from "./calls.js";
import type { SafeState } from "./state.js";
import { slotConfig, stageEntries, type LeafValue, type TreeFile } from "./tree.js";

/** Addresses staged per slot by the install transaction (fills the guard's buffer). */
export const INSTALL_STAGE_COUNT = 5;

export interface LoadedTree {
  file: TreeFile;
  tree: StandardMerkleTree<LeafValue>;
}

export interface GuardInfo {
  address: Address;
  multiSendCallOnly: Address;
  bufferSize: number;
}

/** Reads the guard's immutable configuration; fails if `address` is not a RotationGuard. */
export async function readGuardInfo(client: PublicClient, address: Address): Promise<GuardInfo> {
  const [multiSendCallOnly, bufferSize] = await Promise.all([
    client.readContract({ address, abi: rotationGuardAbi, functionName: "MULTI_SEND_CALL_ONLY" }),
    client.readContract({ address, abi: rotationGuardAbi, functionName: "BUFFER_SIZE" }),
  ]);
  return { address, multiSendCallOnly, bufferSize: Number(bufferSize) };
}

export interface InstallSelection {
  guard: GuardInfo;
  /** One tree per slot; `trees[i]` must be the tree for slot `i`. */
  trees: readonly LoadedTree[];
  /** `replaces[i]` is the current owner that slot `i`'s index-0 address replaces. */
  replaces: readonly Address[];
}

/**
 * Every reason the install must not be proposed. Checks the guard, the Safe and every tree against each other, so
 * nothing reaches the signers that would revert on-chain or bind the wrong Safe.
 */
export function validateInstall(state: SafeState, selection: InstallSelection): string[] {
  const errors: string[] = [];
  const { guard, trees, replaces } = selection;

  let expectedMultiSend: Address | undefined;
  try {
    expectedMultiSend = deploymentsFor(state.chainId).multiSendCallOnly;
  } catch (error) {
    errors.push((error as Error).message);
  }
  if (expectedMultiSend && !isAddressEqual(guard.multiSendCallOnly, expectedMultiSend)) {
    errors.push(`guard allows MultiSendCallOnly ${guard.multiSendCallOnly}, but this chain's canonical one is ${expectedMultiSend}`);
  }
  if (state.installed) errors.push("RotationGuard is already installed on this Safe");
  if (!isAddressEqual(state.guard, "0x0000000000000000000000000000000000000000")) {
    errors.push(`the Safe already has a transaction guard (${state.guard}); remove it first`);
  }

  if (trees.length !== state.owners.length) {
    errors.push(`load one tree per owner: the Safe has ${state.owners.length} owners, ${trees.length} trees are loaded`);
  }
  if (replaces.length !== trees.length) errors.push("choose which current owner each slot replaces");

  const seenOwners = new Set<string>();
  for (const [slot, owner] of replaces.entries()) {
    if (!state.owners.some((current) => isAddressEqual(current, owner))) errors.push(`slot ${slot}: ${owner} is not a current owner`);
    if (seenOwners.has(owner.toLowerCase())) errors.push(`slot ${slot}: ${owner} is replaced by more than one slot`);
    seenOwners.add(owner.toLowerCase());
  }

  const seenAddresses = new Map<string, number>();
  const seenRoots = new Map<string, number>();
  for (const [slot, { file }] of trees.entries()) {
    const label = `slot ${slot}`;
    if (file.chainId !== state.chainId) errors.push(`${label}: tree is for chain ${file.chainId}, this Safe is on chain ${state.chainId}`);
    if (!isAddressEqual(file.safe, state.safe)) errors.push(`${label}: tree is bound to Safe ${file.safe}, not ${state.safe}`);
    if (file.slotId !== slot) errors.push(`${label}: tree was generated for slot ${file.slotId}`);
    if (file.size < INSTALL_STAGE_COUNT + 1) errors.push(`${label}: tree has ${file.size} addresses; at least ${INSTALL_STAGE_COUNT + 1} are needed`);

    const previous = seenRoots.get(file.root);
    if (previous !== undefined) errors.push(`${label}: same tree as slot ${previous}`);
    seenRoots.set(file.root, slot);

    for (const address of file.addresses) {
      const key = address.toLowerCase();
      if (state.owners.some((owner) => isAddressEqual(owner, address))) errors.push(`${label}: ${address} is already an owner, so its key may be exposed`);
      const other = seenAddresses.get(key);
      if (other !== undefined && other !== slot) errors.push(`${label}: ${address} also appears in slot ${other}'s tree`);
      seenAddresses.set(key, slot);
    }
  }
  return errors;
}

/** Builds the install plan from a selection that `validateInstall` accepted. */
export function planInstall(state: SafeState, selection: InstallSelection): InstallPlan {
  const errors = validateInstall(state, selection);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return {
    safe: state.safe,
    guard: selection.guard.address,
    oldOwners: selection.replaces,
    configs: selection.trees.map(({ file, tree }) => slotConfig(tree, file, 0, "")),
    stage: selection.trees.map(({ file, tree }) => stageEntries(tree, file, 1, INSTALL_STAGE_COUNT)),
    multiSendCallOnly: selection.guard.multiSendCallOnly,
  };
}
