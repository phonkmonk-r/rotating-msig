import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import {
  bytesToHex,
  concatHex,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  isAddress,
  isAddressEqual,
  keccak256,
  pad,
  type Address,
  type Hex,
} from "viem";

import { safeAbi } from "./abi/safe.js";
import { ZERO_ADDRESS, type SafeDeployments } from "./addresses.js";
import { batch, installCalls, safeCalls, type MetaTx } from "./calls.js";
import { INSTALL_STAGE_COUNT, type LoadedTree } from "./setup.js";
import { LEAF_TYPES, leafValue, slotConfig, stageEntries, type SlotConfig, type StageEntry } from "./tree.js";

export const safeProxyFactoryAbi = [
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
  { type: "function", name: "proxyCreationCode", stateMutability: "pure", inputs: [], outputs: [{ name: "", type: "bytes" }] },
] as const;

const INVITE_PREFIX = "rotation-invite:";
const PACKAGE_PREFIX = "rotation-slot:";

/**
 * Everything co-signers need to prepare their slot of a Safe that is not deployed yet. The Safe is created with the
 * signers' operator accounts as owners and threshold 1, so the coordinator can install the guard right after; the
 * install swaps every owner for its slot's first tree key and sets `threshold`. `safe` is the predicted address,
 * which each signer recomputes from the rest before trusting it.
 */
export interface SafeInvite {
  v: 1;
  chainId: number;
  /** Operator accounts in slot order: slot `i` starts as `owners[i]`. */
  owners: Address[];
  threshold: number;
  /** Decimal. */
  saltNonce: string;
  safe: Address;
}

/** One signer's slot, prepared from their seed: what the install needs, with proofs against their root. */
export interface SlotPackage {
  v: 1;
  chainId: number;
  safe: Address;
  slotId: number;
  /** The operator account this slot replaces. */
  operator: Address;
  base: number;
  config: SlotConfig;
  stage: StageEntry[];
}

function encode(prefix: string, value: unknown): string {
  return prefix + Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode<T>(prefix: string, code: string, what: string): T {
  const text = code.trim();
  if (!text.startsWith(prefix)) throw new Error(`this is not ${what}`);
  try {
    return JSON.parse(Buffer.from(text.slice(prefix.length), "base64url").toString("utf8")) as T;
  } catch {
    throw new Error(`${what} is damaged; copy it again`);
  }
}

export const encodeInvite = (invite: SafeInvite) => encode(INVITE_PREFIX, invite);
export const encodePackage = (pkg: SlotPackage) => encode(PACKAGE_PREFIX, pkg);

/** Parses an invite and checks its shape; `verifyInvite` checks the address. */
export function decodeInvite(code: string): SafeInvite {
  const raw = decode<SafeInvite>(INVITE_PREFIX, code, "an invite");
  if (raw.v !== 1) throw new Error("this invite needs a newer version of the app");
  return { ...raw, owners: raw.owners.map((owner) => getAddress(owner)), safe: getAddress(raw.safe) };
}

export function decodePackage(code: string): SlotPackage {
  const raw = decode<SlotPackage>(PACKAGE_PREFIX, code, "a slot package");
  if (raw.v !== 1) throw new Error("this slot package needs a newer version of the app");
  return raw;
}

/** `Safe.setup` arguments for a new Safe: the operators as owners, threshold 1, Safe{Wallet}'s fallback handler. */
export function safeInitializer(owners: readonly Address[], deployments: SafeDeployments): Hex {
  return encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [owners, 1n, ZERO_ADDRESS, "0x", deployments.fallbackHandler, ZERO_ADDRESS, 0n, ZERO_ADDRESS],
  });
}

/** The CREATE2 address `SafeProxyFactory.createProxyWithNonce` deploys to. */
export function predictSafeAddress(owners: readonly Address[], saltNonce: bigint, deployments: SafeDeployments, proxyCreationCode: Hex): Address {
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(safeInitializer(owners, deployments)), saltNonce]));
  const bytecode = concatHex([proxyCreationCode, pad(deployments.creationSingleton, { size: 32 })]);
  return getContractAddress({ opcode: "CREATE2", from: deployments.safeProxyFactory, salt, bytecode });
}

/** The deployment transaction, sent by any account. */
export function creationCall(invite: SafeInvite, deployments: SafeDeployments): { to: Address; data: Hex } {
  return {
    to: deployments.safeProxyFactory,
    data: encodeFunctionData({
      abi: safeProxyFactoryAbi,
      functionName: "createProxyWithNonce",
      args: [deployments.creationSingleton, safeInitializer(invite.owners, deployments), BigInt(invite.saltNonce)],
    }),
  };
}

function checkSigners(owners: readonly string[], threshold: number): string[] {
  const errors: string[] = [];
  if (owners.length === 0) errors.push("add at least one signer");
  const seen = new Set<string>();
  for (const owner of owners) {
    if (!isAddress(owner, { strict: false })) {
      errors.push(`${owner || "(empty)"} is not an address`);
      continue;
    }
    if (isAddressEqual(owner, ZERO_ADDRESS)) errors.push("the zero address cannot be a signer");
    if (seen.has(owner.toLowerCase())) errors.push(`${getAddress(owner)} is listed twice`);
    seen.add(owner.toLowerCase());
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) errors.push(`threshold must be between 1 and ${owners.length}`);
  return errors;
}

