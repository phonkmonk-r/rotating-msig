import { useEffect, useMemo, useState } from "react";
import { encodeFunctionData, isAddress, isHex, parseAbi, parseEther, type AbiFunction, type AbiParameter } from "viem";

import type { DappCall } from "../api";

type Mode = "function" | "raw";

/** Functions in an ABI pasted as JSON, or as one human-readable signature per line ("function deposit(uint256)"). */
function parseFunctions(text: string): AbiFunction[] {
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
function coerce(param: AbiParameter, value: unknown): unknown {
  const type = param.type;
  if (type.endsWith("]")) {
    const inner = { ...param, type: type.slice(0, type.lastIndexOf("[")) } as AbiParameter;
    const list = typeof value === "string" ? (JSON.parse(value) as unknown[]) : (value as unknown[]);
    if (!Array.isArray(list)) throw new Error(`${param.name || type}: expected a JSON array`);
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
    if (!/^-?\d+$/.test(text)) throw new Error(`${param.name || type}: enter a whole number (base units)`);
    return BigInt(text);
  }
  if (type === "bool") {
    if (text !== "true" && text !== "false") throw new Error(`${param.name || type}: enter true or false`);
    return text === "true";
  }
  if (type === "address") {
    if (!isAddress(text, { strict: false })) throw new Error(`${param.name || type}: not an address`);
    return text;
  }
  if (type.startsWith("bytes")) {
    if (!isHex(text)) throw new Error(`${param.name || type}: enter 0x-prefixed hex`);
    return text;
  }
  return text;
}

/**
 * A call to any contract: from an ABI (JSON or human-readable signatures) with typed inputs, or raw calldata. Reports
 * the call it builds, or why it cannot be built yet. Calls to the Safe or the guard are refused when proposed.
 */
export function ContractCall({ onChange }: { onChange: (call: DappCall | undefined, problem?: string) => void }) {
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<Mode>("function");
  const [abiText, setAbiText] = useState("");
  const [selected, setSelected] = useState(0);
  const [args, setArgs] = useState<string[]>([]);
  const [raw, setRaw] = useState("");
  const [value, setValue] = useState("");

  const parsed = useMemo(() => {
    try {
      return { functions: parseFunctions(abiText) };
    } catch (error) {
      return { functions: [] as AbiFunction[], error: `Could not read the ABI: ${(error as Error).message.split("\n")[0]}` };
    }
  }, [abiText]);
  const fn = parsed.functions[selected];

  const built = useMemo((): { call?: DappCall; problem?: string } => {
    if (!isAddress(target.trim(), { strict: false })) return { problem: "Enter the contract address" };
    let wei = 0n;
    if (value.trim()) {
      if (!/^\d*\.?\d+$/.test(value.trim())) return { problem: "Enter the ETH value as a number" };
      wei = parseEther(value.trim());
    }
    let data: `0x${string}`;
    if (mode === "raw") {
      const hex = raw.trim() || "0x";
      if (!isHex(hex) || hex.length % 2 !== 0) return { problem: "Call data must be even-length 0x hex" };
      data = hex;
    } else {
      if (parsed.error) return { problem: parsed.error };
      if (!fn) return { problem: "Paste an ABI or a function signature" };
      if (wei > 0n && fn.stateMutability !== "payable") return { problem: `${fn.name} is not payable; it cannot receive ETH` };
      try {
        data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: fn.inputs.map((input, i) => coerce(input, args[i] ?? "")) as never });
      } catch (error) {
        return { problem: (error as Error).message.split("\n")[0] };
      }
    }
    return { call: { to: target.trim(), value: wei.toString(), data } };
  }, [target, value, mode, raw, parsed, fn, args]);

  useEffect(() => onChange(built.call, built.problem), [built, onChange]);

  return (
    <div className="composer-fields">
      <label className="field">
        <span className="field-label">Contract</span>
        <input placeholder="0x…" spellCheck={false} value={target} onChange={(e) => setTarget(e.target.value)} />
      </label>

      <div className="segmented">
        <button type="button" className={mode === "function" ? "active" : ""} onClick={() => setMode("function")}>
          Function
        </button>
        <button type="button" className={mode === "raw" ? "active" : ""} onClick={() => setMode("raw")}>
          Raw data
        </button>
      </div>

      {mode === "function" ? (
        <>
          <label className="field">
            <span className="field-label">ABI</span>
            <textarea
              rows={3}
              spellCheck={false}
              placeholder={'function deposit(uint256 amount)\nor the contract\'s JSON ABI: [{"type":"function",…}]'}
              value={abiText}
              onChange={(e) => {
                setAbiText(e.target.value);
                setSelected(0);
                setArgs([]);
              }}
            />
          </label>
          {parsed.functions.length > 1 && (
            <label className="field">
              <span className="field-label">Function</span>
              <select
                value={selected}
                onChange={(e) => {
                  setSelected(Number(e.target.value));
                  setArgs([]);
                }}
              >
                {parsed.functions.map((item, i) => (
                  <option key={`${item.name}-${i}`} value={i}>
                    {item.name}({item.inputs.map((input) => input.type).join(", ")})
                  </option>
                ))}
              </select>
            </label>
          )}
          {fn?.inputs.map((input, i) => (
            <label key={`${fn.name}-${i}`} className="field">
              <span className="field-label">
                {input.name || `argument ${i + 1}`} <span className="muted mono small">{input.type}</span>
              </span>
              <input
                spellCheck={false}
                placeholder={input.type.endsWith("]") || input.type === "tuple" ? "JSON, e.g. [1, 2]" : input.type.startsWith("uint") ? "whole number in base units" : input.type}
                value={args[i] ?? ""}
                onChange={(e) => {
                  const next = [...args];
                  next[i] = e.target.value;
                  setArgs(next);
                }}
              />
            </label>
          ))}
        </>
      ) : (
        <label className="field">
          <span className="field-label">Call data</span>
          <textarea rows={3} spellCheck={false} placeholder="0x…" value={raw} onChange={(e) => setRaw(e.target.value)} />
        </label>
      )}

      <label className="field">
        <span className="field-label">
          ETH to send <span className="muted">optional</span>
        </span>
        <div className="amount-input">
          <input inputMode="decimal" placeholder="0" value={value} onChange={(e) => setValue(e.target.value)} />
          <span className="unit">ETH</span>
        </div>
      </label>
      {built.call && <span className="muted small mono">Call data: {(built.call.data!.length - 2) / 2} bytes</span>}
    </div>
  );
}
