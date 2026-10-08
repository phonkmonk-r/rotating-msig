import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, getAddress, size, sliceHex, hexToBigInt, hexToNumber, type Address, type Hex } from "viem";

import { batch, encodeMultiSend, guardCalls, installTx, OPERATION_CALL, OPERATION_DELEGATECALL, safeCalls, type MetaTx } from "../src/calls.js";
import { MAINNET, ZERO_ADDRESS } from "../src/addresses.js";
import { multiSendCallOnlyAbi } from "../src/abi/multiSendCallOnly.js";
import { rotationGuardAbi } from "../src/abi/rotationGuard.js";
import { safeAbi } from "../src/abi/safe.js";
import type { SlotConfig, StageEntry } from "../src/tree.js";

const SAFE: Address = "0x1111111111111111111111111111111111111111";
const GUARD: Address = "0x2222222222222222222222222222222222222222";
const OWNER = (i: number): Address => getAddress(`0x${(i + 1).toString(16).padStart(40, "a")}`);

function config(slot: number): SlotConfig {
  return { root: `0x${"ab".repeat(32)}`, size: 100, startIndex: 0, owner: OWNER(10 + slot), proof: [`0x${"cd".repeat(32)}`], cid: `cid-${slot}` };
}

function entries(slot: number, from: number, count: number): StageEntry[] {
  return Array.from({ length: count }, (_, i) => ({ index: from + i, owner: OWNER(100 + slot * 10 + i), proof: [`0x${"ef".repeat(32)}`] }));
}

/** Inverse of encodeMultiSend, for testing. */
function decodeMultiSend(packed: Hex): MetaTx[] {
  const txs: MetaTx[] = [];
  let offset = 0;
  while (offset < size(packed)) {
    const operation = hexToNumber(sliceHex(packed, offset, offset + 1)) as 0 | 1;
    const to = getAddress(sliceHex(packed, offset + 1, offset + 21));
    const value = hexToBigInt(sliceHex(packed, offset + 21, offset + 53));
    const length = hexToNumber(sliceHex(packed, offset + 53, offset + 85));
    const data = length === 0 ? "0x" : sliceHex(packed, offset + 85, offset + 85 + length);
    txs.push({ operation, to, value, data });
    offset += 85 + length;
  }
  return txs;
}

describe("calls", () => {
  it("escape is exactly setGuard(address(0)) on the Safe", () => {
    const tx = safeCalls.escape(SAFE);
    assert.equal(tx.to, SAFE);
    assert.equal(tx.operation, OPERATION_CALL);
    const decoded = decodeFunctionData({ abi: safeAbi, data: tx.data });
    assert.equal(decoded.functionName, "setGuard");
    assert.deepEqual(decoded.args, [ZERO_ADDRESS]);
  });

  it("encodes guard calls to the guard", () => {
    const stage = guardCalls.stage(GUARD, SAFE, 2, entries(2, 6, 2));
    assert.equal(stage.to, GUARD);
    const decoded = decodeFunctionData({ abi: rotationGuardAbi, data: stage.data });
    assert.equal(decoded.functionName, "stage");
    assert.equal(decoded.args[0], SAFE);
    assert.equal(decoded.args[1], 2n);
    assert.deepEqual(
      (decoded.args[2] as readonly { index: number }[]).map((e) => e.index),
      [6, 7],
    );

    const force = decodeFunctionData({ abi: rotationGuardAbi, data: guardCalls.forceRotate(GUARD, [0, 2]).data });
    assert.deepEqual(force.args, [[0n, 2n]]);
    const skip = decodeFunctionData({ abi: rotationGuardAbi, data: guardCalls.skipTo(GUARD, 1, 9).data });
    assert.deepEqual(skip.args, [1n, 9]);
  });

  it("round-trips a MultiSend batch and wraps it in one delegatecall", () => {
    const txs: MetaTx[] = [safeCalls.setGuard(SAFE, GUARD), guardCalls.forceRotate(GUARD, [1]), { to: OWNER(5), value: 7n, data: "0x" as Hex, operation: OPERATION_CALL }];
    assert.deepEqual(decodeMultiSend(encodeMultiSend(txs)), txs);

    const wrapped = batch(txs);
    assert.equal(wrapped.to, MAINNET.multiSendCallOnly);
    assert.equal(wrapped.operation, OPERATION_DELEGATECALL);
    const decoded = decodeFunctionData({ abi: multiSendCallOnlyAbi, data: wrapped.data });
    assert.deepEqual(decodeMultiSend(decoded.args[0]), txs);

    assert.equal(batch([txs[0]!]), txs[0]);
    assert.throws(() => batch([]), /empty batch/);
    assert.throws(() => encodeMultiSend([{ ...txs[0]!, operation: OPERATION_DELEGATECALL }]), /cannot contain delegatecalls/);
  });

  it("builds the install batch in the required order", () => {
    const oldOwners = [OWNER(0), OWNER(1), OWNER(2)];
    const configs = [0, 1, 2].map(config);
    const tx = installTx({ safe: SAFE, guard: GUARD, oldOwners, configs, stage: [0, 1, 2].map((slot) => entries(slot, 1, 5)) });
    const inner = decodeMultiSend(decodeFunctionData({ abi: multiSendCallOnlyAbi, data: tx.data }).args[0]);
    const names = inner.map((call) =>
      call.to === SAFE ? decodeFunctionData({ abi: safeAbi, data: call.data }).functionName : decodeFunctionData({ abi: rotationGuardAbi, data: call.data }).functionName,
    );
    assert.deepEqual(names, ["enableModule", "setGuard", "setModuleGuard", "initialize", "stage", "stage", "stage"]);

    const init = decodeFunctionData({ abi: rotationGuardAbi, data: inner[3]!.data });
    assert.deepEqual(init.args[0], oldOwners);
  });

  it("rejects inconsistent install plans", () => {
    const configs = [0, 1].map(config);
    assert.throws(() => installTx({ safe: SAFE, guard: GUARD, oldOwners: [OWNER(0)], configs, stage: [[], []] }), /one config is needed per current owner/);
    assert.throws(
      () => installTx({ safe: SAFE, guard: GUARD, oldOwners: [OWNER(0), OWNER(1)], configs, stage: [entries(0, 2, 1), []] }),
      /staging must start at index 1/,
    );
  });
});
