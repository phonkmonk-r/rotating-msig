import { BRANCH_PATH_TEMPLATE, createTreeFile, treeKeyPath, type SafeState, type SlotState, type TreeFile, type TreeMeta } from "@rotating-msig/core";
import { isAddressEqual, type Address } from "viem";

import type { AddressSource } from "./source.js";

/** A candidate key layout for a Safe: which path template, and its account (per-Safe) or first account (ranged). */
export interface KeyLayout {
  pathTemplate: string;
  base: number;
  branch?: number;
}

export interface DiscoveredSlot extends KeyLayout {
  slot: SlotState;
}

/**
 * Finds which slot of a guarded Safe belongs to this seed: a slot is ours when the key at its current index, in one of
 * the candidate layouts, is its current owner. One derivation per slot and layout, so it works however many times the
 * signer has already rotated.
 */
export async function discoverSlot(source: AddressSource, state: SafeState, layouts: readonly KeyLayout[]): Promise<DiscoveredSlot | undefined> {
  for (const layout of layouts) {
    for (const slot of state.slots) {
      const path = treeKeyPath(layout, slot.ownerIndex);
      const candidate: Address = await source.address(path.account, path.index, path.branch);
      if (isAddressEqual(candidate, slot.owner)) return { slot, ...layout };
    }
  }
  return undefined;
}

/** Derives a full tree from the source (per-Safe layout unless told otherwise), reporting progress every `step` addresses. */
export async function generateTree(
  source: AddressSource,
  meta: TreeMeta,
  size: number,
  onProgress?: (done: number, total: number) => void,
  step = 250,
  pathTemplate = BRANCH_PATH_TEMPLATE,
): Promise<TreeFile> {
  const addresses: Address[] = [];
  for (let i = 0; i < size; i++) {
    const path = treeKeyPath({ base: meta.base, branch: meta.branch, pathTemplate }, i);
    addresses.push(await source.address(path.account, path.index, path.branch));
    if (onProgress && ((i + 1) % step === 0 || i + 1 === size)) {
      onProgress(i + 1, size);
      // Yield so progress events and other work can run during a long derivation.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return createTreeFile(meta, pathTemplate, addresses);
}
