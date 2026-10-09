import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, erc20Abi, getAddress, recoverAddress, size, type Address, type Hex } from "viem";

import { MAINNET, SEPOLIA_CHAIN_ID } from "../src/addresses.js";
import { batch, guardCalls, safeCalls } from "../src/calls.js";
import { decodeActions } from "../src/decode.js";
import { evaluate } from "../src/rules.js";
import { packSignatures, plainSafeTx, preValidatedSignature, safeTxHash, type SafeTx } from "../src/safetx.js";
import type { SafeState, SlotState } from "../src/state.js";
import { TxService, txServiceUrl, type Confirmation, type PendingTx } from "../src/txservice.js";

/** The first guarded transaction on the Sepolia test Safe (nonce 1), as reported by the Transaction Service. */
const SEPOLIA = {
  safe: "0x7aC0Ac669d32Bd739eAA892bcFD2C6dF9946Ed02" as Address,
  tx: plainSafeTx({ to: "0xBDD48ac62B4cc6C347175751588fE5CAf927bbF9", value: 100000000000000n, data: "0x", operation: 0, nonce: 1n }, 0n),
  safeTxHash: "0x4a4faf6109fac5a9d0be90f5062ff027301af82a969905f3a9e9fa5d43a5fee4" as Hex,
  confirmer: "0xfD4875be1fd08A81215C32b10E31B06EdFE78eB3" as Address,
  signature:
    "0xb176340364ba8543dea29ea9a9e0d583795258cb5b5f7ea9b109f47945fda4092512492a7acc285e74558288f9c934a50f8546557cffec3566974f29914330021c" as Hex,
};

describe("safetx", () => {
  it("reproduces the safeTxHash of a real Sepolia transaction from its fields", () => {
    assert.equal(safeTxHash(SEPOLIA_CHAIN_ID, SEPOLIA.safe, SEPOLIA.tx), SEPOLIA.safeTxHash);
  });

  it("recovers the confirming owner from the real confirmation", async () => {
    assert.equal(await recoverAddress({ hash: SEPOLIA.safeTxHash, signature: SEPOLIA.signature }), SEPOLIA.confirmer);
  });

  it("builds the executor's pre-validated signature exactly as Safe{Wallet} did", () => {
    const executor = getAddress("0xBDD48ac62B4cc6C347175751588fE5CAf927bbF9");
    assert.equal(
      preValidatedSignature(executor).data,
      "0x000000000000000000000000bdd48ac62b4cc6c347175751588fe5caf927bbf9000000000000000000000000000000000000000000000000000000000000000001",
    );
  });

  it("packs signatures sorted by owner", () => {
    const high = preValidatedSignature("0xffFfFFfFfFFFFfFfFFfFfFFFFFfFFfFfFFfFfFFf");
    const low = preValidatedSignature("0x0000000000000000000000000000000000000002");
    const packed = packSignatures([high, low]);
    assert.equal(size(packed), 130);
    assert.ok(packed.slice(2, 132).endsWith(low.data.slice(2)));
    assert.throws(() => packSignatures([{ owner: low.owner, data: "0x01" }]), /not 65 bytes/);
  });
});

