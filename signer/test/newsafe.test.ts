import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createWalletClient, http, numberToHex, parseEther, type Address } from "viem";
import { foundry } from "viem/chains";

import { packageMessage, verifySignedPackages, safeKeyPath, decodeInvite, decodePackage, encodeInvite, encodePackage, readSafeState, verifyPackages, type SafeDeployments, type SlotPackage } from "@rotating-msig/core";
import { seedSource } from "@rotating-msig/keys";

import { joinSafe } from "../src/join.js";
import { KeyChecker } from "../src/keycheck.js";
import { createSafe, planSafe, prepareSlot, readInvite, type NewSafeContext } from "../src/newsafe.js";
import { hasAnvil, hasArtifacts, SIGNER_SEEDS, startChain, type Chain } from "./fixture.js";

const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;
const OUTSIDER = "test test test test test test test test test test test junk";
const ZERO = "0x0000000000000000000000000000000000000000" as const;

describe("creating a new Safe from the app", { skip }, () => {
  let chain: Chain;
  let context: NewSafeContext;
  let operators: Address[];
  const sources = SIGNER_SEEDS.map((seed) => seedSource(seed));

  before(async () => {
    chain = await startChain(8553);
    const deployments: SafeDeployments = {
      safeSingleton: chain.singleton,
      safeProxyFactory: chain.factory,
      multiSendCallOnly: chain.multiSend,
      creationSingleton: chain.singleton,
      fallbackHandler: ZERO,
      rotationGuard: chain.guard,
    };
    context = { client: chain.client, chain: foundry, deployments, keyChecker: new KeyChecker([chain.client]) };
    operators = await Promise.all(sources.map((source) => source.address(0)));
  });
  after(() => chain?.stop());

  it("plans, prepares every slot, creates and installs; signers then join their slots", async () => {
    const invite = decodeInvite(encodeInvite(await planSafe(context, operators, 2)));
    assert.equal(await chain.client.getCode({ address: invite.safe }), undefined, "nothing is deployed while planning");

    const packages: SlotPackage[] = [];
    for (const [slot, source] of sources.entries()) {
      assert.equal((await readInvite(context, source, invite)).slotId, slot);
      const prepared = await prepareSlot(context, source, invite, undefined, 12);
      packages.push(decodePackage(encodePackage(prepared.package)));
    }
    assert.deepEqual(verifyPackages(invite, packages), []);

    await chain.client.request({ method: "anvil_setBalance" as never, params: [operators[0]!, numberToHex(parseEther("1"))] as never });
    const stages: string[] = [];
    const created = await createSafe(context, sources[0]!, invite, packages, (stage) => stages.push(stage));
    assert.deepEqual(stages, ["deploying", "installing", "done"]);

    const state = await readSafeState(chain.client, invite.safe);
    assert.equal(state.installed, true);
    assert.equal(state.threshold, 2);
    assert.deepEqual(state.slots.map((slot) => slot.owner), packages.map((pkg) => pkg.config.owner));
    assert.ok(state.slots.every((slot) => slot.staged.length === 5));
    assert.ok(created.installTx);

    const joined = await joinSafe({ source: sources[1]!, safe: invite.safe, chainId: foundry.id, client: chain.client });
    assert.equal(joined.slotId, 1);
    assert.equal(joined.tree.root, packages[1]!.config.root);
  });

  it("starts a slot past keys that were already used elsewhere", async () => {
    const invite = await planSafe(context, operators, 2);
    const keyPath = safeKeyPath(foundry.id, invite.safe);
    const usedKey = await sources[2]!.signer(keyPath.account, 1, keyPath.branch);
    await chain.client.request({ method: "anvil_setBalance" as never, params: [usedKey.address, numberToHex(parseEther("1"))] as never });
    const wallet = createWalletClient({ account: usedKey, chain: foundry, transport: http(chain.rpc) });
    await chain.client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: usedKey.address, value: 0n }) });

    const prepared = await prepareSlot(context, sources[2]!, invite, undefined, 12);
    assert.equal(prepared.package.config.startIndex, 2, "keys 0 and 1 are skipped: 1 sent a transaction");
    assert.deepEqual(prepared.package.stage.map((entry) => entry.index), [3, 4, 5, 6, 7]);
    const others = await Promise.all(sources.slice(0, 2).map(async (source) => (await prepareSlot(context, source, invite, undefined, 12)).package));
    assert.deepEqual(verifyPackages(invite, [...others, prepared.package]), []);
  });

  it("rejects an invite whose signers were changed, and outsiders", async () => {
    const invite = await planSafe(context, operators, 2);
    const reordered = { ...invite, owners: [invite.owners[1]!, invite.owners[0]!, invite.owners[2]!] };
    await assert.rejects(readInvite(context, sources[0]!, reordered), /give 0x/);
    await assert.rejects(readInvite(context, seedSource(OUTSIDER), invite), /not one of this Safe's signers/);
    await assert.rejects(planSafe(context, [operators[0]!, operators[0]!], 1), /listed twice/);
    await assert.rejects(planSafe(context, operators, 4), /threshold/);
  });

  it("rejects packages that are forged, swapped or for another Safe", async () => {
    const invite = await planSafe(context, operators, 2);
    const packages = await Promise.all(sources.map(async (source) => (await prepareSlot(context, source, invite, undefined, 12)).package));
    const forged = structuredClone(packages);
    forged[2]!.stage[0]!.owner = operators[0]!;
    assert.match(verifyPackages(invite, forged).join(), /slot 2: key 1 is not in the slot's tree/);
    assert.match(verifyPackages(invite, [packages[1]!, packages[0]!, packages[2]!]).join(), /slot 0: the package is for slot 1/);
    const other = await planSafe(context, operators, 2);
    assert.match(verifyPackages(other, packages).join(), /another Safe/);
    await assert.rejects(createSafe(context, sources[0]!, invite, packages.slice(0, 2)), /2 of 3 slot packages/);

    // Signatures: every package is signed by the operator the invite lists for its slot.
    assert.deepEqual(await verifySignedPackages(invite, packages), []);
    const outsider = await seedSource(OUTSIDER).signer(0);
    const impostor = { ...packages[2]!, operator: outsider.address };
    impostor.signature = await outsider.signMessage({ message: packageMessage(impostor) });
    assert.match((await verifySignedPackages(invite, [packages[0]!, packages[1]!, impostor])).join(), /slot 2: the package is from 0x/, "a re-signed package names the wrong signer");
    const reSigned = { ...packages[2]!, signature: await outsider.signMessage({ message: packageMessage(packages[2]!) }) };
    assert.match((await verifySignedPackages(invite, [packages[0]!, packages[1]!, reSigned])).join(), /slot 2: the package is not signed by/);
    const unsigned = { ...packages[2]!, signature: undefined };
    await assert.rejects(createSafe(context, sources[0]!, invite, [packages[0]!, packages[1]!, unsigned]), /not signed by/);
  });
});
