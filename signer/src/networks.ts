import { SEPOLIA_CHAIN_ID } from "@rotating-msig/core";
import type { Chain } from "viem";
import { mainnet, sepolia } from "viem/chains";

export const CHAINS: Record<number, Chain> = { 1: mainnet, [SEPOLIA_CHAIN_ID]: sepolia };

/** Public RPCs used when the signer has not set one; each list falls back in order. */
export const DEFAULT_RPCS: Record<number, string[]> = {
  1: ["https://ethereum-rpc.publicnode.com", "https://ethereum.reth.rs/rpc"],
  [SEPOLIA_CHAIN_ID]: ["https://ethereum-sepolia-rpc.publicnode.com", "https://11155111.rpc.thirdweb.com"],
};

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