describe("TxService", () => {
  const serviceTx = {
    safe: SEPOLIA.safe,
    to: SEPOLIA.tx.to,
    value: "100000000000000",
    data: null,
    operation: 0,
    safeTxGas: 0,
    baseGas: 0,
    gasPrice: "0",
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: 1,
    safeTxHash: SEPOLIA.safeTxHash,
    confirmations: [{ owner: SEPOLIA.confirmer, signature: SEPOLIA.signature, signatureType: "EOA" }],
  };

  function mockFetch(responses: unknown[], calls: { url: string; init?: RequestInit }[] = []): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const body = responses.shift();
      return new Response(body === undefined ? "" : JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
  }

  it("uses the api.safe.global endpoints", () => {
    assert.equal(txServiceUrl(SEPOLIA_CHAIN_ID), "https://api.safe.global/tx-service/sep");
    assert.equal(txServiceUrl(1), "https://api.safe.global/tx-service/eth");
    assert.throws(() => txServiceUrl(10), /no Safe Transaction Service/);
  });

  it("parses pending transactions and verifies their hashes", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const service = new TxService(SEPOLIA_CHAIN_ID, { fetch: mockFetch([{ results: [serviceTx] }], calls), apiKey: "k" });
    const [pending] = await service.pending(SEPOLIA.safe, 1n);
    assert.equal(pending!.safeTxHash, SEPOLIA.safeTxHash);
    assert.equal(pending!.tx.data, "0x");
    assert.equal(pending!.confirmations[0]!.owner, SEPOLIA.confirmer);
    assert.match(calls[0]!.url, /executed=false&nonce__gte=1&ordering=nonce/);
    assert.equal((calls[0]!.init!.headers as Record<string, string>).authorization, "Bearer k");
  });

  it("rejects a transaction whose fields do not match its claimed hash", async () => {
    const service = new TxService(SEPOLIA_CHAIN_ID, { fetch: mockFetch([{ results: [{ ...serviceTx, value: "1" }] }]) });
    await assert.rejects(service.pending(SEPOLIA.safe, 1n), /fields hash to/);
  });

  it("posts confirmations", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    await new TxService(SEPOLIA_CHAIN_ID, { fetch: mockFetch([undefined], calls) }).confirm(SEPOLIA.safeTxHash, SEPOLIA.signature);
    assert.match(calls[0]!.url, new RegExp(`/multisig-transactions/${SEPOLIA.safeTxHash}/confirmations/$`));
    assert.equal(calls[0]!.init!.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]!.init!.body as string), { signature: SEPOLIA.signature });
  });
});

const SAFE: Address = "0x1111111111111111111111111111111111111111";
const GUARD: Address = "0x2222222222222222222222222222222222222222";
const A: Address = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const B: Address = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const C: Address = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";
const OLD: Address = "0xDDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd";
const CONTEXT = { safe: SAFE, guard: GUARD, multiSendCallOnly: MAINNET.multiSendCallOnly };

describe("decodeActions", () => {
  it("describes transfers, tokens, Safe and guard calls, and expands batches", () => {
    assert.match(decodeActions({ to: A, value: 10n ** 18n, data: "0x", operation: 0 }, CONTEXT)[0]!.summary, /Send 1 ETH to 0xaAaA/);
    const token = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [B, 5n] });
    assert.equal(decodeActions({ to: C, value: 0n, data: token, operation: 0 }, CONTEXT)[0]!.kind, "token");

    const batched = batch([safeCalls.changeThreshold(SAFE, 2), guardCalls.forceRotate(GUARD, [1])]);
    const actions = decodeActions(batched, CONTEXT);
    assert.deepEqual(actions.map((a) => a.kind), ["safe-admin", "guard-admin"]);
    assert.match(actions[1]!.summary, /Rotate slot\(s\) 1/);
  });

  it("flags the escape hatch and foreign delegatecalls", () => {
    assert.equal(decodeActions(safeCalls.escape(SAFE), CONTEXT)[0]!.kind, "escape");
    assert.equal(decodeActions({ to: A, value: 0n, data: "0x", operation: 1 }, CONTEXT)[0]!.kind, "blocked");
  });
});

function slot(slotId: number, owner: Address, staged = 4): SlotState {
  return {
    slotId,
    root: `0x${"ab".repeat(32)}`,
    owner,
    size: 100,
    ownerIndex: 1,
    nextStageIndex: 2 + staged,
    staged: Array.from({ length: staged }, (_, i) => getAddress(`0x${(slotId * 100 + i + 1).toString(16).padStart(40, "e")}`)),
    unstaged: 90,
    ownerBalance: 10n ** 16n,
  };
}

function state(overrides: Partial<SafeState> = {}): SafeState {
  return {
    safe: SAFE,
    chainId: SEPOLIA_CHAIN_ID,
    owners: [A, B, C],
    threshold: 2,
    nonce: 5n,
    balance: 0n,
    guard: GUARD,
    moduleGuard: GUARD,
    installed: true,
    epoch: 1n,
    slotCount: 3,
    slots: [slot(0, A), slot(1, B), slot(2, C)],
    unmanagedOwners: [],
    bufferSize: 5,
    ...overrides,
  };
}

const ecdsa = (owner: Address): Confirmation => ({ owner, signature: `0x${"11".repeat(64)}1b`, signatureType: "EOA" });

