import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_TREE_SIZE, defaultBase, MIN_TREE_BASE } from "../src/base.js";
import { MAX_ACCOUNT_INDEX } from "../src/tree.js";

describe("defaultBase", () => {
  it("is deterministic, per chain and per Safe, and leaves room for a full tree", () => {
    const safe = "0x7aC0Ac669d32Bd739eAA892bcFD2C6dF9946Ed02";
    const base = defaultBase(11155111, safe);
    assert.equal(base, defaultBase(11155111, safe.toLowerCase() as `0x${string}`));
    assert.notEqual(base, defaultBase(1, safe));
    assert.notEqual(base, defaultBase(11155111, "0x1111111111111111111111111111111111111111"));
    for (const candidate of [base, defaultBase(1, safe)]) {
      assert.ok(candidate >= MIN_TREE_BASE);
      assert.ok(candidate + DEFAULT_TREE_SIZE - 1 <= MAX_ACCOUNT_INDEX);
    }
  });
});
