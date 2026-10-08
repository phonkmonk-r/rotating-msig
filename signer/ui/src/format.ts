export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function eth(wei: string, digits = 4): string {
  const value = Number(BigInt(wei)) / 1e18;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })} ETH`;
}

const EXPLORERS: Record<number, string> = { 1: "https://etherscan.io", 11155111: "https://sepolia.etherscan.io" };

export function explorer(chainId: number, kind: "tx" | "address", value: string): string | undefined {
  const base = EXPLORERS[chainId];
  return base ? `${base}/${kind}/${value}` : undefined;
}
