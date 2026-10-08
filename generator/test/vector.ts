import type { Address } from "viem";

import { seedSource } from "../src/sources/seed.js";
import { PATH_TEMPLATE } from "../src/sources/source.js";
import { createTreeFile, leafHash, loadTreeFile, proofFor, slotConfig, stageEntries, type TreeMeta } from "@rotating-msig/core";

/** Public test mnemonic. Never use it for real funds. */
export const VECTOR_MNEMONIC = "test test test test test test test test test test test junk";

export const VECTOR_META: TreeMeta = {
  chainId: 1,
  safe: "0x5afE5afE5afE5afE5afE5afE5afE5afE5afE5afE",
  slotId: 0,
  base: 1000,
};

/** An odd size, so the tree has unpaired nodes. */
export const VECTOR_SIZE = 37;

/** Shared with the Solidity cross-check in `test/GeneratorVector.t.sol`. */
export async function buildVector() {
  const source = seedSource(VECTOR_MNEMONIC);
  const addresses: Address[] = [];
  for (let i = 0; i < VECTOR_SIZE; i++) addresses.push(await source.address(VECTOR_META.base + i));
  await source.close();

  const file = createTreeFile(VECTOR_META, PATH_TEMPLATE, addresses);
  const { tree } = loadTreeFile(JSON.stringify(file));
  return {
    mnemonic: VECTOR_MNEMONIC,
    chainId: file.chainId,
    safe: file.safe,
    slotId: file.slotId,
    base: file.base,
    size: file.size,
    root: file.root,
    config: slotConfig(tree, file, 0, "vector"),
    stage: stageEntries(tree, file, 1, 5),
    samples: [0, 17, 36].map((index) => ({ ...proofFor(tree, file, index), leaf: leafHash(file, index, file.addresses[index]!) })),
  };
}
