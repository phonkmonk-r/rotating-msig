import { useEffect, useMemo, useState } from "react";
import type { AbiFunction } from "viem";

import type { DappCall } from "../api";
import { buildContractCall, parseFunctions } from "../lib/contractCall";

/**
 * A call to any contract: from an ABI (JSON or human-readable signatures) with typed inputs, or raw calldata. Reports
 * the call it builds, or why it cannot be built yet. Calls to the Safe or the guard are refused when proposed.
 */
export function ContractCall({ onChange }: { onChange: (call: DappCall | undefined, problem?: string) => void }) {
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<"function" | "raw">("function");
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

  const built = useMemo(() => buildContractCall({ target, value, mode, raw, fn, abiError: parsed.error, args }), [target, value, mode, raw, parsed, fn, args]);

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
