import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, hashMessage, hexToSignature, recoverMessageAddress, keccak256, concatHex, parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";

import { plainSafeTx, safeTxTypedData } from "@rotating-msig/core";

import { ledgerSource, type LedgerEth } from "../src/ledger.js";
import { seedSource } from "../src/seed.js";
import { derivationPath } from "../src/source.js";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const SAFE = "0x7aC0Ac669d32Bd739eAA892bcFD2C6dF9946Ed02";
const TX = plainSafeTx({ to: "0xBDD48ac62B4cc6C347175751588fE5CAf927bbF9", value: 100000000000000n, data: "0x", operation: 0, nonce: 1n });

/** A fake Ledger that signs whatever hashes it receives with one known key, like the device would. */
function fakeLedger(privateKey: Hex, calls: string[] = []): LedgerEth {
  const owner = privateKeyToAccount(privateKey);
  return {
    async getAddress(path, display) {
      calls.push(`getAddress ${path} ${display}`);
      return { address: owner.address.toLowerCase(), publicKey: "04deadbeef" };
    },
    async signEIP712HashedMessage(path, domainHex, messageHex) {
      calls.push(`signEIP712 ${path}`);
      const digest = keccak256(concatHex(["0x1901", `0x${domainHex}`, `0x${messageHex}`]));
      const { r, s, v } = await sign({ hash: digest, privateKey });
      return { r: r.slice(2), s: s.slice(2), v: Number(v) };
    },
    async signTransaction(path, rawTxHex) {
      calls.push(`signTransaction ${path}`);
      const { r, s, v } = await sign({ hash: keccak256(`0x${rawTxHex}`), privateKey });
      return { r: r.slice(2), s: s.slice(2), v: Number(v).toString(16) };
    },
    async signPersonalMessage(path, messageHex) {
      calls.push(`signPersonalMessage ${path}`);
      const { r, s, v } = await sign({ hash: hashMessage({ raw: `0x${messageHex}` }), privateKey });
      return { r: r.slice(2), s: s.slice(2), v: Number(v) };
    },
  };
}

describe("seed source", () => {
  it("derives the well-known first account of the test mnemonic", async () => {
    const source = seedSource(TEST_MNEMONIC);
    assert.equal(await source.address(0), "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    await source.close();
  });

  it("derives a distinct address per hardened account", async () => {
    const source = seedSource(TEST_MNEMONIC);
    const seen = new Set<string>();
    for (let account = 1000; account < 1050; account++) seen.add(await source.address(account));
    assert.equal(seen.size, 50);
    await source.close();
  });

  it("normalizes whitespace and applies the passphrase", async () => {
    const plain = seedSource(`  ${TEST_MNEMONIC.split(" ").join("\n  ")}  `);
    const withPassphrase = seedSource(TEST_MNEMONIC, "extra");
    assert.equal(await plain.address(0), "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    assert.notEqual(await withPassphrase.address(0), "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("rejects an invalid mnemonic and refuses to work after close", async () => {
    assert.throws(() => seedSource("test test test test test test test test test test test test"), /invalid BIP-39 mnemonic/);
    const source = seedSource(TEST_MNEMONIC);
    await source.close();
    await assert.rejects(source.address(0), /closed/);
  });

  it("signs a SafeTx as the owner at an account index", async () => {
    const source = seedSource(TEST_MNEMONIC);
    const signer = await source.signer(100000);
    assert.equal(signer.address, await source.address(100000));
    const typed = safeTxTypedData(11155111, SAFE, TX);
    const signature = await signer.signTypedData(typed);
    assert.equal(await recoverTypedDataAddress({ ...typed, signature }), signer.address);
  });
});

describe("ledger source", () => {
  const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

  it("requests the hardened account path without display and drops the public key", async () => {
    const calls: string[] = [];
    const source = ledgerSource(fakeLedger(KEY, calls), async () => {});
    assert.equal(await source.address(1234), privateKeyToAccount(KEY).address);
    assert.deepEqual(calls, ["getAddress 44'/60'/1234'/0/0 false"]);
    assert.equal(derivationPath(1234), "m/44'/60'/1234'/0/0");
  });

  it("produces the same EIP-712 signature as a local key, so its domain and message hashing are right", async () => {
    const calls: string[] = [];
    const ledger = await ledgerSource(fakeLedger(KEY, calls), async () => {}).signer(7);
    const local = privateKeyToAccount(KEY);
    const typed = safeTxTypedData(11155111, SAFE, TX);
    const viaLedger = await ledger.signTypedData(typed);
    assert.equal(viaLedger, await local.signTypedData(typed));
    assert.equal(hexToSignature(viaLedger).v, 27n + BigInt(hexToSignature(viaLedger).yParity ?? 0));
    assert.ok(calls.includes("signEIP712 44'/60'/7'/0/0"));
  });

  it("signs transactions on the device", async () => {
    const ledger = await ledgerSource(fakeLedger(KEY), async () => {}).signer(7);
    const signed = await ledger.signTransaction({ chainId: 11155111, type: "eip1559", to: getAddress(SAFE), value: 0n, nonce: 3, gas: 500000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, data: "0x" });
    assert.equal(await recoverTransactionAddress({ serializedTransaction: signed as never }), ledger.address);
    assert.equal(parseTransaction(signed).nonce, 3);
  });

  it("refuses to sign messages with owner keys, and signs them only with the operator account", async () => {
    const source = ledgerSource(fakeLedger(KEY), async () => {});
    for (const owner of [await source.signer(7), await source.signer(5, 3, 9)]) {
      await assert.rejects(owner.signMessage({ message: "hello" }), /only sign Safe transactions/);
    }
    const operator = await source.signer(0);
    const signature = await operator.signMessage({ message: "Cicada slot package" });
    assert.equal(await recoverMessageAddress({ message: "Cicada slot package", signature }), operator.address);
  });
});
