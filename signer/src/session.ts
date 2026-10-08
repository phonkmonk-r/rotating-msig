import {
  assess,
  buildProposal,
  deploymentsFor,
  describeRevert,
  evaluate,
  execTransactionData,
  packSignatures,
  preValidatedSignature,
  readSafeState,
  plainSafeTx,
  safeTxHash,
  safeTxTypedData,
  type Action,
  type Finding,
  type PendingTx,
  type ProposalInput,
  type SafeState,
  type TreeFile,
  type TxService,
  type Verdict,
} from "@rotating-msig/core";
import { OPERATOR_ACCOUNT, resolveCurrentOwner, type AddressSource, type CurrentOwner } from "@rotating-msig/keys";
import {
  createWalletClient,
  custom,
  erc20Abi,
  formatEther,
  getAddress,
  http,
  isAddress,
  numberToHex,
  toEventSelector,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";

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
  /** How long to wait for an execution to be included before reporting it as stuck. */
  executionTimeoutMs?: number;
  /**
   * Pays executions from the operator account (the seed's first account) just in time: before executing, it sends the
   * current owner key exactly the gas it needs; once the execution is mined, the key's remainder is swept back. Rotation
   * keys then hold no ETH between uses, so nothing is stranded when they rotate out.
   */
  gasFunding?: boolean;
}

export const DEFAULT_EXECUTION_TIMEOUT_MS = 180_000;

/** Gas for a plain ETH transfer, used by the sweep. */
const TRANSFER_GAS = 21_000n;
/** An execution's gas allowance for warning when the operator account runs low. */
const EXECUTION_GAS_ALLOWANCE = 1_000_000n;
/** How long the sweep keeps waiting for an execution that is not mined yet. */
const SWEEP_WATCH_MS = 30 * 60_000;
const SWEEP_POLL_MS = 3_000;

export interface Me {
  slotId: number;
  index: number;
  address: Address;
  balance: string;
  staged: number;
  bufferSize: number;
  treeSize: number;
  /** With gas funding: the account that pays for executions. */
  operator?: { address: Address; balance: string };
}

/** One slot as every signer sees it. */
export interface SignerView {
  slotId: number;
  owner: Address;
  index: number;
  treeSize: number;
  staged: number;
  /** Tree addresses never used or staged. */
  unused: number;
  balance: string;
  isMe: boolean;
  /** Nonces of pending transactions this owner has confirmed: their key is exposed until those execute. */
  confirmedNonces: string[];
}

export interface StatusView {
  safe: Address;
  chainId: number;
  chainName: string;
  /** Host of the execution RPC only: full URLs often carry API keys. */
  executionHost: string;
  threshold: number;
  owners: Address[];
  nonce: string;
  balance: string;
  installed: boolean;
  /** Executions are funded from the operator account, so rotation keys normally hold no ETH. */
  gasFunding: boolean;
  me?: Me;
  meError?: string;
  findings: Finding[];
  signers: SignerView[];
  /** Set when the Transaction Service could not be read; confirmations are then unknown. */
  queueError?: string;
}

export interface QueueItem {
  safeTxHash: Hex;
  nonce: string;
  actions: Action[];
  confirmations: { owner: Address; signatureType: string; counts: boolean }[];
  verdict: Pick<Verdict, "action" | "blockers" | "warnings">;
  submissionDate?: string;
}

export interface ProposalResult {
  safeTxHash: Hex;
  nonce: string;
  actions: Action[];
  warnings: string[];
  /** False for a preview: nothing was signed or sent. */
  proposed: boolean;
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  /** The Safe's balance, in base units. */
  safeBalance: string;
}

/** An execution this signer sent, as tracked until it is included or reported stuck. */
export interface Execution {
  safeTxHash: Hex;
  transactionHash: Hex;
  /** Host of the RPC it was sent through. */
  sentThrough: string;
  sentAt: string;
  status: "pending" | "success" | "reverted" | "stuck";
  gasUsed?: string;
  rotated?: { slotId: number; from: Address; to: Address }[];
  message?: string;
  /** The operator's transfer to the executing key, when it needed gas. */
  funding?: { transactionHash: Hex; amount: string };
  /** Returning the executing key's remainder to the operator account once the execution is mined. */
  sweep?: { status: "waiting" | "sent" | "nothing" | "failed"; transactionHash?: Hex; amount?: string; message?: string };
}

/** Where a proposal stands, read from the Safe's nonce and its execution events. */
export interface ProposalStatus {
  /** `replaced`: another transaction used the proposal's nonce. */
  status: "pending" | "executed" | "failed" | "replaced";
  transactionHash?: Hex;
  /** The execution's receipt as the RPC returned it. */
  receipt?: Record<string, unknown>;
}

