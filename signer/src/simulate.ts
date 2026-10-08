import type { MetaTx } from "@rotating-msig/core";
import { erc20Abi, getAddress, isAddressEqual, numberToHex, toEventSelector, type Address, type Hex, type PublicClient } from "viem";

const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const APPROVAL = toEventSelector("Approval(address,address,uint256)");
/** The pseudo-address `eth_simulateV1` uses for native ETH movements when `traceTransfers` is on. */
const ETH_PSEUDO_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
/** Geth also reports each ETH move from its system address; counting it would double every ETH change. */
const SYSTEM_ADDRESS = "0xfffffffffffffffffffffffffffffffffffffffe";

export interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

interface SimulatedCallResult {
  status: Hex;
  gasUsed: Hex;
  returnData: Hex;
  logs: RpcLog[];
  error?: { message?: string; data?: Hex };
}

export interface CallOutcome {
  to: Address;
  ok: boolean;
  gasUsed: string;
  error?: string;
}

export interface BalanceChange {
  /** Token contract, or "ETH". */
  token: Address | "ETH";
  symbol: string;
  decimals: number;
  /** Signed, in base units. */
  delta: string;
}

export interface ApprovalChange {
  token: Address;
  symbol: string;
  decimals: number;
  spender: Address;
  amount: string;
}

export interface Simulation {
  /** False when the RPC does not support `eth_simulateV1`; nothing else is then known. */
  available: boolean;
  reason?: string;
  calls: CallOutcome[];
  changes: BalanceChange[];
  approvals: ApprovalChange[];
}

/** A read made by a dApp, run after the queued calls. */
export interface ReadCall {
  from?: Address;
  to?: Address;
  data?: Hex;
  value?: Hex;
}

export class SimulationRevert extends Error {
  constructor(
    message: string,
    readonly data?: Hex,
  ) {
    super(message);
  }
}

function asCall(safe: Address, call: Pick<MetaTx, "to" | "value" | "data">) {
  return { from: safe, to: call.to, value: numberToHex(call.value), data: call.data };
}

async function simulateV1(client: PublicClient, calls: object[]): Promise<SimulatedCallResult[]> {
  const blocks = (await client.request({
    method: "eth_simulateV1" as never,
    params: [{ blockStateCalls: [{ calls }], traceTransfers: true, validation: false }, "latest"] as never,
  })) as { calls: SimulatedCallResult[] }[];
  return blocks[0]!.calls;
}

const topicAddress = (topic: Hex | undefined): Address | undefined => (topic && topic.length === 66 ? getAddress(`0x${topic.slice(26)}`) : undefined);

/**
 * Runs `calls` in order as the Safe would make them, without signatures (`eth_simulateV1` with validation off), and
 * reports each call's outcome plus the Safe's balance changes and new approvals. Only plain calls: the batch's
 * MultiSend wrapper is unpacked by the caller.
 */
export async function simulateCalls(client: PublicClient, safe: Address, calls: readonly Pick<MetaTx, "to" | "value" | "data">[]): Promise<Simulation> {
  let results: SimulatedCallResult[];
  try {
    results = await simulateV1(
      client,
      calls.map((call) => asCall(safe, call)),
    );
  } catch (error) {
    return { available: false, reason: (error as Error).message.split("\n")[0], calls: [], changes: [], approvals: [] };
  }

  const deltas = new Map<string, bigint>();
  const approvals = new Map<string, { token: Address; spender: Address; amount: bigint }>();
  for (const result of results) {
    for (const log of result.logs ?? []) {
      if (isAddressEqual(log.address, SYSTEM_ADDRESS)) continue;
      const [topic, a, b] = log.topics;
      if (topic === TRANSFER && log.topics.length === 3) {
        const from = topicAddress(a);
        const to = topicAddress(b);
        const amount = BigInt(log.data);
        const key = isAddressEqual(log.address, ETH_PSEUDO_TOKEN) ? "ETH" : getAddress(log.address);
        if (from && isAddressEqual(from, safe)) deltas.set(key, (deltas.get(key) ?? 0n) - amount);
        if (to && isAddressEqual(to, safe)) deltas.set(key, (deltas.get(key) ?? 0n) + amount);
      }
      if (topic === APPROVAL && log.topics.length === 3) {
        const owner = topicAddress(a);
        const spender = topicAddress(b);
        if (owner && spender && isAddressEqual(owner, safe)) {
          approvals.set(`${log.address}:${spender}`, { token: getAddress(log.address), spender, amount: BigInt(log.data) });
        }
      }
    }
  }

  const metadata = new Map<string, { symbol: string; decimals: number }>();
  const tokens = new Set([...deltas.keys(), ...[...approvals.values()].map((approval) => approval.token)]);
  await Promise.all(
    [...tokens].map(async (token) => {
      if (token === "ETH") return metadata.set(token, { symbol: "ETH", decimals: 18 });
      const address = token as Address;
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => "tokens"),
        client.readContract({ address, abi: erc20Abi, functionName: "decimals" }).catch(() => 0),
      ]);
      metadata.set(token, { symbol, decimals });
    }),
  );

  return {
    available: true,
    calls: results.map((result, i) => ({
      to: calls[i]!.to,
      ok: result.status === "0x1",
      gasUsed: BigInt(result.gasUsed).toString(),
      error: result.status === "0x1" ? undefined : (result.error?.message ?? "reverted"),
    })),
    changes: [...deltas.entries()]
      .filter(([, delta]) => delta !== 0n)
      .map(([token, delta]) => ({ token: token as Address | "ETH", ...metadata.get(token)!, delta: delta.toString() })),
    approvals: [...approvals.values()].map((approval) => ({ ...approval, ...metadata.get(approval.token)!, amount: approval.amount.toString() })),
  };
}

/**
 * Runs a dApp's read after the queued calls, so it sees the state the queue will leave (for example an allowance a
 * queued approve sets). Returns the read's return data and gas; throws SimulationRevert if it reverts.
 */
export async function readAfter(
  client: PublicClient,
  safe: Address,
  queued: readonly Pick<MetaTx, "to" | "value" | "data">[],
  read: ReadCall,
): Promise<{ returnData: Hex; gasUsed: bigint }> {
  const results = await simulateV1(client, [
    ...queued.map((call) => asCall(safe, call)),
    { from: read.from ?? safe, to: read.to, data: read.data ?? "0x", value: read.value ?? "0x0" },
  ]);
  const last = results.at(-1)!;
  if (last.status !== "0x1") throw new SimulationRevert(last.error?.message ?? "execution reverted", last.error?.data ?? last.returnData);
  return { returnData: last.returnData, gasUsed: BigInt(last.gasUsed) };
}
