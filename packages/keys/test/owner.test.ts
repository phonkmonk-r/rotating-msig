import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "viem";

import { createTreeFile, type SafeState, type SlotState, type TreeFile } from "@rotating-msig/core";

import { resolveCurrentOwner } from "../src/owner.js";
import { seedSource } from "../src/seed.js";

const SIGNER = "test test test test test test test test test test test junk";
const OTHER = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SAFE: Address = "0x7aC0Ac669d32Bd739eAA892bcFD2C6dF9946Ed02";
const BASE = 100000;

async function tree(slotId = 1): Promise<TreeFile> {
  const source = seedSource(SIGNER);
  const addresses: Address[] = [];
  for (let i = 0; i < 8; i++) addresses.push(await source.address(BASE + i));
  return createTreeFile({ chainId: 11155111, safe: SAFE, slotId, base: BASE }, "m/44'/60'/{account}'/0/0", addresses);
}

function state(file: TreeFile, ownerIndex: number, owner = file.addresses[ownerIndex]!): SafeState {
  const slot: SlotState = { slotId: file.slotId, root: file.root, owner, size: file.size, ownerIndex, nextStageIndex: ownerIndex + 3, staged: [], unstaged: 0, ownerBalance: 0n };
  return {
    safe: SAFE, chainId: 11155111, owners: [owner], threshold: 1, nonce: 0n, balance: 0n,
    guard: SAFE, moduleGuard: SAFE, installed: true, epoch: 1n, slotCount: 1, slots: [slot], unmanagedOwners: [], bufferSize: 5,
  };
}

describe("resolveCurrentOwner", () => {
  it("derives the key for the slot's current index from the chain, not from the user", async () => {
    const file = await tree();
    const current = await resolveCurrentOwner(seedSource(SIGNER), file, state(file, 3));
    assert.equal(current.index, 3);
    assert.equal(current.account.address, file.addresses[3]);
    assert.equal(current.slot.slotId, 1);
  });

  it("refuses the wrong seed, the wrong tree, another Safe or another chain", async () => {
    const file = await tree();
    await assert.rejects(resolveCurrentOwner(seedSource(OTHER), file, state(file, 2)), /wrong seed or passphrase/);
    await assert.rejects(resolveCurrentOwner(seedSource(SIGNER), file, state(file, 2, "0x0000000000000000000000000000000000000abc")), /is not address 2 of this tree/);
    await assert.rejects(resolveCurrentOwner(seedSource(SIGNER), { ...file, safe: "0x1111111111111111111111111111111111111111" }, state(file, 2)), /bound to Safe/);
    await assert.rejects(resolveCurrentOwner(seedSource(SIGNER), { ...file, chainId: 1 }, state(file, 2)), /is for chain 1/);
    await assert.rejects(resolveCurrentOwner(seedSource(SIGNER), await tree(4), state(file, 2)), /slot 4 has no owner/);
  });
});
