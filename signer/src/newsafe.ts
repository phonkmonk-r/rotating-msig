import {
  createInvite,
  creationCall,
  DEFAULT_TREE_SIZE,
  safeKeyPath,
  treeKeyPath,
  deploymentsFor,
  describeRevert,
  execTransactionData,
  installFromPackages,
  loadTreeFile,
  plainSafeTx,
  preValidatedSignature,
  readSafeState,
  safeProxyFactoryAbi,
  verifyInvite,
  createSlotPackage,
  packageMessage,
  verifySignedPackages,
  BRANCH_PATH_TEMPLATE,
  INSTALL_STAGE_COUNT,
  slotConfig,
  stageEntries,
  type SafeDeployments,
  type SafeInvite,
  type SlotPackage,
  type TreeFile,
} from "@rotating-msig/core";
import { generateTree, OPERATOR_ACCOUNT, type AddressSource } from "@rotating-msig/keys";
import { createWalletClient, custom, isAddressEqual, type Address, type Chain, type Hex, type PublicClient } from "viem";

import { keyCheckerFor } from "./create.js";
import type { KeyChecker } from "./keycheck.js";

export { OPERATOR_ACCOUNT };

export interface NewSafeContext {
  client: PublicClient;
  chain: Chain;
  /** Defaults to the canonical deployments for the chain; tests pass their own. */
  deployments?: SafeDeployments;
  /** Checks keys for earlier use; defaults to this network plus Ethereum mainnet. */
  keyChecker?: KeyChecker;
}

function checkerOf(context: NewSafeContext): KeyChecker {
  return context.keyChecker ?? keyCheckerFor(context.chain.id, context.client);
}

/** The first of six consecutive never-used keys in the tree: the slot's first owner and its five staged keys. */
async function freshStart(context: NewSafeContext, tree: TreeFile): Promise<number> {
  const start = await checkerOf(context).firstUnusedRun((index) => tree.addresses[index], 0, INSTALL_STAGE_COUNT + 1);
  if (start === undefined) throw new Error("could not find six unused keys in a row at the start of your key list; this seed's keys look used elsewhere");
  return start;
}

function deploymentsOf(context: NewSafeContext): SafeDeployments {
  return context.deployments ?? deploymentsFor(context.chain.id);
}

async function proxyCreationCode(context: NewSafeContext): Promise<Hex> {
  return context.client.readContract({ address: deploymentsOf(context).safeProxyFactory, abi: safeProxyFactoryAbi, functionName: "proxyCreationCode" });
}

/** Plans a new Safe. `owners` are every signer's operator account in slot order, the creator's included. */
export async function planSafe(context: NewSafeContext, owners: readonly string[], threshold: number): Promise<SafeInvite> {
  return createInvite({ chainId: context.chain.id, owners, threshold, deployments: deploymentsOf(context), proxyCreationCode: await proxyCreationCode(context) });
}

/** Checks an invite received from the creator and finds this signer's slot in it. */
export async function readInvite(context: NewSafeContext, source: AddressSource, invite: SafeInvite): Promise<{ slotId: number; operator: Address }> {
  if (invite.chainId !== context.chain.id) throw new Error(`the invite is for chain ${invite.chainId}`);
  const errors = verifyInvite(invite, deploymentsOf(context), await proxyCreationCode(context));
  if (errors.length > 0) throw new Error(errors.join("; "));
  const operator = await source.address(OPERATOR_ACCOUNT);
  const slotId = invite.owners.findIndex((owner) => isAddressEqual(owner, operator));
  if (slotId < 0) throw new Error(`your address ${operator} is not one of this Safe's signers; send it to the creator`);
  return { slotId, operator };
}

/**
 * Generates this signer's tree for the invite's Safe (at the default base for that Safe, so joining later finds it)
 * and the package the creator needs from them.
 */
export async function prepareSlot(
  context: NewSafeContext,
  source: AddressSource,
  invite: SafeInvite,
  onProgress?: (done: number, total: number) => void,
  size = DEFAULT_TREE_SIZE,
): Promise<{ tree: TreeFile; package: SlotPackage }> {
  const { slotId } = await readInvite(context, source, invite);
  const keyPath = safeKeyPath(invite.chainId, invite.safe);
  const meta = { chainId: invite.chainId, safe: invite.safe, slotId, base: keyPath.account, branch: keyPath.branch };
  const tree = await generateTree(source, meta, size, onProgress);
  const pkg = createSlotPackage(invite, loadTreeFile(JSON.stringify(tree)), await freshStart(context, tree));
  return { tree, package: await signPackage(source, pkg) };
}

/** A plain explanation when the gas account cannot pay for a creation transaction; other errors unchanged. */
function explainFunds(error: Error, gasAccount: Address): Error {
  if (!/insufficient funds/i.test(error.message)) return error;
  return new Error(`your gas account ${gasAccount} does not have enough ETH to pay for creating the Safe; send it some ETH and try again`);
}

/** Per-transaction gas cap (EIP-7825). */
const TRANSACTION_GAS_CAP = 16_777_216n;

export type CreationStage = "deploying" | "installing" | "done";

export interface CreationResult {
  safe: Address;
  deployTx?: Hex;
  installTx: Hex;
}

/**
 * Deploys the invite's Safe (unless it already exists) and installs the guard from every signer's package, both
 * sent by the creator's operator account. Before installing, checks the deployed Safe is exactly the invite's: its
 * operators as owners, threshold 1, nothing executed yet.
 */
