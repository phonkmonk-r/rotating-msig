import type { DappCall } from "@rotating-msig/core";
import { getAddress, isAddress, isHex, keccak256, numberToHex, stringToHex, type Hex } from "viem";

import type { DraftItem, ProposalResult, ProposalStatus, SignerSession } from "./session.js";
import { SimulationRevert, type ReadCall } from "./simulate.js";

/** An EIP-1193 error: the code and message reach the dApp unchanged. */
export class ProviderError extends Error {
  constructor(
    readonly code: number,
    message: string,
    /** Revert data, for errors from simulated calls. */
    readonly data?: Hex,
  ) {
    super(message);
  }
}

/** JSON-RPC code for a reverted call. */
export const EXECUTION_REVERTED = 3;

export const USER_REJECTED = 4001;
export const UNAUTHORIZED = 4100;
export const UNSUPPORTED_METHOD = 4200;
export const DISCONNECTED = 4900;
export const UNRECOGNIZED_CHAIN = 4902;
export const INVALID_PARAMS = -32602;
export const RESOURCE_UNAVAILABLE = -32002;

/** A dApp's request to transact, as the user reviews it. */
export interface DappRequest {
  id: string;
  /** Origin of the page that asked, e.g. https://app.uniswap.org. */
  origin: string;
  method: "eth_sendTransaction" | "wallet_sendCalls";
  calls: DappCall[];
}

export interface DappHost {
  /** The signing session, or undefined while the wallet is locked or no Safe is joined. */
  session(): SignerSession | undefined;
  /** Shows the request to the user. Resolves once it is proposed or queued; rejects with a ProviderError if refused. */
  review(request: DappRequest): Promise<ProposalResult | { queued: DraftItem }>;
}

/** Read-only methods forwarded to the RPC as they are. */
const READ_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getProof",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_syncing",
  "web3_clientVersion",
]);

const SIGNING_METHODS = new Set(["personal_sign", "eth_sign", "eth_signTypedData", "eth_signTypedData_v3", "eth_signTypedData_v4", "eth_signTransaction"]);

/** EIP-5792 status codes. */
const CALLS_STATUS = { pending: 100, executed: 200, replaced: 400, failed: 500 } as const;

interface Tracked {
  nonce: bigint;
  fromBlock: bigint;
}

/**
 * The wallet a dApp sees in the built-in browser. The account is the Safe: reads go to the RPC, and transactions
 * become Safe proposals the user reviews and signs with their current owner key. The hash returned to the dApp is
 * the safeTxHash; receipt lookups for it are answered with the execution's receipt once a signer executes it.
 * Message signing is refused, since it would expose an owner key without the guard rotating it.
 */
export class DappProvider {
  private readonly proposals = new Map<string, Tracked>();
  /** Placeholder hashes handed out for queued requests, by draft item ID. */
  private readonly queued = new Map<string, string>();
  private reviewing = false;
  private nextId = 0;

  constructor(private readonly host: DappHost) {}

