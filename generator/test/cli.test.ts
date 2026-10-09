import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { run, sampleIndexes, type Io } from "../src/cli.js";
import { seedSource } from "@rotating-msig/keys";
import { defaultBase, type TreeFile, safeAccount, SAFE_PATH_TEMPLATE, RANGE_PATH_TEMPLATE } from "@rotating-msig/core";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const SAFE = "0x1234567890123456789012345678901234567890";

function harness(secrets: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const io: Io = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    readSecret: async (question) => {
      asked.push(question);
      const next = secrets.shift();
      if (next === undefined) throw new Error("no secret queued");
      return next;
    },
    openLedger: async () => seedSource(TEST_MNEMONIC),
  };
  return { io, out: () => out.join(""), err: () => err.join(""), asked };
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "rotation-tree-"));
  const mnemonicFile = join(dir, "mnemonic.txt");
  writeFileSync(mnemonicFile, `${TEST_MNEMONIC}\n`);
  return { dir, mnemonicFile, tree: join(dir, "tree.json") };
}

async function generate(ws: ReturnType<typeof workspace>, extra: string[] = []) {
  const h = harness();
  const code = await run(
    ["generate", "--safe", SAFE, "--slot", "1", "--base", "5000", "--size", "20", "--mnemonic-file", ws.mnemonicFile, "--out", ws.tree, ...extra],
    h.io,
  );
  return { code, ...h };
}

describe("generate", () => {
  it("writes a tree file of addresses only", async () => {
    const ws = workspace();
    const { code, out } = await generate(ws);
    assert.equal(code, 0);
    const file = JSON.parse(readFileSync(ws.tree, "utf8")) as TreeFile;
    assert.equal(file.size, 20);
    assert.equal(file.base, 5000);
    assert.equal(file.slotId, 1);
    assert.equal(file.chainId, 1);
    assert.match(out(), new RegExp(file.root));
    const text = readFileSync(ws.tree, "utf8");
    assert.doesNotMatch(text, /xpub|publicKey|privateKey|mnemonic/i);
    assert.doesNotMatch(text, /test test/);
  });

  it("reads the mnemonic from the hidden prompt when no file is given", async () => {
    const ws = workspace();
    const h = harness([TEST_MNEMONIC]);
    const code = await run(["generate", "--safe", SAFE, "--slot", "0", "--base", "5000", "--size", "3", "--out", ws.tree], h.io);
    assert.equal(code, 0);
    assert.deepEqual(h.asked, ["mnemonic: "]);
  });

  it("refuses low bases, overwrites and bad input", async () => {
    const ws = workspace();
    const low = harness();
    assert.equal(await run(["generate", "--safe", SAFE, "--slot", "0", "--base", "5", "--size", "3", "--mnemonic-file", ws.mnemonicFile, "--out", ws.tree], low.io), 1);
    assert.match(low.err(), /overlaps everyday wallet accounts/);

    assert.equal((await generate(ws)).code, 0);
    const again = await generate(ws);
    assert.equal(again.code, 1);
    assert.match(again.err(), /already exists/);
    assert.equal((await generate(ws, ["--force"])).code, 0);

    const bad = harness();
    assert.equal(await run(["generate", "--safe", "0xnope", "--slot", "0", "--base", "5000", "--out", ws.tree], bad.io), 1);
    assert.match(bad.err(), /invalid --safe/);

    const flag = harness();
    assert.equal(await run(["generate", "--mnemonic", TEST_MNEMONIC], flag.io), 1);
    assert.match(flag.err(), /Unknown option/);
  });
});

