import type { Address, Hex } from "viem";

export interface SafeDeployments {
  safeSingleton: Address;
  safeProxyFactory: Address;
  multiSendCallOnly: Address;
}

/**
 * Canonical Safe 1.5.0 deployments. Identical on mainnet and Sepolia (verified on-chain; the MultiSendCallOnly
 * bytecode matches byte for byte). Mainnet is covered by test/RotationGuard.fork.t.sol.
 */
const CANONICAL: SafeDeployments = {
  safeSingleton: "0xFf51A5898e281Db6DfC7855790607438dF2ca44b",
  safeProxyFactory: "0x14F2982D601c9458F93bd70B218933A6f8165e7b",
  multiSendCallOnly: "0xA83c336B20401Af773B6219BA5027174338D1836",
};

export const SEPOLIA_CHAIN_ID = 11155111;

/** Chains the project supports: mainnet for production, Sepolia for testing with Safe{Wallet}. */
export const DEPLOYMENTS: Readonly<Record<number, SafeDeployments>> = {
  1: CANONICAL,
  [SEPOLIA_CHAIN_ID]: CANONICAL,
};

export const MAINNET = { chainId: 1, ...CANONICAL } as const;

export function deploymentsFor(chainId: number): SafeDeployments {
  const deployments = DEPLOYMENTS[chainId];
  if (!deployments) throw new Error(`chain ${chainId} is not supported (mainnet and Sepolia only)`);
  return deployments;
}

/** Safe storage slot holding the transaction guard (GuardManager.GUARD_STORAGE_SLOT). */
export const GUARD_STORAGE_SLOT: Hex = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";

/** Safe storage slot holding the module guard (ModuleManager.MODULE_GUARD_STORAGE_SLOT). */
export const MODULE_GUARD_STORAGE_SLOT: Hex = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947";

/** Head of Safe's owner and module linked lists. */
export const SENTINEL: Address = "0x0000000000000000000000000000000000000001";

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