  async request(origin: string, method: string, params: unknown = []): Promise<unknown> {
    const session = this.host.session();
    if (!session) throw new ProviderError(DISCONNECTED, "Keyturn is locked");
    const args = Array.isArray(params) ? params : [];
    const chainHex = numberToHex(session.chainId);

    switch (method) {
      case "eth_chainId":
        return chainHex;
      case "net_version":
        return String(session.chainId);
      case "eth_accounts":
      case "eth_requestAccounts":
        return [session.safe];
      case "eth_coinbase":
        return session.safe;
      case "wallet_requestPermissions":
      case "wallet_getPermissions":
        return [{ parentCapability: "eth_accounts", caveats: [] }];
      case "wallet_switchEthereumChain": {
        const requested = (args[0] as { chainId?: string } | undefined)?.chainId;
        if (typeof requested === "string" && BigInt(requested) === BigInt(session.chainId)) return null;
        throw new ProviderError(UNRECOGNIZED_CHAIN, `This Safe is on chain ${session.chainId} only`);
      }
      case "wallet_getCapabilities":
        return { [chainHex]: { atomic: { status: "supported" } } };
      case "eth_sendTransaction": {
        const tx = args[0] as { from?: string; to?: string; value?: string; data?: string; input?: string } | undefined;
        if (!tx || typeof tx.to !== "string") throw new ProviderError(INVALID_PARAMS, "Contract creation is not supported");
        this.checkFrom(session, tx.from);
        return (await this.propose(session, { origin, method, calls: [{ to: tx.to, value: tx.value, data: tx.data ?? tx.input }] })).hash;
      }
      case "wallet_sendCalls": {
        const request = args[0] as { from?: string; chainId?: string; calls?: { to?: string; value?: string; data?: string }[] } | undefined;
        if (!request || !Array.isArray(request.calls)) throw new ProviderError(INVALID_PARAMS, "Expected a list of calls");
        if (request.chainId !== undefined && BigInt(request.chainId) !== BigInt(session.chainId)) {
          throw new ProviderError(UNRECOGNIZED_CHAIN, `This Safe is on chain ${session.chainId} only`);
        }
        this.checkFrom(session, request.from);
        if (request.calls.some((call) => typeof call.to !== "string")) throw new ProviderError(INVALID_PARAMS, "Contract creation is not supported");
        const calls = request.calls.map((call) => ({ to: call.to!, value: call.value, data: call.data }));
        return { id: (await this.propose(session, { origin, method, calls })).hash };
      }
      case "wallet_getCallsStatus":
        return this.callsStatus(session, args[0]);
      case "wallet_showCallsStatus":
        return null;
      case "eth_call":
      case "eth_estimateGas": {
        if ((await session.draftCalls()).length === 0) return session.rpc(method, args);
        try {
          const { returnData, gasUsed } = await session.readAfterDraft(args[0] as ReadCall);
          return method === "eth_call" ? returnData : numberToHex((gasUsed * 13n) / 10n + 21_000n);
        } catch (error) {
          if (error instanceof SimulationRevert) throw new ProviderError(EXECUTION_REVERTED, error.message, error.data);
          throw error;
        }
      }
      case "eth_getTransactionReceipt":
      case "eth_getTransactionByHash": {
        const placeholder = typeof args[0] === "string" ? this.placeholder(session, args[0]) : undefined;
        if (placeholder) return method === "eth_getTransactionReceipt" ? this.queuedReceipt(session, args[0] as Hex) : null;
        const tracked = typeof args[0] === "string" ? this.proposals.get(args[0].toLowerCase()) : undefined;
        if (!tracked) return session.rpc(method, args);
        const status = await session.proposalStatus(args[0] as Hex, tracked.nonce, tracked.fromBlock);
        if (!status.transactionHash) return null;
        if (method === "eth_getTransactionByHash") return session.rpc(method, [status.transactionHash]);
        // ExecutionFailure: the outer transaction succeeded but the Safe's call reverted.
        return status.status === "failed" ? { ...status.receipt, status: "0x0" } : status.receipt;
      }
    }

    if (SIGNING_METHODS.has(method)) {
      throw new ProviderError(UNSUPPORTED_METHOD, "Keyturn does not sign messages: it would expose a Safe owner key without rotating it");
    }
    if (READ_METHODS.has(method)) return session.rpc(method, args);
    throw new ProviderError(UNSUPPORTED_METHOD, `${method} is not supported`);
  }

  private checkFrom(session: SignerSession, from: string | undefined) {
    if (from === undefined) return;
    if (!isAddress(from, { strict: false }) || getAddress(from) !== session.safe) throw new ProviderError(UNAUTHORIZED, "Transactions can only come from the Safe");
  }