const EXECUTION_SUCCESS = toEventSelector("ExecutionSuccess(bytes32,uint256)");
const EXECUTION_FAILURE = toEventSelector("ExecutionFailure(bytes32,uint256)");

/** Ether amount as a decimal string, for JSON. */
const wei = (value: bigint) => value.toString();

/**
 * One signer's view of one Safe. Holds the key source; every action re-reads chain and queue state and re-runs the
 * rules engine, so nothing the UI sends can bypass a rule.
 */
export class SignerSession {
  private busy: Promise<unknown> = Promise.resolve();
  private readonly executions = new Map<string, { record: Execution; before: SafeState; sentAtMs: number; account: LocalAccount }>();

  constructor(private readonly options: SessionOptions) {}

  get safe(): Address {
    return this.options.safe;
  }

  get chainId(): number {
    return this.options.chain.id;
  }

  /** Forwards a read-only JSON-RPC request to the read RPC. Callers decide which methods are allowed. */
  rpc(method: string, params: unknown[]): Promise<unknown> {
    return this.options.publicClient.request({ method, params } as never);
  }

  async blockNumber(): Promise<bigint> {
    return this.options.publicClient.getBlockNumber({ cacheTime: 0 });
  }

  /**
   * Whether a proposal was executed: pending while the Safe's nonce has not passed it, then found by its
   * ExecutionSuccess or ExecutionFailure event from `fromBlock` on (the block before it was proposed).
   */
  async proposalStatus(safeTxHash: Hex, nonce: bigint, fromBlock: bigint): Promise<ProposalStatus> {
    const { publicClient, safe } = this.options;
    const state = await readSafeState(publicClient, safe);
    if (state.nonce <= nonce) return { status: "pending" };
    const logs = (await this.rpc("eth_getLogs", [
      { address: safe, fromBlock: numberToHex(fromBlock), toBlock: "latest", topics: [[EXECUTION_SUCCESS, EXECUTION_FAILURE], safeTxHash] },
    ])) as { topics: Hex[]; transactionHash: Hex }[];
    const log = logs[0];
    if (!log) return { status: "replaced" };
    const receipt = (await this.rpc("eth_getTransactionReceipt", [log.transactionHash])) as Record<string, unknown>;
    return { status: log.topics[0] === EXECUTION_SUCCESS ? "executed" : "failed", transactionHash: log.transactionHash, receipt };
  }

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
    let pending: PendingTx[] = [];
    let queueError: string | undefined;
    try {
      pending = await this.options.txService.pending(this.options.safe, state.nonce);
    } catch (error) {
      queueError = (error as Error).message;
    }
    let me: Me | undefined;
    const findings = assess(state, this.options.gasFunding ? { minOwnerGas: 0n } : {});
    if (owner) {
      const balance = await this.options.publicClient.getBalance({ address: owner.account.address });
      let operator: Me["operator"];
      if (this.options.gasFunding) {
        const address = await this.options.source.address(OPERATOR_ACCOUNT);
        const [operatorBalance, gasPrice] = await Promise.all([this.options.publicClient.getBalance({ address }), this.options.publicClient.getGasPrice()]);
        operator = { address, balance: wei(operatorBalance) };
        if (operatorBalance < EXECUTION_GAS_ALLOWANCE * gasPrice * 2n) {
          findings.push({ severity: "warning", slotId: owner.slot.slotId, message: "Your gas account is low: executions are paid from it" });
        }
      }
      me = {
        operator,
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
      chainName: this.options.chain.name,
      executionHost: new URL(this.options.executionRpcUrl).host,
      threshold: state.threshold,
      owners: state.owners,
      nonce: state.nonce.toString(),
      balance: wei(state.balance),
      installed: state.installed,
      gasFunding: this.options.gasFunding === true,
      me,
      meError: ownerError,
      findings,
      signers: state.slots.map((slot) => ({
          slotId: slot.slotId,
          owner: slot.owner,
          index: slot.ownerIndex,
          treeSize: slot.size,
          staged: slot.staged.length,
          unused: slot.unstaged,
          balance: wei(slot.ownerBalance),
          isMe: owner?.slot.slotId === slot.slotId,
          confirmedNonces: pending
            .filter((tx) => tx.confirmations.some((c) => c.owner.toLowerCase() === slot.owner.toLowerCase() && (c.signatureType === "EOA" || c.signatureType === "ETH_SIGN")))
            .map((tx) => tx.tx.nonce.toString()),
      })),
      queueError,
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

  /**
   * Proposes a transaction at the Safe's next nonce, signed with the current owner key; the signature is the
   * proposer's confirmation. With `preview`, only checks and describes it. Refuses while another transaction is
   * pending, since confirmations spread over several transactions can add up to a threshold of exposed keys.
   */
  propose(input: ProposalInput, preview = false): Promise<ProposalResult> {
    const run = async (): Promise<ProposalResult> => {
      const { state, owner, ownerError } = await this.snapshot();
      if (!owner) throw new Error(ownerError ?? "your current owner key could not be resolved");
      if (state.threshold < 2) throw new Error("proposing needs a threshold of at least 2: with 1, the executor signs alone");
      const queue = await this.options.txService.pending(this.options.safe, state.nonce);
      if (queue.length > 0) throw new Error(`transaction #${queue[0]!.tx.nonce} is still pending: execute it or replace it in Safe{Wallet} first`);

      const multiSendCallOnly = this.options.multiSendCallOnly ?? deploymentsFor(state.chainId).multiSendCallOnly;
      const call = buildProposal(input, { safe: state.safe, guard: state.guard, multiSendCallOnly });
      if (input.kind === "eth" && state.balance < call.value) throw new Error("the Safe does not hold that much ETH");
      if (input.kind === "calls") {
        const total = input.calls.reduce((sum, item) => sum + (item.value && item.value !== "0x" ? BigInt(item.value) : 0n), 0n);
        if (state.balance < total) throw new Error("the Safe does not hold enough ETH for this request");
      }
      if (input.kind === "erc20") {
        const balance = await this.options.publicClient.readContract({ address: call.to, abi: erc20Abi, functionName: "balanceOf", args: [state.safe] });
        if (balance < BigInt(input.amount)) throw new Error("the Safe does not hold that many tokens");
      }
      if (input.kind === "force-rotate") {
        for (const slotId of input.slotIds) {
          const slot = state.slots.find((candidate) => candidate.slotId === slotId);
          if (!slot) throw new Error(`slot ${slotId} has no owner`);
          if (slot.staged.length === 0) throw new Error(`slot ${slotId} has no staged key to rotate to`);
        }
      }

      const tx = plainSafeTx({ ...call, nonce: state.nonce });
      const hash = safeTxHash(state.chainId, state.safe, tx);
      const verdict = this.evaluate(state, { safeTxHash: hash, tx, confirmations: [] }, [], owner);
      if (verdict.action !== "confirm") throw new Error(`cannot propose: ${verdict.blockers.join("; ")}`);

      const result = { safeTxHash: hash, nonce: tx.nonce.toString(), actions: verdict.actions, warnings: verdict.warnings, proposed: false };
      if (preview) return result;
      const signature = await owner.account.signTypedData(safeTxTypedData(state.chainId, state.safe, tx));
      await this.options.txService.propose(state.safe, tx, owner.account.address, signature);
      return { ...result, proposed: true };
    };
    return preview ? run() : this.exclusive(run);
  }

  /** Symbol, decimals and the Safe's balance for an ERC-20 token, so amounts can be entered in whole tokens. */
  async tokenInfo(token: string): Promise<TokenInfo> {
    if (!isAddress(token, { strict: false })) throw new Error("not a token address");
    const address = getAddress(token);
    const { publicClient, safe } = this.options;
    try {
      const [symbol, decimals, balance] = await Promise.all([
        publicClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
        publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
        publicClient.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
      ]);
      return { address, symbol, decimals, safeBalance: balance.toString() };
    } catch {
      throw new Error("no ERC-20 token at this address on this network");
    }
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

  /**
   * Executes as the last signer: simulate, then send through the execution RPC and return at once with the
   * transaction hash. Inclusion is tracked separately (`execution`), so a private RPC that holds the transaction can
   * never leave the signer waiting silently.
   */
  execute(safeTxHash: Hex): Promise<Execution> {
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

      const gasLimit = (gas * 12n) / 10n;
      const fees = await publicClient.estimateFeesPerGas();
      const funding = this.options.gasFunding ? await this.fund(from, (gasLimit + TRANSFER_GAS) * fees.maxFeePerGas) : undefined;

      const wallet = createWalletClient({ account: owner.account, chain, transport: http(executionRpcUrl) });
      const transactionHash = await wallet.sendTransaction({
        to: state.safe,
        data,
        gas: gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        chain,
      });
      const record: Execution = {
        safeTxHash: tx.safeTxHash,
        transactionHash,
        sentThrough: new URL(executionRpcUrl).host,
        sentAt: new Date().toISOString(),
        status: "pending",
        funding,
        sweep: this.options.gasFunding ? { status: "waiting" } : undefined,
      };
      this.executions.set(transactionHash.toLowerCase(), { record, before: state, sentAtMs: Date.now(), account: owner.account });
      if (this.options.gasFunding) void this.sweepWhenMined(transactionHash);
      return record;
    });
  }

  /** Tops `key` up from the operator account to `needed` wei, waiting until the transfer is mined. */
  private async fund(key: Address, needed: bigint): Promise<Execution["funding"]> {
    const { publicClient, chain, source } = this.options;
    const balance = await publicClient.getBalance({ address: key });
    if (balance >= needed) return undefined;
    const amount = needed - balance;
    const operator = await source.signer(OPERATOR_ACCOUNT);
    const [operatorBalance, gasPrice] = await Promise.all([publicClient.getBalance({ address: operator.address }), publicClient.getGasPrice()]);
    const required = amount + TRANSFER_GAS * gasPrice * 2n;
    if (operatorBalance < required) {
      throw new Error(`your gas account ${operator.address} needs about ${formatEther(required)} ETH for this execution and holds ${formatEther(operatorBalance)}; nothing was sent`);
    }
    const wallet = createWalletClient({ account: operator, chain, transport: custom(publicClient) });
    const transactionHash = await wallet.sendTransaction({ to: key, value: amount, chain });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== "success") throw new Error(`funding the execution failed (${transactionHash}); nothing else was sent`);
    return { transactionHash, amount: amount.toString() };
  }

