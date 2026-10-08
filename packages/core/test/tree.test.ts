import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress, type Address } from "viem";

import { buildTree, createTreeFile, leafHash, leafValue, loadTreeFile, proofFor, slotConfig, stageEntries, type TreeMeta } from "../src/tree.js";

const META: TreeMeta = { chainId: 1, safe: "0x1234567890123456789012345678901234567890", slotId: 2, base: 1000 };

function addresses(count: number): Address[] {
  return Array.from({ length: count }, (_, i) => getAddress(`0x${(i + 0x100).toString(16).padStart(40, "a")}`));
}

describe("leaf encoding", () => {
  it("matches the library's leaf hash", () => {
    const list = addresses(5);
    const tree = buildTree(META, list);
    list.forEach((owner, index) => {
      assert.equal(tree.leafHash(leafValue(META, index, owner)), leafHash(META, index, owner));
    });
  });

  it("binds every field", () => {
    const owner = addresses(1)[0]!;
    const base = leafHash(META, 3, owner);
    assert.notEqual(leafHash({ ...META, chainId: 2 }, 3, owner), base);
    assert.notEqual(leafHash({ ...META, safe: "0x1234567890123456789012345678901234567891" }, 3, owner), base);
    assert.notEqual(leafHash({ ...META, slotId: 3 }, 3, owner), base);
    assert.notEqual(leafHash(META, 4, owner), base);
    assert.notEqual(leafHash(META, 3, addresses(2)[1]!), base);
  });
});

describe("tree", () => {
  for (const size of [1, 2, 3, 7, 64, 101]) {
    it(`every proof verifies for size ${size}`, () => {
      const list = addresses(size);
      const tree = buildTree(META, list);
      const file = createTreeFile(META, "m/44'/60'/{account}'/0/0", list);
      for (let index = 0; index < size; index++) {
        const entry = proofFor(tree, file, index);
        assert.equal(entry.owner, list[index]);
        assert.ok(StandardMerkleTree.verify(file.root, ["uint256", "address", "uint256", "uint256", "address"], leafValue(META, index, list[index]!), entry.proof));
      }
    });
  }

  it("rejects duplicate, zero, sentinel and self addresses", () => {
    const list = addresses(4);
    assert.throws(() => buildTree(META, [...list, list[1]!]), /duplicate address at index 4/);
    assert.throws(() => buildTree(META, [...list, "0x0000000000000000000000000000000000000000"]), /reserved/);
    assert.throws(() => buildTree(META, [...list, "0x0000000000000000000000000000000000000001"]), /reserved/);
    assert.throws(() => buildTree(META, [...list, META.safe]), /the Safe itself/);
  });

  it("rejects an account range outside the hardened index space", () => {
    assert.throws(() => buildTree({ ...META, base: 2 ** 31 - 2 }, addresses(3)), /hardened index space/);
  });

  it("loads its own output and rejects tampering", () => {
    const list = addresses(9);
    const file = createTreeFile(META, "m/44'/60'/{account}'/0/0", list);
    assert.equal(loadTreeFile(JSON.stringify(file)).file.root, file.root);

    const swapped = { ...file, addresses: [...file.addresses] };
    [swapped.addresses[2], swapped.addresses[3]] = [swapped.addresses[3]!, swapped.addresses[2]!];
    assert.throws(() => loadTreeFile(JSON.stringify(swapped)), /does not match its addresses/);

    assert.throws(() => loadTreeFile(JSON.stringify({ ...file, slotId: 3 })), /does not match its addresses/);
    assert.throws(() => loadTreeFile(JSON.stringify({ ...file, size: 8 })), /declares size 8/);
    assert.throws(() => loadTreeFile(JSON.stringify({ ...file, format: "other" })), /unsupported tree format/);
  });

  it("produces stage entries and slot configs", () => {
    const list = addresses(10);
    const file = createTreeFile(META, "m/44'/60'/{account}'/0/0", list);
    const { tree } = loadTreeFile(JSON.stringify(file));
    const batch = stageEntries(tree, file, 3, 5);
    assert.deepEqual(batch.map((entry) => entry.index), [3, 4, 5, 6, 7]);
    assert.throws(() => stageEntries(tree, file, 8, 3), /exceed tree size/);

    const config = slotConfig(tree, file, 0, "bafy");
    assert.equal(config.owner, list[0]);
    assert.equal(config.root, file.root);
    assert.equal(config.size, 10);
    assert.equal(config.cid, "bafy");
  });
});
