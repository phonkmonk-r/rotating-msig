import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, parseAbi, type AbiFunction, type AbiParameter } from "viem";

import { buildContractCall, coerce, parseFunctions, type ContractCallForm } from "../src/lib/contractCall.js";

const TARGET = "0x000000000000000000000000000000000000bEEF";

function form(overrides: Partial<ContractCallForm>): ContractCallForm {
  return { target: TARGET, value: "", mode: "function", raw: "", args: [], ...overrides };
}

describe("parseFunctions", () => {
  it("reads human-readable signatures, with or without the function keyword", () => {
    const fns = parseFunctions("deposit(uint256 amount)\n\nfunction approve(address spender, uint256 amount) returns (bool)");
    assert.deepEqual(fns.map((fn) => fn.name), ["deposit", "approve"]);
    assert.equal(fns[0]!.inputs[0]!.name, "amount");
  });

  it("reads a JSON ABI and keeps only functions that change state", () => {
    const abi = JSON.stringify([
      { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
      { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
      { type: "function", name: "fee", stateMutability: "pure", inputs: [], outputs: [{ type: "uint256" }] },
      { type: "event", name: "Deposit", inputs: [] },
    ]);
    assert.deepEqual(parseFunctions(abi).map((fn) => fn.name), ["deposit"]);
  });

  it("returns nothing for empty text and throws on nonsense", () => {
    assert.deepEqual(parseFunctions("  \n "), []);
    assert.throws(() => parseFunctions("[not json"));
    assert.throws(() => parseFunctions("deposit(uint999 x"));
  });
});

describe("coerce", () => {
  const param = (type: string, extra: object = {}) => ({ type, name: "x", ...extra }) as AbiParameter;

  it("turns numbers into bigints and rejects decimals", () => {
    assert.equal(coerce(param("uint256"), " 1000 "), 1000n);
    assert.equal(coerce(param("int8"), "-5"), -5n);
    assert.throws(() => coerce(param("uint256"), "1.5"), /x: enter a whole number/);
    assert.throws(() => coerce(param("uint256"), ""), /whole number/);
  });

  it("checks booleans, addresses and bytes", () => {
    assert.equal(coerce(param("bool"), "true"), true);
    assert.equal(coerce(param("bool"), "false"), false);
    assert.throws(() => coerce(param("bool"), "yes"), /true or false/);
    assert.equal(coerce(param("address"), TARGET.toLowerCase()), TARGET.toLowerCase());
    assert.throws(() => coerce(param("address"), "0x1234"), /not an address/);
    assert.equal(coerce(param("bytes32"), "0xab"), "0xab");
    assert.throws(() => coerce(param("bytes"), "ab"), /0x-prefixed hex/);
    assert.equal(coerce(param("string"), " hi "), "hi");
  });

  it("reads arrays (also nested) as JSON", () => {
    assert.deepEqual(coerce(param("uint256[]"), "[1, \"2\"]"), [1n, 2n]);
    assert.deepEqual(coerce(param("uint8[2][]"), "[[1,2],[3,4]]"), [[1n, 2n], [3n, 4n]]);
    assert.throws(() => coerce(param("uint256[]"), "{}"), /expected a JSON array/);
  });

  it("reads tuples as JSON arrays or objects", () => {
    const tuple = param("tuple", { components: [{ type: "address", name: "to" }, { type: "uint256", name: "amount" }] });
    assert.deepEqual(coerce(tuple, `["${TARGET}", 5]`), [TARGET, 5n]);
    assert.deepEqual(coerce(tuple, `{"to": "${TARGET}", "amount": "5"}`), { to: TARGET, amount: 5n });
  });

  it("names the argument by its type when it has no name", () => {
    assert.throws(() => coerce({ type: "uint256" }, "x"), /^Error: uint256: /);
  });
});

describe("buildContractCall", () => {
  const [transfer] = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]) as unknown as AbiFunction[];
  const [deposit] = parseAbi(["function deposit() payable"]) as unknown as AbiFunction[];

  it("encodes the chosen function with its arguments", () => {
    const { call, problem } = buildContractCall(form({ fn: transfer, args: [TARGET, "7"] }));
    assert.equal(problem, undefined);
    assert.equal(call!.to, TARGET);
    assert.equal(call!.value, "0");
    const decoded = decodeFunctionData({ abi: [transfer!], data: call!.data as `0x${string}` });
    assert.deepEqual(decoded.args, [TARGET, 7n]);
  });

  it("sends ETH to a payable function, in wei", () => {
    const { call } = buildContractCall(form({ fn: deposit, value: "0.5" }));
    assert.equal(call!.value, "500000000000000000");
  });

  it("explains what is missing, in order", () => {
    assert.equal(buildContractCall(form({ target: "0x12" })).problem, "Enter the contract address");
    assert.equal(buildContractCall(form({ value: "1e18", fn: deposit })).problem, "Enter the ETH value as a number");
    assert.equal(buildContractCall(form({ abiError: "Could not read the ABI: x" })).problem, "Could not read the ABI: x");
    assert.equal(buildContractCall(form({})).problem, "Paste an ABI or a function signature");
    assert.equal(buildContractCall(form({ fn: transfer, value: "1" })).problem, "transfer is not payable; it cannot receive ETH");
    assert.equal(buildContractCall(form({ fn: transfer, args: ["0x12", "1"] })).problem, "to: not an address");
  });

  it("passes raw call data through, and refuses odd or non-hex data", () => {
    assert.equal(buildContractCall(form({ mode: "raw", raw: "0xd0e30db0", value: "1" })).call!.data, "0xd0e30db0");
    assert.equal(buildContractCall(form({ mode: "raw", raw: "" })).call!.data, "0x", "an empty body is a plain transfer");
    assert.match(buildContractCall(form({ mode: "raw", raw: "0xabc" })).problem!, /even-length/);
    assert.match(buildContractCall(form({ mode: "raw", raw: "hello" })).problem!, /even-length/);
  });
});
