import { getAddress, type Address, type Hex } from "viem";

import { SEPOLIA_CHAIN_ID } from "./addresses.js";
import { safeTxHash, type SafeTx } from "./safetx.js";

const NETWORK_SHORT_NAMES: Record<number, string> = { 1: "eth", [SEPOLIA_CHAIN_ID]: "sep" };

/** Base URL of the Safe Transaction Service for a chain (the per-network domains now redirect here). */
export function txServiceUrl(chainId: number): string {
  const name = NETWORK_SHORT_NAMES[chainId];
  if (!name) throw new Error(`no Safe Transaction Service known for chain ${chainId}`);
  return `https://api.safe.global/tx-service/${name}`;
}

export type SignatureType = "EOA" | "ETH_SIGN" | "APPROVED_HASH" | "CONTRACT_SIGNATURE";

export interface Confirmation {
  owner: Address;
  signature: Hex;
  signatureType: SignatureType;
}

export interface PendingTx {
  safeTxHash: Hex;
  tx: SafeTx;
  confirmations: Confirmation[];
  proposer?: Address;
  submissionDate?: string;
}

export interface TxServiceOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

interface ServiceTx {
  safe: string;
  to: string;
  value: string;
  data: string | null;
  operation: number;
  safeTxGas: string | number;
  baseGas: string | number;
  gasPrice: string | number;
  gasToken: string | null;
  refundReceiver: string | null;
  nonce: string | number;
  safeTxHash: string;
  proposer?: string | null;
  submissionDate?: string;
  confirmations?: { owner: string; signature: string; signatureType: SignatureType }[];
}

/** Minimal client for the Safe Transaction Service. Every transaction's hash is recomputed locally on read. */
export class TxService {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly chainId: number,
    options: TxServiceOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? txServiceUrl(chainId);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Unexecuted transactions from `fromNonce` upwards, oldest first. */
  async pending(safe: Address, fromNonce: bigint): Promise<PendingTx[]> {
    const url = `${this.baseUrl}/api/v1/safes/${getAddress(safe)}/multisig-transactions/?executed=false&nonce__gte=${fromNonce}&ordering=nonce&limit=50`;
    const body = (await this.request(url)) as { results: ServiceTx[] };
    return body.results.map((raw) => this.parse(safe, raw));
  }

  /**
   * Proposes a new transaction. `sender` must be a current owner and `signature` that owner's signature over the
   * transaction's hash, which the service records as their confirmation.
   */
  async propose(safe: Address, tx: SafeTx, sender: Address, signature: Hex, origin = "rotation-signer"): Promise<Hex> {
    const hash = safeTxHash(this.chainId, safe, tx);
    await this.request(`${this.baseUrl}/api/v1/safes/${getAddress(safe)}/multisig-transactions/`, {
      method: "POST",
      body: JSON.stringify({
        to: tx.to,
        value: tx.value.toString(),
        data: tx.data === "0x" ? null : tx.data,
        operation: tx.operation,
        safeTxGas: tx.safeTxGas.toString(),
        baseGas: tx.baseGas.toString(),
        gasPrice: tx.gasPrice.toString(),
        gasToken: tx.gasToken === "0x0000000000000000000000000000000000000000" ? null : tx.gasToken,
        refundReceiver: tx.refundReceiver === "0x0000000000000000000000000000000000000000" ? null : tx.refundReceiver,
        nonce: tx.nonce.toString(),
        contractTransactionHash: hash,
        sender: getAddress(sender),
        signature,
        origin,
      }),
    });
    return hash;
  }

  /** Adds an owner's confirmation (a 65-byte signature over the safeTxHash). */
  async confirm(hash: Hex, signature: Hex): Promise<void> {
    await this.request(`${this.baseUrl}/api/v1/multisig-transactions/${hash}/confirmations/`, {
      method: "POST",
      body: JSON.stringify({ signature }),
    });
  }

  private parse(safe: Address, raw: ServiceTx): PendingTx {
    const tx: SafeTx = {
      to: getAddress(raw.to),
      value: BigInt(raw.value),
      data: (raw.data ?? "0x") as Hex,
      operation: raw.operation === 1 ? 1 : 0,
      safeTxGas: BigInt(raw.safeTxGas),
      baseGas: BigInt(raw.baseGas),
      gasPrice: BigInt(raw.gasPrice),
      gasToken: getAddress(raw.gasToken ?? "0x0000000000000000000000000000000000000000"),
      refundReceiver: getAddress(raw.refundReceiver ?? "0x0000000000000000000000000000000000000000"),
      nonce: BigInt(raw.nonce),
    };
    const hash = safeTxHash(this.chainId, safe, tx);
    if (hash.toLowerCase() !== raw.safeTxHash.toLowerCase()) {
      throw new Error(`Transaction Service returned nonce ${tx.nonce} with hash ${raw.safeTxHash}, but its fields hash to ${hash}`);
    }
    return {
      safeTxHash: hash,
      tx,
      confirmations: (raw.confirmations ?? []).map((c) => ({ owner: getAddress(c.owner), signature: c.signature as Hex, signatureType: c.signatureType })),
      proposer: raw.proposer ? getAddress(raw.proposer) : undefined,
      submissionDate: raw.submissionDate,
    };
  }

  private async request(url: string, init: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body) headers["content-type"] = "application/json";
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await this.fetchImpl(url, { ...init, headers });
    const text = await response.text();
    if (!response.ok) throw new Error(`Transaction Service ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : undefined;
  }
}
