import { createTreeFile, type SafeState, type SlotState, type TreeFile, type TreeMeta } from "@rotating-msig/core";
import { isAddressEqual, type Address } from "viem";

import { PATH_TEMPLATE, type AddressSource } from "./source.js";

export interface DiscoveredSlot {
  slot: SlotState;
  base: number;
}

/**
 * Finds which slot of a guarded Safe belongs to this seed: a slot is ours when the key at `base + current index` is
 * its current owner. One derivation per slot and candidate base, so it works however many times the signer has
 * already rotated.
 */
export async function discoverSlot(source: AddressSource, state: SafeState, bases: readonly number[]): Promise<DiscoveredSlot | undefined> {
  for (const base of bases) {
    for (const slot of state.slots) {
      const candidate: Address = await source.address(base + slot.ownerIndex);
      if (isAddressEqual(candidate, slot.owner)) return { slot, base };
    }
  }
  return undefined;
}

/** Derives a full tree from the source, reporting progress every `step` addresses. */
export async function generateTree(
  source: AddressSource,
  meta: TreeMeta,
  size: number,
  onProgress?: (done: number, total: number) => void,
  step = 250,
): Promise<TreeFile> {
  const addresses: Address[] = [];
  for (let i = 0; i < size; i++) {
    addresses.push(await source.address(meta.base + i));
    if (onProgress && ((i + 1) % step === 0 || i + 1 === size)) {
      onProgress(i + 1, size);
      // Yield so progress events and other work can run during a long derivation.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return createTreeFile(meta, PATH_TEMPLATE, addresses);
}
