import {
  assess,
  deploymentsFor,
  describeRevert,
  evaluate,
  execTransactionData,
  packSignatures,
  preValidatedSignature,
  readSafeState,
  safeTxTypedData,
  type Action,
  type Finding,
  type PendingTx,
  type SafeState,
  type TreeFile,
  type TxService,
  type Verdict,
} from "@rotating-msig/core";
import { resolveCurrentOwner, type AddressSource, type CurrentOwner } from "@rotating-msig/keys";
import { createWalletClient, http, type Address, type Chain, type Hex, type PublicClient } from "viem";

export interface SessionOptions {
  publicClient: PublicClient;
  chain: Chain;
  /** RPC used only to broadcast executions; should be private and revert-protected. */
  executionRpcUrl: string;
  txService: TxService;
  source: AddressSource;
  tree: TreeFile;
  safe: Address;
  /** MultiSendCallOnly the guard allows; defaults to the canonical deployment for the chain. */
  multiSendCallOnly?: Address;
}

export interface Me {
  slotId: number;
  index: number;
  address: Address;
  balance: string;
  staged: number;
  bufferSize: number;
  treeSize: number;
}

export interface StatusView {
  safe: Address;
  chainId: number;
  threshold: number;
  owners: Address[];
  nonce: string;
  balance: string;
  installed: boolean;
  me?: Me;
  meError?: string;
  findings: Finding[];
}

export interface QueueItem {
  safeTxHash: Hex;
  nonce: string;
  actions: Action[];
  confirmations: { owner: Address; signatureType: string; counts: boolean }[];
  verdict: Pick<Verdict, "action" | "blockers" | "warnings">;
  submissionDate?: string;
}

export interface ExecuteResult {
  transactionHash: Hex;
  gasUsed: string;
  rotated: { slotId: number; from: Address; to: Address }[];
}

/** Ether amount as a decimal string, for JSON. */
const wei = (value: bigint) => value.toString();

/**
 * One signer's view of one Safe. Holds the key source; every action re-reads chain and queue state and re-runs the
 * rules engine, so nothing the UI sends can bypass a rule.
 */