describe("default base", () => {
  it("derives the base from the chain and Safe when --base is omitted", async () => {
    const ws = workspace();
    const h = harness();
    assert.equal(await run(["generate", "--safe", SAFE, "--slot", "0", "--size", "3", "--mnemonic-file", ws.mnemonicFile, "--out", ws.tree], h.io), 0);
    const file = JSON.parse(readFileSync(ws.tree, "utf8")) as TreeFile;
    assert.equal(file.base, safeAccount(1, SAFE), "one account per Safe");
    assert.equal(file.pathTemplate, SAFE_PATH_TEMPLATE);

    const ranged = harness();
    assert.equal(await run(["generate", "--safe", SAFE, "--slot", "0", "--size", "3", "--layout", "range", "--mnemonic-file", ws.mnemonicFile, "--out", ws.tree, "--force"], ranged.io), 0);
    const rangedFile = JSON.parse(readFileSync(ws.tree, "utf8")) as TreeFile;
    assert.equal(rangedFile.base, defaultBase(1, SAFE));
    assert.equal(rangedFile.pathTemplate, RANGE_PATH_TEMPLATE);
    assert.notDeepEqual(rangedFile.addresses, file.addresses, "the two layouts derive different keys");
  });
});

describe("verify", () => {
  it("accepts the matching root and re-derivation, rejects mismatches", async () => {
    const ws = workspace();
    await generate(ws);
    const file = JSON.parse(readFileSync(ws.tree, "utf8")) as TreeFile;

    const ok = harness();
    assert.equal(await run(["verify", "--tree", ws.tree, "--root", file.root, "--source", "seed", "--mnemonic-file", ws.mnemonicFile], ok.io), 0);
    assert.match(ok.out(), /derive ok 20 of 20/);

    const wrongRoot = harness();
    assert.equal(await run(["verify", "--tree", ws.tree, "--root", `0x${"00".repeat(32)}`], wrongRoot.io), 1);
    assert.match(wrongRoot.err(), /root mismatch/);

    const otherSeed = join(ws.dir, "other.txt");
    writeFileSync(otherSeed, "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about\n");
    const wrongSeed = harness();
    assert.equal(await run(["verify", "--tree", ws.tree, "--source", "seed", "--mnemonic-file", otherSeed, "--sample", "2"], wrongSeed.io), 1);
    assert.match(wrongSeed.err(), /address 0 does not match/);

    writeFileSync(ws.tree, readFileSync(ws.tree, "utf8").replace(file.addresses[4]!, file.addresses[5]!));
    const tampered = harness();
    assert.equal(await run(["verify", "--tree", ws.tree], tampered.io), 1);
    assert.match(tampered.err(), /duplicate address|does not match its addresses/);
  });

  it("re-derives through the ledger source", async () => {
    const ws = workspace();
    await generate(ws);
    const h = harness();
    assert.equal(await run(["verify", "--tree", ws.tree, "--source", "ledger", "--sample", "5"], h.io), 0);
    assert.match(h.out(), /derive ok 5 of 20 addresses re-derived from the ledger/);
  });
});

describe("proof, entries and config", () => {
  it("print JSON in the contract's shapes", async () => {
    const ws = workspace();
    await generate(ws);

    const proof = harness();
    assert.equal(await run(["proof", "--tree", ws.tree, "--index", "3"], proof.io), 0);
    const entry = JSON.parse(proof.out());
    assert.equal(entry.index, 3);
    assert.ok(Array.isArray(entry.proof) && entry.proof.length > 0);

    const entries = harness();
    assert.equal(await run(["entries", "--tree", ws.tree, "--from", "1", "--count", "5"], entries.io), 0);
    assert.equal(JSON.parse(entries.out()).length, 5);

    const config = harness();
    assert.equal(await run(["config", "--tree", ws.tree, "--cid", "bafy"], config.io), 0);
    const parsed = JSON.parse(config.out());
    assert.equal(parsed.startIndex, 0);
    assert.equal(parsed.cid, "bafy");

    const outOfRange = harness();
    assert.equal(await run(["proof", "--tree", ws.tree, "--index", "20"], outOfRange.io), 1);
    assert.match(outOfRange.err(), /out of range/);
  });
});

describe("sampleIndexes", () => {
  it("always includes the first and last index", () => {
    assert.deepEqual(sampleIndexes(10, 2), [0, 9]);
    assert.deepEqual(sampleIndexes(10, 100), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(sampleIndexes(10_000, 5), [0, 2500, 5000, 7499, 9999]);
  });
});
