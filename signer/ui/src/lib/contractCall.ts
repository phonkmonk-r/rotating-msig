import { encodeFunctionData, isAddress, isHex, parseAbi, parseEther, type AbiFunction, type AbiParameter } from "viem";

import type { DappCall } from "../api";

/** Functions that change state, from an ABI pasted as JSON or as one human-readable signature per line. */
export function parseFunctions(text: string): AbiFunction[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const abi = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as { type?: string }[])
    : parseAbi(
        trimmed
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => (line.startsWith("function ") ? line : `function ${line}`)),
      );
  return (abi as AbiFunction[]).filter((item) => item.type === "function" && item.stateMutability !== "view" && item.stateMutability !== "pure");
}

/** Turns typed text (or JSON for arrays and tuples) into the value viem expects for `param`. */
export function coerce(param: AbiParameter, value: unknown): unknown {
  const type = param.type;
  const label = param.name || type;
  if (type.endsWith("]")) {
    const inner = { ...param, type: type.slice(0, type.lastIndexOf("[")) } as AbiParameter;
    const list = typeof value === "string" ? (JSON.parse(value) as unknown[]) : (value as unknown[]);
    if (!Array.isArray(list)) throw new Error(`${label}: expected a JSON array`);
    return list.map((item) => coerce(inner, item));
  }
  if (type === "tuple") {
    const components = (param as { components?: readonly AbiParameter[] }).components ?? [];
    const raw = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    if (Array.isArray(raw)) return raw.map((item, i) => coerce(components[i]!, item));
    return Object.fromEntries(components.map((component) => [component.name, coerce(component, (raw as Record<string, unknown>)[component.name ?? ""])]));
  }
  const text = String(value ?? "").trim();
  if (type.startsWith("uint") || type.startsWith("int")) {
    if (!/^-?\d+$/.test(text)) throw new Error(`${label}: enter a whole number (base units)`);
    return BigInt(text);
  }
  if (type === "bool") {
    if (text !== "true" && text !== "false") throw new Error(`${label}: enter true or false`);
    return text === "true";
  }
  if (type === "address") {
    if (!isAddress(text, { strict: false })) throw new Error(`${label}: not an address`);
    return text;
  }
  if (type.startsWith("bytes")) {
    if (!isHex(text)) throw new Error(`${label}: enter 0x-prefixed hex`);
    return text;
  }
  return text;
}

export interface ContractCallForm {
  target: string;
  /** ETH to send, in ETH. */
  value: string;
  mode: "function" | "raw";
  raw: string;
  /** The chosen function, or undefined if the ABI has none (or could not be read: `abiError`). */
  fn?: AbiFunction;
  abiError?: string;
  args: string[];
}

/** The call the form describes, or the first reason it cannot be built yet. */
export function buildContractCall(form: ContractCallForm): { call?: DappCall; problem?: string } {
  if (!isAddress(form.target.trim(), { strict: false })) return { problem: "Enter the contract address" };
  let wei = 0n;
  if (form.value.trim()) {
    if (!/^\d*\.?\d+$/.test(form.value.trim())) return { problem: "Enter the ETH value as a number" };
    wei = parseEther(form.value.trim());
  }
  let data: `0x${string}`;
  if (form.mode === "raw") {
    const hex = form.raw.trim() || "0x";
    if (!isHex(hex) || hex.length % 2 !== 0) return { problem: "Call data must be even-length 0x hex" };
    data = hex;
  } else {
    if (form.abiError) return { problem: form.abiError };
    const fn = form.fn;
    if (!fn) return { problem: "Paste an ABI or a function signature" };
    if (wei > 0n && fn.stateMutability !== "payable") return { problem: `${fn.name} is not payable; it cannot receive ETH` };
    try {
      data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: fn.inputs.map((input, i) => coerce(input, form.args[i] ?? "")) as never });
    } catch (error) {
      return { problem: (error as Error).message.split("\n")[0] };
    }
  }
  return { call: { to: form.target.trim(), value: wei.toString(), data } };
}
