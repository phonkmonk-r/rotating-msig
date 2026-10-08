import { SEPOLIA_CHAIN_ID, TxService, type TreeFile } from "@rotating-msig/core";
import type { AddressSource } from "@rotating-msig/keys";
import { createPublicClient, http, type Chain, type PublicClient } from "viem";
import { mainnet, sepolia } from "viem/chains";

import { SignerSession } from "./session.js";

export const CHAINS: Record<number, Chain> = { 1: mainnet, [SEPOLIA_CHAIN_ID]: sepolia };

/**
 * Mainnet executions default to Flashbots Protect: private, and it drops transactions that would revert instead of
 * mining them. Sepolia defaults to the read RPC: Flashbots Protect accepts Sepolia transactions but few builders
 * include them, so executions hang (seen on 2026-10-08).
 */
export const DEFAULT_EXECUTION_RPC: Record<number, string> = {
  1: "https://rpc.flashbots.net",
};

export function chainFor(chainId: number): Chain {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`the tree is for chain ${chainId}; only mainnet and Sepolia are supported`);
  return chain;
}

export interface SessionConfig {
  tree: TreeFile;
  rpc: string;
  executionRpc?: string;
  /** Overrides the Safe Transaction Service base URL (tests and local demos). */
  txServiceUrl?: string;
  safeApiKey?: string;
}

/** Builds the session the CLI and the desktop app both run. */
export function createSession(config: SessionConfig, source: AddressSource): { session: SignerSession; chain: Chain; executionRpc: string } {
  const chain = chainFor(config.tree.chainId);
  const executionRpc = config.executionRpc ?? DEFAULT_EXECUTION_RPC[config.tree.chainId] ?? config.rpc;
  const session = new SignerSession({
    publicClient: createPublicClient({ chain, transport: http(config.rpc) }) as PublicClient,
    chain,
    executionRpcUrl: executionRpc,
    txService: new TxService(config.tree.chainId, { baseUrl: config.txServiceUrl, apiKey: config.safeApiKey }),
    source,
    tree: config.tree,
    safe: config.tree.safe,
  });
  return { session, chain, executionRpc };
}
