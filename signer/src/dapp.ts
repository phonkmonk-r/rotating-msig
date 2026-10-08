import type { DappCall } from "@rotating-msig/core";
import { getAddress, isAddress, isHex, numberToHex, type Hex } from "viem";

import type { ProposalResult, ProposalStatus, SignerSession } from "./session.js";

/** An EIP-1193 error: the code and message reach the dApp unchanged. */
export class ProviderError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

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
  /** Shows the request to the user. Resolves once it is proposed; rejects with a ProviderError if refused. */
  review(request: DappRequest): Promise<ProposalResult>;
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
        const result = await this.propose(session, { origin, method, calls: [{ to: tx.to, value: tx.value, data: tx.data ?? tx.input }] });
        return result.safeTxHash;
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
        const result = await this.propose(session, { origin, method, calls });
        return { id: result.safeTxHash };
      }
      case "wallet_getCallsStatus":
        return this.callsStatus(session, args[0]);
      case "wallet_showCallsStatus":
        return null;
      case "eth_getTransactionReceipt":
      case "eth_getTransactionByHash": {
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

  private async propose(session: SignerSession, request: Omit<DappRequest, "id">): Promise<ProposalResult> {
    if (this.reviewing) throw new ProviderError(RESOURCE_UNAVAILABLE, "Another request is waiting for review");
    this.reviewing = true;
    try {
      const fromBlock = await session.blockNumber();
      const result = await this.host.review({ id: String(++this.nextId), ...request });
      this.proposals.set(result.safeTxHash.toLowerCase(), { nonce: BigInt(result.nonce), fromBlock });
      return result;
    } finally {
      this.reviewing = false;
    }
  }

  private async callsStatus(session: SignerSession, id: unknown) {
    const tracked = typeof id === "string" && isHex(id) ? this.proposals.get(id.toLowerCase()) : undefined;
    if (!tracked) throw new ProviderError(INVALID_PARAMS, "Unknown call bundle");
    const status: ProposalStatus = await session.proposalStatus(id as Hex, tracked.nonce, tracked.fromBlock);
    const receipt = status.receipt as { logs?: unknown; status?: string; blockHash?: string; blockNumber?: string; gasUsed?: string; transactionHash?: string } | undefined;
    return {
      version: "2.0.0",
      id,
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
