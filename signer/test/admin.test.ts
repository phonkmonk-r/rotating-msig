import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseEther } from "viem";
import { foundry } from "viem/chains";

import { encodePackage, readSafeState, TxService, type ProposalInput } from "@rotating-msig/core";
import { seedSource } from "@rotating-msig/keys";

import { joinSafe } from "../src/join.js";
import { prepareNewSlot } from "../src/newsafe.js";
import { SignerSession } from "../src/session.js";
import { hasAnvil, hasArtifacts, SIGNER_SEEDS, startChain, startFakeTxService, type Chain, type FakeTxService } from "./fixture.js";

const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;
const NEWCOMER = "test test test test test test test test test test test junk";

describe("managing signers from the app", { skip }, () => {
  let chain: Chain;
  let service: FakeTxService;
  let sessions: SignerSession[];

  before(async () => {
    chain = await startChain(8556);
    service = await startFakeTxService(chain.safe, foundry.id);
    sessions = SIGNER_SEEDS.map(
      (seed, slot) =>
        new SignerSession({
          publicClient: chain.client,
          chain: foundry,
          executionRpcUrl: chain.rpc,
          txService: new TxService(foundry.id, { baseUrl: service.baseUrl }),
          source: seedSource(seed),
          tree: chain.trees[slot]!,
          safe: chain.safe,
          multiSendCallOnly: chain.multiSend,
        }),
    );
  });
  after(async () => {
    await service?.stop();
    chain?.stop();
  });

  const state = () => readSafeState(chain.client, chain.safe);
  async function run(input: ProposalInput) {
    const proposal = await sessions[0]!.propose(input);
    const sent = await sessions[1]!.execute(proposal.safeTxHash);
    const receipt = await chain.client.waitForTransactionReceipt({ hash: sent.transactionHash });
    assert.equal(receipt.status, "success");
    return proposal;
  }

  it("adds a newcomer from their package, with their next keys staged, and they can join", async () => {
    const context = { client: chain.client, chain: foundry };
    const prepared = await prepareNewSlot(context, seedSource(NEWCOMER), chain.safe, undefined, 12);
    assert.equal(prepared.package.slotId, 3);
    const proposal = await run({ kind: "add-signer", package: encodePackage(prepared.package), threshold: 2 });
    assert.match(proposal.actions[0]!.summary, /Add a signer whose first key is/);

    const after = await state();
    assert.equal(after.owners.length, 4);
    const added = after.slots.find((slot) => slot.slotId === 3)!;
    assert.equal(added.owner, prepared.package.config.owner);
    assert.equal(added.staged.length, 5);
    const joined = await joinSafe({ source: seedSource(NEWCOMER), safe: chain.safe, chainId: foundry.id, client: chain.client });
    assert.equal(joined.slotId, 3);

    await assert.rejects(sessions[0]!.propose({ kind: "add-signer", package: encodePackage(prepared.package), threshold: 2 }, true), /package for slot 3|is for slot 3/);
  });

  it("removes a signer and changes the threshold", async () => {
    await run({ kind: "remove-signer", slotId: 3, threshold: 2 });
    let after = await state();
    assert.equal(after.owners.length, 3);
    assert.ok(!after.slots.some((slot) => slot.slotId === 3));

    const proposal = await run({ kind: "threshold", threshold: 3 });
    assert.match(proposal.actions[0]!.summary, /Require 3 signature/);
    after = await state();
    assert.equal(after.threshold, 3);
  });

  it("refuses impossible changes before anything is signed", async () => {
    await assert.rejects(sessions[0]!.propose({ kind: "threshold", threshold: 4 }, true), /between 1 and 3/);
    await assert.rejects(sessions[0]!.propose({ kind: "threshold", threshold: 3 }, true), /already requires 3/);
    await assert.rejects(sessions[0]!.propose({ kind: "remove-signer", slotId: 7, threshold: 2 }, true), /slot 7 has no signer/);
    const escape = await sessions[0]!.propose({ kind: "escape" }, true);
    assert.match(escape.actions[0]!.summary, /Escape hatch/);
    assert.ok(escape.warnings.some((warning) => /burned/.test(warning)));
    void parseEther;
  });
});
