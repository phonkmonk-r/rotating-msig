import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { recoverAddress, type Hex } from "viem";

import { SEPOLIA_CHAIN_ID } from "../src/addresses.js";
import { packSignatures, preValidatedSignature, safeTxHash } from "../src/safetx.js";
import { TxService, txServiceUrl } from "../src/txservice.js";

const SAFE = "0x7aC0Ac669d32Bd739eAA892bcFD2C6dF9946Ed02";
const FIXTURE = readFileSync(new URL("./fixtures/sepolia-multisig-transactions.json", import.meta.url), "utf8");

function fakeFetch(body: string, status = 200, calls: { url: string; init?: RequestInit }[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  }) as typeof fetch;
}

describe("Transaction Service client, against real Sepolia data", () => {
  it("parses transactions and recomputes the hashes Safe{Wallet} signed", async () => {
    const calls: { url: string }[] = [];
    const service = new TxService(SEPOLIA_CHAIN_ID, { fetch: fakeFetch(FIXTURE, 200, calls) });
    const txs = await service.pending(SAFE, 0n);
    assert.equal(txs.length, 2);
    assert.match(calls[0]!.url, /^https:\/\/api\.safe\.global\/tx-service\/sep\/api\/v1\/safes\/0x7aC0Ac669d32Bd739eAA892bcFD2C6dF9946Ed02\/multisig-transactions\/\?executed=false&nonce__gte=0/);

    const transfer = txs.find((t) => t.tx.nonce === 1n)!;
    assert.equal(transfer.safeTxHash, "0x4a4faf6109fac5a9d0be90f5062ff027301af82a969905f3a9e9fa5d43a5fee4");
    assert.equal(transfer.tx.value, 100000000000000n);
    assert.deepEqual(transfer.confirmations.map((c) => c.signatureType), ["EOA", "APPROVED_HASH"]);
  });

  it("recovers the real confirming owner from its signature over the locally computed hash", async () => {
    const service = new TxService(SEPOLIA_CHAIN_ID, { fetch: fakeFetch(FIXTURE) });
    const transfer = (await service.pending(SAFE, 0n)).find((t) => t.tx.nonce === 1n)!;
    const eoa = transfer.confirmations.find((c) => c.signatureType === "EOA")!;
    const recovered = await recoverAddress({ hash: safeTxHash(SEPOLIA_CHAIN_ID, SAFE, transfer.tx), signature: eoa.signature });
    assert.equal(recovered, eoa.owner);
  });

  it("rejects a transaction whose fields do not match its hash", async () => {
    const tampered = FIXTURE.replace('"value": "100000000000000"', '"value": "100000000000001"');
    const service = new TxService(SEPOLIA_CHAIN_ID, { fetch: fakeFetch(tampered) });
    await assert.rejects(service.pending(SAFE, 0n), /but its fields hash to/);
  });

  it("fetches pending transactions once for concurrent callers and reuses them briefly, unless asked fresh", async () => {
    const calls: { url: string }[] = [];
    const service = new TxService(SEPOLIA_CHAIN_ID, { fetch: fakeFetch(FIXTURE, 200, calls) });
    const [a, b] = await Promise.all([service.pending(SAFE, 0n), service.pending(SAFE, 0n)]);
    assert.equal(a, b);
    await service.pending(SAFE, 0n);
    assert.equal(calls.length, 1, "one request for three reads");
    await service.pending(SAFE, 1n);
    assert.equal(calls.length, 2, "another nonce is another list");
    await service.pending(SAFE, 0n, { fresh: true });
    assert.equal(calls.length, 3, "actions read fresh");
  });

  it("forgets cached pending transactions after its own confirmation", async () => {
    const calls: { url: string }[] = [];
    const service = new TxService(SEPOLIA_CHAIN_ID, { fetch: fakeFetch(FIXTURE, 200, calls) });
    await service.pending(SAFE, 0n);
    await service.confirm("0xabc", "0xdef");
    await service.pending(SAFE, 0n);
    assert.equal(calls.filter((call) => call.url.includes("multisig-transactions/?")).length, 2);
  });

  it("retries a rate-limited request, honoring Retry-After, and gives up after a few attempts", async () => {
    let attempts = 0;
    const flaky = (async () => {
      attempts++;
      return attempts < 3 ? new Response('{"error_msg":"Too many requests per second"}', { status: 429, headers: { "retry-after": "0.01" } }) : new Response(FIXTURE, { status: 200 });
    }) as unknown as typeof fetch;
    const txs = await new TxService(SEPOLIA_CHAIN_ID, { fetch: flaky }).pending(SAFE, 0n);
    assert.equal(txs.length, 2);
    assert.equal(attempts, 3);

    const calls: { url: string }[] = [];
    const limited = new TxService(SEPOLIA_CHAIN_ID, { fetch: fakeFetch("{}", 429, calls) });
    await assert.rejects(limited.pending(SAFE, 0n), /Transaction Service 429/);
    assert.equal(calls.length, 4);
    await assert.rejects(limited.pending(SAFE, 0n), /Transaction Service 429/);
    assert.equal(calls.length, 8, "a failed read is not cached");
  });

  it("posts confirmations and surfaces service errors", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const service = new TxService(SEPOLIA_CHAIN_ID, { fetch: fakeFetch("", 201, calls), apiKey: "k" });
    await service.confirm("0xabc", "0xdef");
    assert.equal(calls[0]!.url, `${txServiceUrl(SEPOLIA_CHAIN_ID)}/api/v1/multisig-transactions/0xabc/confirmations/`);
    assert.equal(calls[0]!.init?.method, "POST");
    assert.equal(calls[0]!.init?.body, JSON.stringify({ signature: "0xdef" }));
    assert.equal((calls[0]!.init?.headers as Record<string, string>).authorization, "Bearer k");

    const failing = new TxService(SEPOLIA_CHAIN_ID, { fetch: fakeFetch('{"detail":"nope"}', 422) });
    await assert.rejects(failing.confirm("0xabc", "0xdef"), /Transaction Service 422/);
    assert.throws(() => txServiceUrl(10), /no Safe Transaction Service/);
  });

  it("packs signatures sorted by owner, matching what Safe{Wallet} submitted on-chain", async () => {
    const service = new TxService(SEPOLIA_CHAIN_ID, { fetch: fakeFetch(FIXTURE) });
    const transfer = (await service.pending(SAFE, 0n)).find((t) => t.tx.nonce === 1n)!;
    const eoa = transfer.confirmations.find((c) => c.signatureType === "EOA")!;
    const executor = transfer.confirmations.find((c) => c.signatureType === "APPROVED_HASH")!.owner;
    const packed = packSignatures([{ owner: eoa.owner, data: eoa.signature }, preValidatedSignature(executor)]);
    const expectedFirst = BigInt(executor) < BigInt(eoa.owner) ? preValidatedSignature(executor).data : eoa.signature;
    assert.equal(packed.slice(0, 132), (expectedFirst as Hex).slice(0, 132));
    assert.equal((packed.length - 2) / 2, 130);
  });
});
