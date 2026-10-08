import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";

import { MAINNET, SEPOLIA_CHAIN_ID } from "../src/addresses.js";
import { installCalls } from "../src/calls.js";
import { INSTALL_STAGE_COUNT, planInstall, validateInstall, type GuardInfo, type InstallSelection } from "../src/setup.js";
import type { SafeState } from "../src/state.js";
import { createTreeFile, loadTreeFile } from "../src/tree.js";

const SAFE: Address = "0x1111111111111111111111111111111111111111";
const GUARD: GuardInfo = { address: "0x2222222222222222222222222222222222222222", multiSendCallOnly: MAINNET.multiSendCallOnly, bufferSize: 5 };
const OWNERS: Address[] = ["0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa", "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB", "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"];

function state(overrides: Partial<SafeState> = {}): SafeState {
  return {
    safe: SAFE,
    chainId: 1,
    owners: OWNERS,
    threshold: 2,
    nonce: 0n,
    balance: 0n,
    guard: "0x0000000000000000000000000000000000000000",
    moduleGuard: "0x0000000000000000000000000000000000000000",
    installed: false,
    epoch: 0n,
    slots: [],
    unmanagedOwners: OWNERS,
    bufferSize: 0,
    ...overrides,
  };
}

function tree(slot: number, options: { chainId?: number; safe?: Address; slotId?: number; size?: number; first?: Address } = {}) {
  const size = options.size ?? 10;
  const addresses = Array.from({ length: size }, (_, i) => getAddress(`0x${(slot * 1000 + i + 1).toString(16).padStart(40, "e")}`));
  if (options.first) addresses[0] = options.first;
  const file = createTreeFile({ chainId: options.chainId ?? 1, safe: options.safe ?? SAFE, slotId: options.slotId ?? slot, base: 1000 }, "test", addresses);
  return loadTreeFile(JSON.stringify(file));
}

function selection(overrides: Partial<InstallSelection> = {}): InstallSelection {
  return { guard: GUARD, trees: [0, 1, 2].map((slot) => tree(slot)), replaces: OWNERS, ...overrides };
}

describe("validateInstall", () => {
  it("accepts a consistent selection and plans the install", () => {
    assert.deepEqual(validateInstall(state(), selection()), []);
    const plan = planInstall(state(), selection());
    assert.equal(plan.configs.length, 3);
    assert.equal(plan.stage[0]!.length, INSTALL_STAGE_COUNT);
    assert.equal(plan.stage[2]![0]!.index, 1);
    assert.equal(installCalls(plan).length, 4 + 3);
  });

  it("works on Sepolia with the same MultiSendCallOnly", () => {
    const trees = [0, 1, 2].map((slot) => tree(slot, { chainId: SEPOLIA_CHAIN_ID }));
    assert.deepEqual(validateInstall(state({ chainId: SEPOLIA_CHAIN_ID }), selection({ trees })), []);
  });

  it("rejects an unsupported chain or a guard allowing another MultiSend", () => {
    assert.match(validateInstall(state({ chainId: 10 }), selection()).join(), /not supported/);
    const guard = { ...GUARD, multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2" as Address };
    assert.match(validateInstall(state(), selection({ guard })).join(), /canonical one is/);
  });

  it("rejects a Safe that already has a guard", () => {
    assert.match(validateInstall(state({ installed: true }), selection()).join(), /already installed/);
    assert.match(validateInstall(state({ guard: "0x3333333333333333333333333333333333333333" }), selection()).join(), /remove it first/);
  });

  it("rejects trees bound to another chain, Safe or slot", () => {
    const errors = validateInstall(
      state(),
      selection({ trees: [tree(0, { chainId: SEPOLIA_CHAIN_ID }), tree(1, { safe: "0x4444444444444444444444444444444444444444" }), tree(2, { slotId: 5 })] }),
    ).join("\n");
    assert.match(errors, /slot 0: tree is for chain 11155111/);
    assert.match(errors, /slot 1: tree is bound to Safe/);
    assert.match(errors, /slot 2: tree was generated for slot 5/);
  });

  it("rejects wrong counts, small trees, reused trees and exposed addresses", () => {
    assert.match(validateInstall(state(), selection({ trees: [tree(0), tree(1)] })).join(), /load one tree per owner/);
    assert.match(validateInstall(state(), selection({ trees: [tree(0), tree(1), tree(2, { size: 5 })] })).join(), /at least 6 are needed/);
    const reused = tree(0);
    assert.match(validateInstall(state(), selection({ trees: [reused, { ...reused, file: { ...reused.file, slotId: 1 } }, tree(2)] })).join(), /same tree as slot 0/);
    assert.match(validateInstall(state(), selection({ trees: [tree(0), tree(1), tree(2, { first: OWNERS[0] })] })).join(), /already an owner/);
  });

  it("rejects a bad owner mapping", () => {
    assert.match(validateInstall(state(), selection({ replaces: [OWNERS[0]!, OWNERS[0]!, OWNERS[2]!] })).join(), /more than one slot/);
    assert.match(
      validateInstall(state(), selection({ replaces: [OWNERS[0]!, OWNERS[1]!, "0x5555555555555555555555555555555555555555"] })).join(),
      /not a current owner/,
    );
    assert.throws(() => planInstall(state(), selection({ replaces: [] })), /choose which current owner/);
  });
});
