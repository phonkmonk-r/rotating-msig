import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getAddress } from "viem";

import { createTreeFile, SEPOLIA_CHAIN_ID } from "@rotating-msig/core";

import { DEFAULT_EXECUTION_RPC, DEFAULT_PORT, parseConfig } from "../src/cli.js";

function treeFile(chainId: number): string {
  const dir = mkdtempSync(join(tmpdir(), "rotation-signer-"));
  const addresses = Array.from({ length: 8 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "a")}`));
  const file = join(dir, "tree.json");
  writeFileSync(file, JSON.stringify(createTreeFile({ chainId, safe: "0x1111111111111111111111111111111111111111", slotId: 0, base: 1000 }, "test", addresses)));
  return file;
}

describe("parseConfig", () => {
  it("derives chain and Safe from the tree and defaults to Flashbots Protect", () => {
    const config = parseConfig(["--tree", treeFile(SEPOLIA_CHAIN_ID), "--rpc", "http://rpc"], {});
    assert.ok(config !== "help");
    assert.equal(config.chain.id, SEPOLIA_CHAIN_ID);
    assert.equal(config.executionRpc, DEFAULT_EXECUTION_RPC[SEPOLIA_CHAIN_ID]);
    assert.equal(config.port, DEFAULT_PORT);
    assert.deepEqual(config.key, { kind: "seed", mnemonicFile: undefined, passphrase: false });
  });

  it("reads the RPC from the environment and accepts overrides", () => {
    const config = parseConfig(["--tree", treeFile(1), "--execution-rpc", "http://private", "--port", "9000", "--ledger"], { RPC_URL: "http://env" });
    assert.ok(config !== "help");
    assert.equal(config.rpc, "http://env");
    assert.equal(config.executionRpc, "http://private");
    assert.equal(config.port, 9000);
    assert.deepEqual(config.key, { kind: "ledger" });
  });

  it("rejects unsupported chains, missing input and secrets on the command line", () => {
    assert.throws(() => parseConfig(["--tree", treeFile(10), "--rpc", "http://rpc"], {}), /only mainnet and Sepolia/);
    assert.throws(() => parseConfig(["--rpc", "http://rpc"], {}), /--tree is required/);
    assert.throws(() => parseConfig(["--tree", treeFile(1)], {}), /--rpc/);
    assert.throws(() => parseConfig(["--tree", treeFile(1), "--rpc", "x", "--ledger", "--mnemonic-file", "f"], {}), /either --ledger or --mnemonic-file/);
    assert.throws(() => parseConfig(["--tree", treeFile(1), "--rpc", "x", "--mnemonic", "words"], {}), /Unknown option/);
    assert.throws(() => parseConfig(["--tree", treeFile(1), "--rpc", "x", "--port", "0"], {}), /invalid --port/);
  });
});
