import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mnemonicToAccount } from "viem/accounts";

import { derivationPath, seedSource } from "../src/index.js";

const SEED = "test test test test test test test test test test test junk";

describe("derivation paths", () => {
  it("derives exactly the standard key at each path shape, including a hardened branch", async () => {
    const source = seedSource(SEED);
    for (const [account, index, branch] of [
      [0, 0, undefined],
      [264143176, 7, undefined],
      [1_234_567_890, 9_999, 2_000_000_000],
    ] as const) {
      const path = derivationPath(account, index, branch);
      assert.equal(await source.address(account, index, branch), mnemonicToAccount(SEED, { path: path as `m/44'/60'/${string}` }).address, path);
    }
    assert.equal(derivationPath(5, 3, 7), "m/44'/60'/5'/7'/3");
    assert.equal(derivationPath(5, 3), "m/44'/60'/5'/0/3");
  });
});
