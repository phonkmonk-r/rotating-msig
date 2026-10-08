import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, getAddress } from "viem";

import { rotationGuardAbi } from "../src/abi/rotationGuard.js";
import { buildProposal } from "../src/proposals.js";
import { TxService } from "../src/txservice.js";
import { plainSafeTx, safeTxHash } from "../src/safetx.js";

const SAFE = getAddress("0x1111111111111111111111111111111111111111");
const GUARD = getAddress("0x2222222222222222222222222222222222222222");
const TO = "0x3333333333333333333333333333333333333333";
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