export class SignerSession {
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SessionOptions) {}

  private async snapshot(): Promise<{ state: SafeState; owner?: CurrentOwner; ownerError?: string }> {
    const state = await readSafeState(this.options.publicClient, this.options.safe);
    try {
      return { state, owner: await resolveCurrentOwner(this.options.source, this.options.tree, state) };
    } catch (error) {
      return { state, ownerError: (error as Error).message };
    }
  }

  async status(): Promise<StatusView> {
    const { state, owner, ownerError } = await this.snapshot();
    let me: Me | undefined;
    if (owner) {
      const balance = await this.options.publicClient.getBalance({ address: owner.account.address });
      me = {
        slotId: owner.slot.slotId,
        index: owner.index,
        address: owner.account.address,
        balance: wei(balance),
        staged: owner.slot.staged.length,
        bufferSize: state.bufferSize,
        treeSize: owner.slot.size,
      };
    }
    return {
      safe: state.safe,
      chainId: state.chainId,
      threshold: state.threshold,
      owners: state.owners,
      nonce: state.nonce.toString(),
      balance: wei(state.balance),
      installed: state.installed,
      me,
      meError: ownerError,
      findings: assess(state),
    };
  }

  async queue(): Promise<QueueItem[]> {
    const { state, owner } = await this.snapshot();
    const pending = await this.options.txService.pending(this.options.safe, state.nonce);
    return pending.map((tx) => {
      const verdict = owner ? this.evaluate(state, tx, pending, owner) : undefined;
      return {
        safeTxHash: tx.safeTxHash,
        nonce: tx.tx.nonce.toString(),
        actions: verdict?.actions ?? [],
        confirmations: tx.confirmations.map((c) => ({
          owner: c.owner,
          signatureType: c.signatureType,
          counts: verdict?.validConfirmations.some((v) => v.owner === c.owner) ?? false,
        })),
        verdict: verdict
          ? { action: verdict.action, blockers: verdict.blockers, warnings: verdict.warnings }
          : { action: "none", blockers: ["your key could not be resolved; see status"], warnings: [] },
        submissionDate: tx.submissionDate,
      };
    });
  }

  /** Signs the transaction's SafeTx hash with the current owner key and posts the confirmation. */
  confirm(safeTxHash: Hex): Promise<{ owner: Address }> {
    return this.exclusive(async () => {
      const { state, owner, pending, tx } = await this.load(safeTxHash);
      const verdict = this.evaluate(state, tx, pending, owner);
      if (verdict.action !== "confirm") throw new Error(`cannot confirm: ${[...verdict.blockers, `allowed action is ${verdict.action}`].join("; ")}`);
      const signature = await owner.account.signTypedData(safeTxTypedData(state.chainId, state.safe, tx.tx));
      await this.options.txService.confirm(tx.safeTxHash, signature);
      return { owner: owner.account.address };
    });
  }

  /** Executes as the last signer: simulate, then broadcast through the execution RPC, then report the rotation. */
  execute(safeTxHash: Hex): Promise<ExecuteResult> {
    return this.exclusive(async () => {
      const { publicClient, chain, executionRpcUrl } = this.options;
      const { state, owner, pending, tx } = await this.load(safeTxHash);
      const verdict = this.evaluate(state, tx, pending, owner);
      if (verdict.action !== "execute" || !verdict.executeWith) {
        throw new Error(`cannot execute: ${[...verdict.blockers, `allowed action is ${verdict.action}`].join("; ")}`);
      }

      const signatures = packSignatures([...verdict.executeWith, preValidatedSignature(owner.account.address)]);
      const data = execTransactionData(tx.tx, signatures);
      const from = owner.account.address;

      let gas: bigint;
      try {
        await publicClient.call({ account: from, to: state.safe, data });
        gas = await publicClient.estimateGas({ account: from, to: state.safe, data });
      } catch (error) {
        throw new Error(`simulation failed, nothing was sent: ${describeRevert(error) ?? (error as Error).message}`);
      }

      const wallet = createWalletClient({ account: owner.account, chain, transport: http(executionRpcUrl) });
      const hash = await wallet.sendTransaction({ to: state.safe, data, gas: (gas * 12n) / 10n, chain });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted on-chain; force-rotate its signers`);

      const after = await readSafeState(publicClient, state.safe);
      const rotated = state.slots
        .map((slot) => ({ slotId: slot.slotId, from: slot.owner, to: after.slots.find((s) => s.slotId === slot.slotId)?.owner ?? slot.owner }))
        .filter((change) => change.from !== change.to);
      return { transactionHash: hash, gasUsed: receipt.gasUsed.toString(), rotated };
    });
  }

  private evaluate(state: SafeState, tx: PendingTx, queue: readonly PendingTx[], owner: CurrentOwner): Verdict {
    return evaluate({
      state,
      pending: tx,
      queue,
      me: owner.account.address,
      decode: {
        safe: state.safe,
        guard: state.guard,
        multiSendCallOnly: this.options.multiSendCallOnly ?? deploymentsFor(state.chainId).multiSendCallOnly,
      },
    });
  }

  private async load(safeTxHash: Hex) {
    const { state, owner, ownerError } = await this.snapshot();
    if (!owner) throw new Error(ownerError ?? "your current owner key could not be resolved");
    const pending = await this.options.txService.pending(this.options.safe, state.nonce);
    const tx = pending.find((candidate) => candidate.safeTxHash.toLowerCase() === safeTxHash.toLowerCase());
    if (!tx) throw new Error(`transaction ${safeTxHash} is not pending for this Safe`);
    return { state, owner, pending, tx };
  }

  /** Runs one signing action at a time, so two clicks can never race. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.busy.then(task, task);
    this.busy = run.catch(() => undefined);
    return run;
  }
}
