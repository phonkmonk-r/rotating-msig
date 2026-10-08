import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildVector } from "./vector.js";

describe("cross-check vector", () => {
  it("matches the committed vector the Solidity tests read", async () => {
    const committed = JSON.parse(readFileSync(new URL("../../test/vectors/tree-vector.json", import.meta.url), "utf8"));
    assert.deepEqual(await buildVector(), committed, "regenerate with `npm run vectors`");
  });
});