  /** Waits until the execution is mined (or given up on), then returns the key's remaining ETH to the operator. */
  private async sweepWhenMined(transactionHash: Hex): Promise<void> {
    const entry = this.executions.get(transactionHash.toLowerCase())!;
    const sweep = entry.record.sweep!;
    try {
      for (;;) {
        const record = await this.execution(transactionHash);
        if (record.status === "success" || record.status === "reverted") break;
        if (Date.now() - entry.sentAtMs > SWEEP_WATCH_MS) {
          sweep.status = "failed";
          sweep.message = "The execution was not mined; the key keeps its gas for the next attempt.";
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, SWEEP_POLL_MS));
      }
      await this.sweep(entry.account, sweep);
    } catch (error) {
      sweep.status = "failed";
      sweep.message = (error as Error).message;
    }
  }

  /**
   * Sends everything `key` holds to the operator account. A legacy transaction at a fixed gas price costs exactly
   * 21,000 × price, so the key is left at zero.
   */
  private async sweep(key: LocalAccount, sweep: NonNullable<Execution["sweep"]>): Promise<void> {
    const { publicClient, chain, source } = this.options;
    const [balance, gasPrice, operator] = await Promise.all([
      publicClient.getBalance({ address: key.address }),
      publicClient.getGasPrice().then((price) => (price * 12n) / 10n),
      source.address(OPERATOR_ACCOUNT),
    ]);
    const cost = TRANSFER_GAS * gasPrice;
    if (balance <= cost) {
      sweep.status = "nothing";
      return;
    }
    const wallet = createWalletClient({ account: key, chain, transport: custom(publicClient) });
    const amount = balance - cost;
    const hash = await wallet.sendTransaction({ to: operator, value: amount, gas: TRANSFER_GAS, gasPrice, type: "legacy", chain });
    Object.assign(sweep, { status: "sent", transactionHash: hash, amount: amount.toString() });
  }

  /** Current status of an execution this signer sent. */
  async execution(transactionHash: Hex): Promise<Execution> {
    const entry = this.executions.get(transactionHash.toLowerCase());
    if (!entry) throw new Error(`no execution ${transactionHash} was sent by this signer`);
    const { record, before, sentAtMs } = entry;
    if (record.status === "success" || record.status === "reverted") return record;

    const receipt = await this.options.publicClient.getTransactionReceipt({ hash: record.transactionHash }).catch(() => undefined);
    if (receipt) {
      record.gasUsed = receipt.gasUsed.toString();
      if (receipt.status === "success") {
        const after = await readSafeState(this.options.publicClient, before.safe);
        record.status = "success";
        record.rotated = before.slots
          .map((slot) => ({ slotId: slot.slotId, from: slot.owner, to: after.slots.find((s) => s.slotId === slot.slotId)?.owner ?? slot.owner }))
          .filter((change) => change.from !== change.to);
        record.message = undefined;
      } else {
        record.status = "reverted";
        record.message = "The transaction was mined but reverted: its signatures are public and nobody rotated. Refill buffers and force-rotate those signers now.";
      }
      return record;
    }

    const timeout = this.options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    if (Date.now() - sentAtMs > timeout) {
      record.status = "stuck";
      record.message =
        `Not included after ${Math.round(timeout / 60_000) || 1} minute(s) through ${record.sentThrough}; it may still land. ` +
        "To resend through another RPC, restart the signer with --execution-rpc and execute again: both use your account's next nonce, so only one can ever be mined.";
    }
    return record;
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