/** A new invite with a random salt. `owners` are the signers' operator accounts in slot order. */
export function createInvite(params: { chainId: number; owners: readonly string[]; threshold: number; deployments: SafeDeployments; proxyCreationCode: Hex }): SafeInvite {
  const errors = checkSigners(params.owners, params.threshold);
  if (!params.deployments.rotationGuard) errors.push("the rotation guard is not deployed on this network yet");
  if (errors.length > 0) throw new Error(errors.join("; "));
  const owners = params.owners.map((owner) => getAddress(owner));
  const saltNonce = BigInt(bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(16))));
  return {
    v: 1,
    chainId: params.chainId,
    owners,
    threshold: params.threshold,
    saltNonce: saltNonce.toString(),
    safe: predictSafeAddress(owners, saltNonce, params.deployments, params.proxyCreationCode),
  };
}

/** Every reason not to trust an invite: bad signers, or an address that does not follow from the rest. */
export function verifyInvite(invite: SafeInvite, deployments: SafeDeployments, proxyCreationCode: Hex): string[] {
  const errors = checkSigners(invite.owners, invite.threshold);
  if (!/^\d+$/.test(invite.saltNonce)) errors.push("the invite's salt is not a number");
  if (!deployments.rotationGuard) errors.push("the rotation guard is not deployed on this network yet");
  if (errors.length > 0) return errors;
  const expected = predictSafeAddress(invite.owners, BigInt(invite.saltNonce), deployments, proxyCreationCode);
  if (!isAddressEqual(expected, invite.safe)) errors.push(`the invite names Safe ${invite.safe}, but its signers and salt give ${expected}`);
  return errors;
}

/** Builds this signer's package from their full tree for the invite's Safe. */
export function createSlotPackage(invite: SafeInvite, { file, tree }: LoadedTree): SlotPackage {
  return {
    v: 1,
    chainId: file.chainId,
    safe: file.safe,
    slotId: file.slotId,
    operator: invite.owners[file.slotId]!,
    base: file.base,
    config: slotConfig(tree, file, 0, ""),
    stage: stageEntries(tree, file, 1, INSTALL_STAGE_COUNT),
  };
}

/** Every reason a package must not go into the install, checked against the invite and the other packages. */
export function verifyPackages(invite: SafeInvite, packages: readonly SlotPackage[]): string[] {
  const errors: string[] = [];
  if (packages.length !== invite.owners.length) errors.push(`${packages.length} of ${invite.owners.length} slot packages`);
  const seenAddresses = new Map<string, number>();
  const seenRoots = new Map<string, number>();
  for (const [slot, pkg] of packages.entries()) {
    const label = `slot ${slot}`;
    if (!pkg) {
      errors.push(`${label}: missing`);
      continue;
    }
    if (pkg.slotId !== slot) errors.push(`${label}: the package is for slot ${pkg.slotId}`);
    if (pkg.chainId !== invite.chainId || !isAddressEqual(pkg.safe, invite.safe)) errors.push(`${label}: the package is for another Safe`);
    if (!isAddressEqual(pkg.operator, invite.owners[slot]!)) errors.push(`${label}: the package is from ${pkg.operator}, not ${invite.owners[slot]}`);
    const { config } = pkg;
    if (config.startIndex !== 0) errors.push(`${label}: the slot must start at index 0`);
    if (config.size < INSTALL_STAGE_COUNT + 1) errors.push(`${label}: the tree is too small`);
    if (pkg.stage.length !== INSTALL_STAGE_COUNT || pkg.stage.some((entry, i) => entry.index !== i + 1)) errors.push(`${label}: staged keys must be indexes 1 to ${INSTALL_STAGE_COUNT}`);

    const meta = { chainId: invite.chainId, safe: invite.safe, slotId: slot, base: pkg.base };
    for (const entry of [{ index: 0, owner: config.owner, proof: config.proof }, ...pkg.stage]) {
      let valid = false;
      try {
        valid = StandardMerkleTree.verify(config.root, [...LEAF_TYPES], leafValue(meta, entry.index, getAddress(entry.owner)), entry.proof);
      } catch {
        valid = false;
      }
      if (!valid) errors.push(`${label}: key ${entry.index} is not in the slot's tree`);
      const key = entry.owner.toLowerCase();
      if (invite.owners.some((owner) => isAddressEqual(owner, entry.owner))) errors.push(`${label}: key ${entry.index} is an operator account`);
      const other = seenAddresses.get(key);
      if (other !== undefined && other !== slot) errors.push(`${label}: key ${entry.index} also appears in slot ${other}`);
      seenAddresses.set(key, slot);
    }
    const previous = seenRoots.get(config.root);
    if (previous !== undefined) errors.push(`${label}: same tree as slot ${previous}`);
    seenRoots.set(config.root, slot);
  }
  return errors;
}

/**
 * The install for a Safe created from an invite: enable the guard, swap each operator for its slot's first key, stage
 * the next keys, and set the final threshold, as one MultiSendCallOnly batch.
 */
export function installFromPackages(invite: SafeInvite, packages: readonly SlotPackage[], deployments: SafeDeployments): MetaTx {
  const errors = verifyPackages(invite, packages);
  if (!deployments.rotationGuard) errors.push("the rotation guard is not deployed on this network yet");
  if (errors.length > 0) throw new Error(errors.join("; "));
  const calls = installCalls({
    safe: invite.safe,
    guard: deployments.rotationGuard!,
    oldOwners: invite.owners,
    configs: packages.map((pkg) => pkg.config),
    stage: packages.map((pkg) => pkg.stage),
    multiSendCallOnly: deployments.multiSendCallOnly,
  });
  if (invite.threshold !== 1) calls.push(safeCalls.changeThreshold(invite.safe, invite.threshold));
  return batch(calls, deployments.multiSendCallOnly);
}
