import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ledgerSource } from "../src/sources/ledger.js";
import { seedSource } from "../src/sources/seed.js";
import { derivationPath } from "../src/sources/source.js";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";

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

  it("rejects an invalid mnemonic", () => {
    assert.throws(() => seedSource("test test test test test test test test test test test test"), /invalid BIP-39 mnemonic/);
  });

  it("refuses to derive after close", async () => {
    const source = seedSource(TEST_MNEMONIC);
    await source.close();
    await assert.rejects(source.address(0), /closed/);
  });
});

describe("ledger source", () => {
  it("requests the hardened account path without display and drops the public key", async () => {
    const calls: Array<[string, boolean | undefined]> = [];
    const source = ledgerSource(
      {
        async getAddress(path, display) {
          calls.push([path, display]);
          return { address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", publicKey: "04deadbeef" };
        },
      },
      async () => {},
    );
    const address = await source.address(1234);
    assert.deepEqual(calls, [["44'/60'/1234'/0/0", false]]);
    assert.equal(address, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    assert.equal(derivationPath(1234), "m/44'/60'/1234'/0/0");
  });
});
