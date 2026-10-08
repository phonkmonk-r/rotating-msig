import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";

import { MAINNET } from "../src/addresses.js";
import { batch, guardCalls, safeCalls } from "../src/calls.js";
import { decodeActions } from "../src/decode.js";
import { evaluate, type EvaluateInput } from "../src/rules.js";
import { plainSafeTx } from "../src/safetx.js";
import type { SafeState, SlotState } from "../src/state.js";
import type { Confirmation, PendingTx } from "../src/txservice.js";

const SAFE: Address = "0x1111111111111111111111111111111111111111";
const GUARD: Address = "0x2222222222222222222222222222222222222222";
const A = getAddress("0xaaaa000000000000000000000000000000000001");
const B = getAddress("0xbbbb000000000000000000000000000000000002");
const C = getAddress("0xcccc000000000000000000000000000000000003");
const ROTATED = getAddress("0xdddd000000000000000000000000000000000004");
const DECODE = { safe: SAFE, guard: GUARD, multiSendCallOnly: MAINNET.multiSendCallOnly };
const SIG = `0x${"11".repeat(65)}` as Hex;

function slot(slotId: number, owner: Address, staged = 3): SlotState {
  return { slotId, root: "0x00", owner, size: 100, ownerIndex: 1, nextStageIndex: 2 + staged, staged: Array(staged).fill(owner), unstaged: 50, ownerBalance: 10n ** 16n };
}

function state(overrides: Partial<SafeState> = {}): SafeState {
  return {
    safe: SAFE,
    chainId: 1,
    owners: [A, B, C],
    threshold: 2,
    nonce: 5n,
    balance: 0n,
    guard: GUARD,
    moduleGuard: GUARD,
    installed: true,
    epoch: 1n,
    slots: [slot(0, A), slot(1, B), slot(2, C)],
    unmanagedOwners: [],
    bufferSize: 5,
    ...overrides,
  };
}

function pending(confirmations: Confirmation[] = [], overrides: Partial<PendingTx["tx"]> = {}, hash: Hex = "0x01"): PendingTx {
  return { safeTxHash: hash, tx: { ...plainSafeTx({ to: B, value: 10n ** 15n, data: "0x", operation: 0, nonce: 5n }), ...overrides }, confirmations };
}

const confirmation = (owner: Address, signatureType: Confirmation["signatureType"] = "EOA"): Confirmation => ({ owner, signature: SIG, signatureType });

function run(overrides: Partial<EvaluateInput> & { pending?: PendingTx } = {}) {
  const tx = overrides.pending ?? pending();
  return evaluate({ state: state(), pending: tx, queue: [tx], me: A, decode: DECODE, ...overrides });
}

