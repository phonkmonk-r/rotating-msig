import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseEther, type Address } from "viem";
import { foundry } from "viem/chains";

import { BRANCH_PATH_TEMPLATE, readSafeState, safeKeyPath, TxService, type TreeFile } from "@rotating-msig/core";
import { seedSource } from "@rotating-msig/keys";

import { joinSafe } from "../src/join.js";
import { SignerSession } from "../src/session.js";
import { hasAnvil, hasArtifacts, SIGNER_SEEDS, startChain, startFakeTxService, type Chain, type FakeTxService } from "./fixture.js";

const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;
const RECIPIENT: Address = "0x000000000000000000000000000000000000dEaD";

describe("renewing a slot's key list", { skip }, () => {
  let chain: Chain;
  let service: FakeTxService;
  let sessions: SignerSession[];
  const saved: TreeFile[] = [];

  before(async () => {
    chain = await startChain(8559);
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
          onTreeChange: slot === 0 ? (tree) => saved.push(tree) : undefined,
        }),
    );
  });
  after(async () => {
    await service?.stop();
    chain?.stop();
  });

  const slot0 = async () => (await readSafeState(chain.client, chain.safe)).slots[0]!;

  it("proposes a new list and its first keys in one transaction; after execution the slot lives on it", async () => {
    const before = await slot0();
    const { input, tree } = await sessions[0]!.renewKeys(undefined, 12);
    const path = safeKeyPath(foundry.id, chain.safe, 0);
    assert.deepEqual([tree.pathTemplate, tree.base, tree.branch], [BRANCH_PATH_TEMPLATE, path.account, path.branch], "moves from the ranged layout to generation 0");

    const proposal = await sessions[0]!.propose(input);
    assert.match(proposal.actions.map((action) => action.summary).join(" | "), /Give slot 0 a new key list of 12 keys, starting at key 0.*Stage 5 next key/);
    const sent = await sessions[1]!.execute(proposal.safeTxHash);
    assert.equal((await chain.client.waitForTransactionReceipt({ hash: sent.transactionHash! })).status, "success");

    const after = await slot0();
    assert.equal(after.root, tree.root);
    assert.notEqual(after.root, before.root);
    assert.equal(after.owner, tree.addresses[0], "slot 0 rotated straight onto the new list");
    assert.equal(after.staged.length, 4);
  });

  it("switches to the new list by itself and keeps signing", async () => {
    const status = await sessions[0]!.status();
    assert.equal(status.me?.index, 0);
    assert.equal(saved.length, 1, "the new list is handed over to be saved");

    const proposal = await sessions[0]!.propose({ kind: "eth", to: RECIPIENT, amount: parseEther("0.001").toString() });
    const sent = await sessions[2]!.execute(proposal.safeTxHash);
    assert.equal((await chain.client.waitForTransactionReceipt({ hash: sent.transactionHash! })).status, "success");
    assert.equal((await slot0()).owner, saved[0]!.addresses[1]);
  });

  it("is found again from the seed alone", async () => {
    const joined = await joinSafe({ source: seedSource(SIGNER_SEEDS[0]!), safe: chain.safe, chainId: foundry.id, client: chain.client });
    assert.equal(joined.slotId, 0);
    assert.equal(joined.tree.root, saved[0]!.root);
  });

  it("refuses a renewal that is not proven or is the current list", async () => {
    const { input } = await sessions[0]!.renewKeys(undefined, 12);
    assert.equal(input.kind, "renew-keys");
    if (input.kind !== "renew-keys") return;
    const tampered = { ...input, stage: input.stage.map((entry, i) => (i === 0 ? { ...entry, owner: RECIPIENT } : entry)) };
    await assert.rejects(sessions[0]!.propose(tampered, true), /not in the new key list/);
    await assert.rejects(sessions[0]!.propose({ ...input, root: (await slot0()).root }, true), /current key list/);
  });
});
