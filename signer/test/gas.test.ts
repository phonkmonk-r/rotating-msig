import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { numberToHex, parseEther, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";

import { readSafeState, TxService } from "@rotating-msig/core";
import { OPERATOR_ACCOUNT, seedSource } from "@rotating-msig/keys";

import { SignerSession, type Execution } from "../src/session.js";
import { hasAnvil, hasArtifacts, SIGNER_SEEDS, startChain, startFakeTxService, type Chain, type FakeTxService } from "./fixture.js";

const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;
const RECIPIENT: Address = "0x000000000000000000000000000000000000dEaD";

describe("paying executions from the gas account", { skip }, () => {
  let chain: Chain;
  let service: FakeTxService;
  let sessions: SignerSession[];
  let operator: Address;

  before(async () => {
    chain = await startChain(8554);
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
          gasFunding: true,
        }),
    );
    operator = await seedSource(SIGNER_SEEDS[1]!).address(OPERATOR_ACCOUNT);
  });
  after(async () => {
    await service?.stop();
    chain?.stop();
  });

  const setBalance = (address: Address, wei: bigint) => chain.client.request({ method: "anvil_setBalance" as never, params: [address, numberToHex(wei)] as never });
  const balance = (address: Address) => chain.client.getBalance({ address });

  async function settled(session: SignerSession, hash: Hex): Promise<Execution> {
    for (let i = 0; i < 100; i++) {
      const record = await session.execution(hash);
      if (record.sweep?.status !== "waiting" && record.status !== "pending") return record;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("the sweep did not finish");
  }

  it("refuses to execute when the gas account cannot pay, and sends nothing", async () => {
    const proposal = await sessions[0]!.propose({ kind: "eth", to: RECIPIENT, amount: parseEther("0.01").toString() });
    const state = await readSafeState(chain.client, chain.safe);
    const key = state.slots[1]!.owner;
    await setBalance(key, 0n);
    await setBalance(operator, 0n);
    await assert.rejects(sessions[1]!.execute(proposal.safeTxHash), /gas account .* needs about .* ETH/);
    assert.equal((await readSafeState(chain.client, chain.safe)).nonce, state.nonce);
    assert.equal(await balance(key), 0n);
  });

  it("funds the empty key just in time, executes, and sweeps the rest back to zero", async () => {
    const [proposal] = await sessions[1]!.queue();
    const before = await readSafeState(chain.client, chain.safe);
    const key = before.slots[1]!.owner;
    await setBalance(operator, parseEther("1"));

    const status = await sessions[1]!.status();
    assert.equal(status.gasFunding, true);
    assert.equal(status.me!.operator!.address, operator);
    assert.ok(!status.findings.some((finding) => /gas/i.test(finding.message)), "an empty rotation key is normal");

    const sent = await sessions[1]!.execute(proposal!.safeTxHash);
    assert.ok(sent.funding, "the key was topped up");
    const record = await settled(sessions[1]!, sent.transactionHash);
    assert.equal(record.status, "success");
    assert.equal(record.sweep!.status, "sent");
    await chain.client.waitForTransactionReceipt({ hash: record.sweep!.transactionHash! });

    assert.equal(await balance(key), 0n, "nothing is left on the retired key");
    const after = await readSafeState(chain.client, chain.safe);
    assert.notEqual(after.slots[1]!.owner, key, "the executor rotated");
    assert.ok((await balance(operator)) > parseEther("0.99"), "the gas account only paid the gas");
  });

  it("does not top up a key that already holds enough, and still sweeps it", async () => {
    const proposal = await sessions[0]!.propose({ kind: "eth", to: RECIPIENT, amount: parseEther("0.01").toString() });
    const key = (await readSafeState(chain.client, chain.safe)).slots[2]!.owner;
    await setBalance(key, parseEther("0.05"));
    const sent = await sessions[2]!.execute(proposal.safeTxHash);
    assert.equal(sent.funding, undefined);
    const record = await settled(sessions[2]!, sent.transactionHash);
    assert.equal(record.sweep!.status, "sent");
    await chain.client.waitForTransactionReceipt({ hash: record.sweep!.transactionHash! });
    assert.equal(await balance(key), 0n);
  });
});