describe("rules", () => {
  it("lets the first signer confirm and the last signer execute", () => {
    assert.equal(run().action, "confirm");
    const verdict = run({ pending: pending([confirmation(B)]) });
    assert.equal(verdict.action, "execute");
    assert.deepEqual(verdict.executeWith, [{ owner: B, data: SIG }]);
    assert.match(verdict.actions[0]!.summary, /^Send 0.001 ETH to 0xbbbb/i);
  });

  it("never lets the same signer confirm and execute", () => {
    const verdict = run({ pending: pending([confirmation(A)]) });
    assert.equal(verdict.action, "none");
    assert.match(verdict.blockers.join(), /different signer must execute/);
  });

  it("executes with exactly threshold - 1 confirmations and warns about extras", () => {
    const verdict = run({ state: state({ threshold: 2 }), me: C, pending: pending([confirmation(A), confirmation(B)]) });
    assert.equal(verdict.action, "execute");
    assert.equal(verdict.executeWith!.length, 1);
    assert.match(verdict.warnings.join(), /1 extra confirmation/);
  });

  it("enforces nonce order", () => {
    assert.match(run({ pending: pending([], { nonce: 6n }) }).blockers.join(), /nonce 5 must execute first/);
    assert.match(run({ pending: pending([], { nonce: 4n }) }).blockers.join(), /already used/);
  });

  it("blocks when a needed slot has no staged address", () => {
    assert.match(run({ state: state({ slots: [slot(0, A, 0), slot(1, B), slot(2, C)] }) }).blockers.join(), /you \(slot 0\) has no staged address/);
    const verdict = run({ state: state({ slots: [slot(0, A), slot(1, B, 0), slot(2, C)] }), pending: pending([confirmation(B)]) });
    assert.equal(verdict.action, "none");
    assert.match(verdict.blockers.join(), /slot 1\) has no staged address/);
  });

  it("refuses a confirmation that would expose a full threshold across the queue", () => {
    const other = pending([confirmation(B)], { nonce: 6n }, "0x02");
    const mine = pending([], {}, "0x01");
    const verdict = evaluate({ state: state(), pending: mine, queue: [mine, other], me: A, decode: DECODE });
    assert.equal(verdict.action, "none");
    assert.match(verdict.blockers.join(), /2 owners with exposed but unrotated keys/);
  });

  it("ignores confirmations from rotated-out owners and on-chain approvals", () => {
    const verdict = run({ pending: pending([confirmation(ROTATED), confirmation(B, "APPROVED_HASH")]) });
    assert.equal(verdict.action, "confirm");
    assert.equal(verdict.validConfirmations.length, 0);
    assert.match(verdict.warnings.join("\n"), /confirmed before rotating out/);
    assert.match(verdict.warnings.join("\n"), /approveHash/);
  });

  it("blocks non-owners, missing guard and insufficient gas", () => {
    assert.match(run({ me: ROTATED }).blockers.join(), /not a current owner/);
    assert.match(run({ state: state({ installed: false }) }).blockers.join(), /not installed/);
    const poor = run({ pending: pending([confirmation(B)]), executionCost: 100n, myBalance: 99n });
    assert.equal(poor.action, "none");
    assert.match(poor.blockers.join(), /enough ETH for gas/);
  });

  it("flags delegatecalls the guard rejects and the escape hatch", () => {
    assert.match(run({ pending: pending([], { to: GUARD, data: "0x1234", operation: 1 }) }).blockers.join(), /guard would reject/);
    const escape = safeCalls.escape(SAFE);
    const verdict = run({ pending: pending([], { to: escape.to, data: escape.data, value: 0n }) });
    assert.equal(verdict.action, "confirm");
    assert.match(verdict.warnings.join(), /escape hatch/);
  });
});

describe("decodeActions", () => {
  it("expands MultiSend batches and names guard and Safe calls", () => {
    const tx = batch([guardCalls.forceRotate(GUARD, [2]), safeCalls.changeThreshold(SAFE, 3), { to: B, value: 5n * 10n ** 17n, data: "0x", operation: 0 }]);
    const actions = decodeActions(tx, DECODE);
    assert.deepEqual(actions.map((a) => a.kind), ["guard-admin", "safe-admin", "transfer"]);
    assert.match(actions[0]!.summary, /forceRotate\(\[2\]\)/);
    assert.match(actions[1]!.summary, /changeThreshold\(3\)/);
    assert.match(actions[2]!.summary, /Send 0.5 ETH/);
  });

  it("summarises staging compactly and decodes ERC-20 transfers", () => {
    const stage = guardCalls.stage(GUARD, SAFE, 1, [{ index: 6, owner: A, proof: [] }]);
    assert.match(decodeActions(stage, DECODE)[0]!.summary, /stage\(0x1111…1111, 1, 1 entries\)/i);
    const token = { to: C, value: 0n, data: "0xa9059cbb000000000000000000000000aaaa0000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000064" as Hex, operation: 0 as const };
    assert.match(decodeActions(token, DECODE)[0]!.summary, /Transfer 100 units of token 0xcccc…0003 to 0xaaaa…0001/i);
  });
});
