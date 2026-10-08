import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, getAddress } from "viem";

import { multiSendCallOnlyAbi } from "../src/abi/multiSendCallOnly.js";
import { rotationGuardAbi } from "../src/abi/rotationGuard.js";
import { unpackMultiSend } from "../src/decode.js";
import { buildProposal } from "../src/proposals.js";
import { TxService } from "../src/txservice.js";
import { plainSafeTx, safeTxHash } from "../src/safetx.js";

const SAFE = getAddress("0x1111111111111111111111111111111111111111");
const GUARD = getAddress("0x2222222222222222222222222222222222222222");
const TO = "0x3333333333333333333333333333333333333333";
const MULTISEND = getAddress("0xA83c336B20401Af773B6219BA5027174338D1836");
const ctx = { safe: SAFE, guard: GUARD };

describe("buildProposal", () => {
  it("builds ETH and ERC-20 transfers", () => {
    assert.deepEqual(buildProposal({ kind: "eth", to: TO, amount: "5" }, ctx), { to: getAddress(TO), value: 5n, data: "0x", operation: 0 });
    const token = buildProposal({ kind: "erc20", token: "0x4444444444444444444444444444444444444444", to: TO, amount: "1000000" }, ctx);
    assert.equal(token.value, 0n);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: token.data }).args, [getAddress(TO), 1000000n]);
  });

  it("builds force-rotate calls on the guard", () => {
    const tx = buildProposal({ kind: "force-rotate", slotIds: [2, 0] }, ctx);
    assert.equal(tx.to, GUARD);
    assert.deepEqual(decodeFunctionData({ abi: rotationGuardAbi, data: tx.data }).args, [[2n, 0n]]);
  });

  it("builds dApp calls: one call as is, several batched through MultiSendCallOnly", () => {
    const one = buildProposal({ kind: "calls", origin: "https://app.example", calls: [{ to: TO, value: "0x10", data: "0xabcdef01" }] }, ctx);
    assert.deepEqual(one, { to: getAddress(TO), value: 16n, data: "0xabcdef01", operation: 0 });
    const two = buildProposal({ kind: "calls", origin: "https://app.example", calls: [{ to: TO, data: "0x01" }, { to: TO, value: "7" }] }, { ...ctx, multiSendCallOnly: MULTISEND });
    assert.equal(two.operation, 1);
    assert.equal(two.to, MULTISEND);
    assert.deepEqual(
      unpackMultiSend(decodeFunctionData({ abi: multiSendCallOnlyAbi, data: two.data }).args[0]),
      [
        { to: getAddress(TO), value: 0n, data: "0x01", operation: 0 },
        { to: getAddress(TO), value: 7n, data: "0x", operation: 0 },
      ],
    );
  });

  it("refuses dApp calls to the Safe or the guard, and malformed calls", () => {
    const calls = (to: string, extra = {}) => ({ kind: "calls" as const, origin: "https://evil.example", calls: [{ to, ...extra }] });
    assert.throws(() => buildProposal(calls(SAFE), ctx), /cannot call the Safe/);
    assert.throws(() => buildProposal(calls(GUARD.toLowerCase()), ctx), /cannot call the rotation guard/);
    assert.throws(() => buildProposal(calls(TO, { data: "0x123" }), ctx), /not hex/);
    assert.throws(() => buildProposal(calls(TO, { value: "-1" }), ctx), /not a number/);
    assert.throws(() => buildProposal({ kind: "calls", origin: "x", calls: [] }, ctx), /no calls/);
  });

  it("flattens a queued batch into one MultiSendCallOnly call, in order", () => {
    const tx = buildProposal(
      {
        kind: "batch",
        items: [
          { kind: "eth", to: TO, amount: "5" },
          { kind: "calls", origin: "https://app.example", calls: [{ to: TO, data: "0x01" }, { to: TO, data: "0x02" }] },
          { kind: "force-rotate", slotIds: [1] },
        ],
      },
      { ...ctx, multiSendCallOnly: MULTISEND },
    );
    assert.equal(tx.to, MULTISEND);
    const calls = unpackMultiSend(decodeFunctionData({ abi: multiSendCallOnlyAbi, data: tx.data }).args[0]);
    assert.deepEqual(
      calls.map((call) => [call.to, call.data]),
      [
        [getAddress(TO), "0x"],
        [getAddress(TO), "0x01"],
        [getAddress(TO), "0x02"],
        [GUARD, calls[3]!.data],
      ],
    );
    assert.throws(() => buildProposal({ kind: "batch", items: [{ kind: "escape" }] }, { ...ctx, multiSendCallOnly: MULTISEND }), /escape hatch cannot be batched/);
    assert.throws(() => buildProposal({ kind: "batch", items: [] }, ctx), /queue is empty/);
  });

  it("rejects bad input", () => {
    assert.throws(() => buildProposal({ kind: "eth", to: "0x12", amount: "1" }, ctx), /recipient is not a valid address/);
    assert.throws(() => buildProposal({ kind: "eth", to: TO, amount: "0" }, ctx), /greater than zero/);
    assert.throws(() => buildProposal({ kind: "eth", to: TO, amount: "1.5" }, ctx), /whole number/);
    assert.throws(() => buildProposal({ kind: "eth", to: SAFE, amount: "1" }, ctx), /the Safe itself/);
    assert.throws(() => buildProposal({ kind: "force-rotate", slotIds: [] }, ctx), /at least one slot/);
    assert.throws(() => buildProposal({ kind: "force-rotate", slotIds: [1, 1] }, ctx), /rotated once/);
  });
});

describe("TxService.propose", () => {
  it("posts the transaction with the locally computed hash and the sender's signature", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const service = new TxService(11155111, {
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response("", { status: 201 });
      }) as typeof fetch,
    });
    const tx = plainSafeTx({ to: getAddress(TO), value: 1n, data: "0x", operation: 0, nonce: 7n });
    const hash = await service.propose(SAFE, tx, getAddress(TO), "0xabcd");
    assert.equal(hash, safeTxHash(11155111, SAFE, tx));
    assert.match(calls[0]!.url, new RegExp(`/safes/${SAFE}/multisig-transactions/$`));
    const body = JSON.parse(calls[0]!.init!.body as string);
    assert.equal(body.contractTransactionHash, hash);
    assert.equal(body.nonce, "7");
    assert.equal(body.data, null);
    assert.equal(body.sender, getAddress(TO));
  });
});
