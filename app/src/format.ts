import { formatEther, type Address } from "viem";

export function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatEth(wei: bigint, digits = 4): string {
  const value = Number(formatEther(wei));
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })} ETH`;
}

export function chainName(chainId: number): string {
  return chainId === 1 ? "Ethereum" : `chain ${chainId}`;
}