export async function createSafe(
  context: NewSafeContext,
  source: AddressSource,
  invite: SafeInvite,
  packages: readonly SlotPackage[],
  onStage?: (stage: CreationStage) => void,
): Promise<CreationResult> {
  const { client, chain } = context;
  const deployments = deploymentsOf(context);
  const signatureErrors = await verifySignedPackages(invite, packages);
  if (signatureErrors.length > 0) throw new Error(signatureErrors.join("; "));
  // Builds the install once to check every package before anything is sent.
  installFromPackages(invite, packages, deployments);
  const operator = await source.signer(OPERATOR_ACCOUNT);
  if (!invite.owners.some((owner) => isAddressEqual(owner, operator.address))) throw new Error("only one of the Safe's signers can create it");
  const wallet = createWalletClient({ account: operator, chain, transport: custom(client) });

  let deployTx: Hex | undefined;
  if (!(await client.getCode({ address: invite.safe }))) {
    onStage?.("deploying");
    const call = creationCall(invite, deployments);
    try {
      await client.call({ account: operator.address, ...call });
    } catch (error) {
      throw new Error(`creating the Safe would fail: ${describeRevert(error)}`);
    }
    deployTx = await wallet.sendTransaction({ ...call, chain }).catch((error: Error) => {
      throw explainFunds(error, operator.address);
    });
    const receipt = await client.waitForTransactionReceipt({ hash: deployTx });
    if (receipt.status !== "success") throw new Error(`creating the Safe reverted (${deployTx})`);
  }

  const state = await readSafeState(client, invite.safe);
  const sameOwners = state.owners.length === invite.owners.length && invite.owners.every((owner) => state.owners.some((current) => isAddressEqual(current, owner)));
  if (!sameOwners || state.threshold !== 1 || state.nonce !== 0n) {
    throw new Error("the Safe at this address is not the one in the invite, or it was already used; start over with a new invite");
  }

  onStage?.("installing");
  // Staging every package's keys costs about 1M gas per signer under Sepolia's repricing, so a large Safe's install
  // would pass the per-transaction cap (15 signers at most with 5 keys each, measured 2026-10-09). Stage fewer keys
  // until the install fits; each signer's app stages the rest of its own slot once it joins.
  let data: Hex | undefined;
  let gas = 0n;
  let failure: unknown;
  for (const stagedPerSlot of [Infinity, 1, 0]) {
    // The install runs before the guard is active; with safeTxGas 0 a failing step reverts the whole call with its reason.
    const tx = plainSafeTx({ ...installFromPackages(invite, packages, deployments, stagedPerSlot), nonce: 0n }, 0n);
    const candidate = execTransactionData(tx, preValidatedSignature(operator.address).data);
    try {
      gas = await client.estimateGas({ account: operator.address, to: invite.safe, data: candidate });
    } catch (error) {
      failure = error;
      continue;
    }
    if (gas <= TRANSACTION_GAS_CAP) {
      data = candidate;
      break;
    }
  }
  if (!data) throw new Error(`installing would fail: ${describeRevert(failure) ?? "it does not fit in one transaction"}`);
  const limit = (gas * 12n) / 10n < TRANSACTION_GAS_CAP ? (gas * 12n) / 10n : TRANSACTION_GAS_CAP;
  const installTx = await wallet.sendTransaction({ to: invite.safe, data, gas: limit, chain }).catch((error: Error) => {
    throw explainFunds(error, operator.address);
  });
  const receipt = await client.waitForTransactionReceipt({ hash: installTx });
  if (receipt.status !== "success") throw new Error(`the install reverted (${installTx})`);

  const installed = await readSafeState(client, invite.safe);
  if (!installed.installed || installed.threshold !== invite.threshold) throw new Error(`the install was sent (${installTx}) but the Safe does not show it`);
  onStage?.("done");
  return { safe: invite.safe, deployTx, installTx };
}

/**
 * Prepares this signer to be added to an existing guarded Safe: generates their tree for the slot ID the guard hands
 * out next, and the package an existing signer proposes with. If two newcomers prepare at once, the second package
 * no longer fits once the first is added and must be prepared again.
 */
export async function prepareNewSlot(
  context: NewSafeContext,
  source: AddressSource,
  safe: Address,
  onProgress?: (done: number, total: number) => void,
  size = DEFAULT_TREE_SIZE,
): Promise<{ tree: TreeFile; package: SlotPackage }> {
  const state = await readSafeState(context.client, safe);
  if (!state.installed) throw new Error("this Safe does not have the rotation guard installed");
  const keyPath = safeKeyPath(context.chain.id, state.safe);
  const meta = { chainId: context.chain.id, safe: state.safe, slotId: state.slotCount, base: keyPath.account, branch: keyPath.branch };
  const firstPath = treeKeyPath({ ...meta, pathTemplate: BRANCH_PATH_TEMPLATE }, 0);
  const first = await source.address(firstPath.account, firstPath.index, firstPath.branch);
  if (state.owners.some((owner) => isAddressEqual(owner, first))) throw new Error("this seed is already a signer of this Safe");
  const tree = await generateTree(source, meta, size, onProgress);
  const loaded = loadTreeFile(JSON.stringify(tree));
  const start = await freshStart(context, tree);
  return {
    tree,
    package: await signPackage(source, {
      v: 1,
      chainId: tree.chainId,
      safe: tree.safe,
      slotId: tree.slotId,
      operator: await source.address(OPERATOR_ACCOUNT),
      base: tree.base,
      config: slotConfig(loaded.tree, tree, start, ""),
      stage: stageEntries(loaded.tree, tree, start + 1, INSTALL_STAGE_COUNT),
    }),
  };
}

/** Signs a package with the signer's operator account, so whoever receives it can check who made it. */
async function signPackage(source: AddressSource, pkg: SlotPackage): Promise<SlotPackage> {
  const operator = await source.signer(OPERATOR_ACCOUNT);
  return { ...pkg, signature: await operator.signMessage({ message: packageMessage(pkg) }) };
}
