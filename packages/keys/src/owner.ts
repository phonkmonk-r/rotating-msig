import { isAddressEqual, type Address, type LocalAccount } from "viem";

import { treeKeyPath, type SafeState, type SlotState, type TreeFile } from "@rotating-msig/core";

import type { AddressSource } from "./source.js";

export interface CurrentOwner {
  slot: SlotState;
  /** Tree index of the current owner. */
  index: number;
  account: LocalAccount;
}

/**
 * Finds the signer's slot from their tree file, derives the key for the slot's current owner index, and checks it
 * against the chain. The signer never chooses an account: the chain decides which key is current.
 */
export async function resolveCurrentOwner(source: AddressSource, tree: TreeFile, state: SafeState): Promise<CurrentOwner> {
  if (tree.chainId !== state.chainId) throw new Error(`tree is for chain ${tree.chainId}, the Safe is on chain ${state.chainId}`);
  if (!isAddressEqual(tree.safe, state.safe)) throw new Error(`tree is bound to Safe ${tree.safe}, not ${state.safe}`);
  const slot = state.slots.find((candidate) => candidate.slotId === tree.slotId);
  if (!slot) throw new Error(`slot ${tree.slotId} has no owner on this Safe`);

  const index = slot.ownerIndex;
  const expected: Address | undefined = tree.addresses[index];
  if (!expected || !isAddressEqual(expected, slot.owner)) {
    throw new Error(`slot ${tree.slotId}'s owner ${slot.owner} is not address ${index} of this tree; is it the right tree file?`);
  }

  const path = treeKeyPath(tree, index);
  const account = await source.signer(path.account, path.index);
  if (!isAddressEqual(account.address, slot.owner)) {
    throw new Error(`the key at account ${path.account}, index ${path.index} is ${account.address}, not the slot owner ${slot.owner}; wrong seed or passphrase?`);
  }
  return { slot, index, account };
}
