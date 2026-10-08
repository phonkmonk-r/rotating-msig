import { TxService, type TreeFile } from "@rotating-msig/core";
import type { AddressSource } from "@rotating-msig/keys";
import { createPublicClient, fallback, http, type Chain, type PublicClient } from "viem";

import { chainFor, DEFAULT_EXECUTION_RPC, DEFAULT_RPCS } from "./networks.js";
import { SignerSession } from "./session.js";

export { chainFor, CHAINS, DEFAULT_EXECUTION_RPC, DEFAULT_RPCS } from "./networks.js";

export interface SessionConfig {
  tree: TreeFile;
  /** Read RPC; the default public RPCs for the chain when absent. */
  rpc?: string;
  executionRpc?: string;
  /** Overrides the Safe Transaction Service base URL (tests and local demos). */
  txServiceUrl?: string;
  safeApiKey?: string;
}

/** Builds the session the CLI and the desktop app both run. */
export function createSession(config: SessionConfig, source: AddressSource): { session: SignerSession; chain: Chain; executionRpc: string } {
  const chain = chainFor(config.tree.chainId);
  const readUrls = config.rpc ? [config.rpc] : (DEFAULT_RPCS[config.tree.chainId] ?? []);
  if (readUrls.length === 0) throw new Error(`no RPC known for chain ${config.tree.chainId}; set one`);
  const executionRpc = config.executionRpc ?? DEFAULT_EXECUTION_RPC[config.tree.chainId] ?? readUrls[0]!;
  const session = new SignerSession({
    publicClient: createPublicClient({ chain, transport: fallback(readUrls.map((url) => http(url))) }) as PublicClient,
    chain,
    executionRpcUrl: executionRpc,
    txService: new TxService(config.tree.chainId, { baseUrl: config.txServiceUrl, apiKey: config.safeApiKey }),
    source,
    tree: config.tree,
    safe: config.tree.safe,
    gasFunding: true,
  });
  return { session, chain, executionRpc };
}