function pending(confirmations: Confirmation[], overrides: Partial<SafeTx> = {}, hash: Hex = `0x${"aa".repeat(32)}`): PendingTx {
  return { safeTxHash: hash, tx: { ...plainSafeTx({ to: A, value: 1n, data: "0x", operation: 0, nonce: 5n }), ...overrides }, confirmations };
}

describe("evaluate", () => {
  const run = (p: PendingTx, me: Address, s = state(), queue: PendingTx[] = [p], extra = {}) =>
    evaluate({ state: s, pending: p, queue, me, decode: CONTEXT, ...extra });

  it("lets the first signer confirm and the next one execute", () => {
    assert.equal(run(pending([]), A).action, "confirm");
    const verdict = run(pending([ecdsa(A)]), B);
    assert.equal(verdict.action, "execute");
    assert.deepEqual(verdict.executeWith?.map((s) => s.owner), [A]);
  });

  it("never allows a second confirmation on a 2-of-3; the last signer must execute", () => {
    const verdict = run(pending([ecdsa(A)]), B);
    assert.equal(verdict.action, "execute");
    assert.notEqual(verdict.action, "confirm");
  });

  it("blocks a signer who already confirmed", () => {
    const verdict = run(pending([ecdsa(A)]), A);
    assert.equal(verdict.action, "none");
    assert.match(verdict.blockers.join(), /already confirmed/);
  });

  it("executes with exactly threshold - 1 confirmations and warns about extras", () => {
    const s = state({ owners: [A, B, C, OLD], threshold: 2, slots: [slot(0, A), slot(1, B), slot(2, C), slot(3, OLD)] });
    const verdict = run(pending([ecdsa(A), ecdsa(C)]), B, s);
    assert.equal(verdict.action, "execute");
    assert.equal(verdict.executeWith?.length, 1);
    assert.match(verdict.warnings.join(), /extra confirmation/);
  });

  it("ignores confirmations from owners that rotated out, and flags approveHash", () => {
    const rotated = run(pending([ecdsa(OLD)]), B);
    assert.equal(rotated.action, "confirm");
    assert.match(rotated.warnings.join(), /no longer counts/);

    const approved = run(pending([{ owner: A, signature: preValidatedSignature(A).data, signatureType: "APPROVED_HASH" }]), B);
    assert.equal(approved.action, "confirm");
    assert.match(approved.warnings.join(), /approveHash/);
  });

  it("blocks when any involved slot has no staged address", () => {
    const s = state({ slots: [slot(0, A, 0), slot(1, B), slot(2, C)] });
    assert.match(run(pending([]), A, s).blockers.join(), /you \(slot 0\) has no staged address/);
    assert.match(run(pending([ecdsa(A)]), B, s).blockers.join(), /slot 0\) has no staged address/);
  });

  it("enforces nonce order", () => {
    assert.match(run(pending([], { nonce: 6n }), A).blockers.join(), /nonce 5 must execute first/);
    assert.match(run(pending([], { nonce: 4n }), A).blockers.join(), /already used/);
  });

  it("refuses confirmations that would expose a full threshold across the queue", () => {
    const other = pending([ecdsa(C)], { nonce: 5n }, `0x${"bb".repeat(32)}`);
    const mine = pending([]);
    const verdict = run(mine, A, state(), [mine, other]);
    assert.equal(verdict.action, "none");
    assert.match(verdict.blockers.join(), /exposed but unrotated keys/);
  });

  it("blocks non-owners, foreign delegatecalls and missing gas", () => {
    assert.match(run(pending([]), OLD).blockers.join(), /not a current owner/);
    assert.match(run(pending([], { operation: 1, to: C }), A).blockers.join(), /guard would reject/);
    const verdict = run(pending([ecdsa(A)]), B, state(), undefined, { executionCost: 10n ** 17n, myBalance: 1n });
    assert.match(verdict.blockers.join(), /enough ETH for gas/);
  });

  it("warns on the escape hatch", () => {
    const escape = safeCalls.escape(SAFE);
    const verdict = run(pending([], { to: escape.to, data: escape.data }), A);
    assert.equal(verdict.action, "confirm");
    assert.match(verdict.warnings.join(), /escape hatch/);
  });
});