  /** Proposes or queues a request, as the user chooses; returns the hash the dApp gets back. */
  private async propose(session: SignerSession, request: Omit<DappRequest, "id">): Promise<{ hash: Hex }> {
    if (this.reviewing) throw new ProviderError(RESOURCE_UNAVAILABLE, "Another request is waiting for review");
    this.reviewing = true;
    try {
      const fromBlock = await session.blockNumber();
      const result = await this.host.review({ id: String(++this.nextId), ...request });
      if ("queued" in result) {
        const hash = keccak256(stringToHex(`keyturn-queued:${result.queued.id}:${result.queued.addedAt}`));
        this.queued.set(hash.toLowerCase(), result.queued.id);
        return { hash };
      }
      this.proposals.set(result.safeTxHash.toLowerCase(), { nonce: BigInt(result.nonce), fromBlock });
      return { hash: result.safeTxHash };
    } finally {
      this.reviewing = false;
    }
  }

  /**
   * A placeholder hash still waiting in the queue (or proposed but not yet executed). Once its batch executes, lookups
   * fall through to the real proposal.
   */
  private placeholder(session: SignerSession, hash: string): string | undefined {
    const id = this.queued.get(hash.toLowerCase());
    if (!id) return undefined;
    const proposal = session.draftProposal(id);
    if (proposal && !this.proposals.has(proposal.safeTxHash.toLowerCase())) {
      this.proposals.set(proposal.safeTxHash.toLowerCase(), { nonce: proposal.nonce, fromBlock: proposal.fromBlock });
    }
    return id;
  }

  /**
   * Queued requests report success at once, so a dApp waiting for an approval moves on to its next step (which is
   * read against the queued state). The app shows them as queued, never as on-chain.
   */
  private async queuedReceipt(session: SignerSession, hash: Hex) {
    const id = this.queued.get(hash.toLowerCase())!;
    const proposal = session.draftProposal(id);
    if (proposal) {
      const status = await session.proposalStatus(proposal.safeTxHash, proposal.nonce, proposal.fromBlock);
      if (status.receipt) return status.status === "failed" ? { ...status.receipt, status: "0x0" } : status.receipt;
    }
    const block = (await session.rpc("eth_getBlockByNumber", ["latest", false])) as { hash: Hex; number: Hex };
    return {
      transactionHash: hash,
      transactionIndex: "0x0",
      blockHash: block.hash,
      blockNumber: block.number,
      from: session.safe,
      to: session.safe,
      cumulativeGasUsed: "0x0",
      gasUsed: "0x0",
      effectiveGasPrice: "0x0",
      contractAddress: null,
      logs: [],
      logsBloom: `0x${"0".repeat(512)}`,
      status: "0x1",
      type: "0x2",
    };
  }

  private async callsStatus(session: SignerSession, requested: unknown) {
    let id = requested;
    if (typeof id === "string" && this.placeholder(session, id)) {
      const proposal = session.draftProposal(this.queued.get(id.toLowerCase())!);
      if (!proposal) return { version: "2.0.0", id: requested, chainId: numberToHex(session.chainId), atomic: true, status: CALLS_STATUS.pending };
      id = proposal.safeTxHash;
    }
    const tracked = typeof id === "string" && isHex(id) ? this.proposals.get(id.toLowerCase()) : undefined;
    if (!tracked) throw new ProviderError(INVALID_PARAMS, "Unknown call bundle");
    const status: ProposalStatus = await session.proposalStatus(id as Hex, tracked.nonce, tracked.fromBlock);
    const receipt = status.receipt as { logs?: unknown; status?: string; blockHash?: string; blockNumber?: string; gasUsed?: string; transactionHash?: string } | undefined;
    return {
      version: "2.0.0",
      id: requested,
      chainId: numberToHex(session.chainId),
      atomic: true,
      status: CALLS_STATUS[status.status],
      receipts: receipt
        ? [
            {
              logs: receipt.logs,
              status: status.status === "failed" ? "0x0" : receipt.status,
              blockHash: receipt.blockHash,
              blockNumber: receipt.blockNumber,
              gasUsed: receipt.gasUsed,
              transactionHash: receipt.transactionHash,
            },
          ]
        : undefined,
    };
  }
}
