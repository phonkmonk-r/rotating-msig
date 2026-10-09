# Rotating Multisig: Plan

Status: phases 1-3 done, phase 4 (Safe App) in progress. Last updated 2026-10-08.

## 0. Progress

| Phase | State | Where |
|---|---|---|
| 1. Spec and threat model | Done | this file |
| 2. Contracts | Done, pending external audit. Owner-to-slot mapping dropped for gas (2026-10-08); the guard with both security reviews' fixes (2026-10-08 and 2026-10-09) is deployed on Sepolia at `0xeE3b…D074` and new Safes use it | `src/`, `test/` (203 Solidity tests: unit, mainnet fork, SafeL2, fuzz, invariants, gas budgets, review PoCs; mutation-tested) |
| 3. Generator CLI | Done; defaults to the two-level key path (section 14); Ledger mode still needs one run on a real device | `generator/` (9 tests), cross-checked by `test/GeneratorVector.t.sol` |
| Demo | Done | `demo/run.sh`: Anvil mainnet fork, real Safe 1.5.0 contracts, 2-of-3 Safe rotating through generated trees |
| 4. Safe App and Cicada | v1 app done and tested on Sepolia (4a-4j, see section 12): Cicada desktop app with profiles (seed or Ledger), several Safes per profile, create and join Safes, propose, confirm, execute with live steps, gas account with just-in-time funding and sweep, self-staging, used-key and collision checks, signer management, transaction queue with simulation, dApp browser. Open: Ledger on a real device, renewing a slot's tree, packaging and code signing | `signer/`, `packages/`, `app/`, `deployments/sepolia.json`, `ARCHITECT.md` |
| 5. Keeper | Mostly superseded: each Cicada refills its own slot and pays its own gas (4j-4); a separate keeper is only needed for signers who never open the app | |
| 6-8 | Not started (audit, mainnet canary, EIP-1271 co-signer, option B) | |
| v2 | Planned, not scheduled (section 13) | |

Test counts (2026-10-08): `packages/core` 75, `packages/keys` 12, `generator` 9, `signer` 48, Solidity 186. `ARCHITECT.md` describes every package, file and function as built.

How to run everything:

- `forge test`: Solidity suite. Fork tests read `MAINNET_RPC_URL` from `.env` (gitignored) and skip without it.
- `cd generator && npm test`: TypeScript suite.
- `./demo/run.sh` (`KEEP=1` to leave Anvil running): end-to-end rotation on a local mainnet fork.
- `npm test` at the root: TypeScript suites for `packages/core` (including an integration test on a throwaway Anvil) and `generator/`.
- `npm run dev -w app`, then `http://localhost:5173/?rpc=http://127.0.0.1:8545&safe=<demo Safe>`: the Safe App dashboard against the demo.

Findings that changed the design during implementation:

- Re-committing an old tree at a low index would bring back already-exposed owners. Fixed with a per-root consumed-index mark (section 6). Found by the invariant suite.
- Without `to == safe`, any transaction carrying `setGuard(0)` calldata would bypass rotation. The check was already present; mutation testing showed no test pinned it, now one does.
- Measured rotation overhead is 65-82k gas per signer, not the 40-50k first estimated (section 6).
- Addresses depend only on the seed and account index, not on the Safe, so every Safe needs its own unused `--base` range (`generator/README.md`).
- Sepolia's hardfork of early October 2026 reprices contract and state creation. Deploying the guard costs 16,697,418 gas there (2.38M on mainnet today), 99.5% of the 2^24 per-transaction cap. Mainnet is likely to adopt the same rules, so the guard must not grow; any new on-chain feature (including the phase 7 co-signer) needs a size budget, and rotation gas must be re-measured under the new rules. The setup transaction for a 2-of-3 estimates at 4.4M gas on Sepolia.
- Under the same rules, a 2-of-3 transfer that rotates both signers used 649,233 gas on Sepolia, about 3.3x the 197k measured locally under Prague rules, so roughly 250-300k per rotated signer. The cost is dominated by the two storage entries each rotation creates (Safe's owner list entry and the guard's `ownerToSlot`). Done 2026-10-08: `ownerToSlot` is gone; the guard finds a signer's slot by scanning its slots (at most `MAX_SLOTS` = 32 IDs per configuration), removing one new storage entry per rotation. Locally the 2-of-3 overhead fell from 65.1k to 43.5k gas per signer (guarded transaction 197,375 to 154,185) and the contract from 10,662 to 10,280 bytes; Sepolia under repricing is still to be measured. Mutation-tested: 6 mutants of the new code, all killed (one redundant check was removed instead of kept as an equivalent mutant).

## 1. Background and threat model

The concern is that ECDSA over secp256k1 may break before Q-day, possibly within months, in the sense of fast private key recovery (for example one week on a large GPU cluster) from a public key. The defensive response proposed publicly is "bunker mode": keep funds behind addresses whose pubkeys have never been revealed, and move to a fresh address as soon as a key signs.

Key facts this design rests on:

- An Ethereum address is a hash of the pubkey. While a key has never signed anything, only the hash is public and the key is safe as long as the hash holds.
- The pubkey becomes public the first time the key signs anything: an on-chain tx, a Safe confirmation, an off-chain message (EIP-712, Permit, SIWE, Snapshot), or an on-chain `approveHash`.
- Exposure is binary. One signature reveals the full pubkey; further signatures give an attacker nothing more (deterministic RFC 6979 nonces rule out nonce-bias attacks). So "leaving more footprint" is not the issue, any footprint is.
- Consequently rotating keys on a timer (for example daily) adds nothing. A key that has not signed has nothing exposed. Rotation must happen per signature, not per day.

Why a multisig is the right container:

- The Safe address holds the funds and never moves. Only its owner set changes.
- An attacker needs a threshold of exposed keys, and must break each one inside the short window before it is rotated out.

Core rule: an owner whose pubkey has been exposed must stop being an owner as quickly as possible, and the system must make it impossible to forget.

## 2. Evolution of the design

1. Owner queue. Commit a list of future addresses on-chain (harmless, they are only hashes) and swap in a new one per tx. Lessons kept from this stage:
   - Swap, don't remove. Keep a normal owner set (for example 2-of-3) and swap, rather than starting with 100 owners at threshold 1.
   - Rotate exactly the owners who signed, not "one signer". Otherwise the exposed key stays live.
   - Enforce with a Guard, not just a multicall, so a forgotten swap reverts instead of silently leaving a key exposed.
   - One queue per signer slot, so each human's custody stays separate.
   - Avoid bricking: a Guard that wrongly reverts locks the Safe, so there must be an escape hatch.
   - Signatures the Guard cannot see (off-chain EIP-1271 messages, `approveHash`) burn the owner, who must be rotated in the next tx.
   - Cost: about 20k gas per stored address, so about 2M gas for 100.
2. Merkle root per signer (chosen). Each signer generates 10,000 addresses offline and only a 32-byte root is stored. Each rotation supplies the next address and its Merkle proof. Effectively unlimited rotations, a one-off setup cost of about 20k gas per slot, and the tree file can be regenerated from the seed.
3. Long term: a hash-based EIP-1271 co-signer (Winternitz/XMSS or SPHINCS+) so that breaking ECDSA alone gets an attacker nothing.

## 3. Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Safe version | 1.5.0 only |
| 2 | Chains | Ethereum mainnet only |
| 3 | Tree size | 10,000 addresses per signer (14 proof levels) |
| 4 | Language for generator and app | TypeScript, sharing one leaf and proof implementation |
| 5 | Staging model | Pre-staged on-chain: a per-slot ring buffer of 5 proven next owners, filled by a permissionless, strictly sequential `stage()`. A keeper we run refills it and tops up gas, funded from the Safe (section 7) |
| 6 | Signature collection | Option A: the public Safe Transaction Service, hardened by the executor rule in section 5 |

## 4. Components

| Component | Runs where | Responsibility |
|---|---|---|
| RotationGuard (one singleton contract, enabled as Guard, Module and Module Guard) | On-chain | Stores a Merkle root per signer slot, records who signed each tx, swaps out exactly those signers after execution, enforces the executor rule, reverts if anything is missing |
| Offline generator (CLI, TypeScript) | Each signer's own air-gapped machine or hardware wallet | Derives N fresh addresses from hardened paths and builds the signer's Merkle tree. Outputs the root and a tree file (addresses and proofs only, never pubkeys or xpubs) |
| Rotation Safe App | Inside Safe{Wallet} (iframe, Safe Apps SDK) | Setup wizard, slot dashboard, staging, exposure tracker, admin actions. Never touches seeds |
| Rotation signer (CLI first) | Each signer's machine, with their seed or Ledger | Confirms and executes queued Safe transactions with the signer's current owner key, so signers never manage per-rotation wallet accounts; enforces the executor rule, simulation and private RPC (section 10) |
| Keeper (TypeScript service we run; a Gelato Web3 Function is an alternative) | VPS or Gelato, non-owner EOA | Refills each slot's staging buffer from the IPFS tree file and tops up incoming owners with gas |
| Hash-based EIP-1271 co-signer (later phase) | On-chain | A second, non-ECDSA required owner |

## 5. Executor rule: the last signer must execute

### Rule

`execTransaction` may only be called by an owner whose signature in the tx is the pre-validated kind (v = 1 with r = `msgSender`). The other threshold-1 signers confirm through the Transaction Service as usual. No relayer, no third-party executor, no arbitrary address.

### Why it helps

- The executor never posts a confirmation. Their pubkey first appears when they broadcast the tx, and the same tx rotates them out.
- So at any time, the public confirmations for a single pending tx reveal at most threshold-1 pubkeys. An attacker who breaks every confirmed key still lacks one, and cannot execute because only an owner can execute and the remaining owner's key is still hidden.
- Every executed tx rotates all of its signers, including the executor.

### Limits and the hardening each needs

1. It does not stop an attacker who already holds threshold exposed keys. Such an attacker controls an owner EOA, can fund it with gas, and can execute from it. Exposure accumulates across:
   - concurrent pending txs (in 2-of-3, tx1 confirmed by A and tx2 confirmed by B means A and B are both exposed, which is a full threshold),
   - abandoned or replaced txs whose confirmers were never rotated,
   - off-chain messages and other signatures.

   The invariant that actually matters is: the number of exposed-but-not-rotated owners must always stay below the threshold. The Guard cannot see off-chain confirmations, so the app enforces it:
   - Policy: one pending tx at a time.
   - The exposure tracker computes the union of all pending confirmers and burned owners, warns at threshold-2 and blocks new confirmations through the app at threshold-1.
   - Abandoned txs trigger an immediate `forceRotate` of their confirmers.
2. The executor must not also have confirmed off-chain. If they did, their key was exposed early and the benefit is lost. The Guard can only see that the executor used v = 1. The app warns if the executor's confirmation exists in the Transaction Service.
3. A top-level revert is the most dangerous failure. If `execTransaction` reverts (for example the Guard reverts because a stage is missing) but the tx is still mined, all threshold pubkeys are now public in calldata and nothing was rotated. Requirements:
   - Always simulate (`eth_call`) before broadcasting.
   - The executor must broadcast through a private, revert-protected RPC (for example Flashbots Protect), which does not include reverting txs and also removes the few seconds of public mempool exposure.
   - If a reverted tx is ever mined anyway, every signer in it is burned and must be force-rotated at once.
4. Gas logistics. The executor's address needs ETH, but freshly rotated-in addresses hold none. Receiving ETH does not expose a pubkey, so:
   - The keeper (or the rotation tx itself, via a transfer appended by the app) tops up each staged next owner with a small gas amount.
   - Optionally use Safe's built-in refund (`gasPrice`, `refundReceiver`) to reimburse the executor.
   - Dust left in rotated-out EOAs is low value and can be swept later.
5. Lost liveness options. Relayers and automation services cannot execute; an owner must be online. Contract owners (the future 1271 co-signer) cannot be `msg.sender`, so the executor must always be an ECDSA owner.
6. On-chain `approveHash` is disallowed. A v = 1 signature from anyone other than `msgSender` relies on an earlier on-chain `approveHash` tx, which exposed that owner before this tx. The Guard rejects it.

## 6. On-chain design (RotationGuard)

### Storage, keyed by Safe address

Slot state lives under a per-Safe epoch, so `initialize` can start over cleanly:

- `slot -> { root, owner, size, nextStageIndex, head, count, buffer[5] }`. The first five fields pack into one storage slot. `nextIndex` (the next owner to rotate in) is derived as `nextStageIndex - count`.
- `buffer[slot]`: a ring buffer of up to 5 next owners, each already proven against the root. Storage slots are never zeroed, so refills after the first fill are non-zero to non-zero writes.
- No owner-to-slot mapping: a signer's slot is found by scanning the configuration's slot IDs (at most `MAX_SLOTS` = 32; `initialize` starts a new configuration). Removed slots have no owner, so they never match.
- `consumedUpTo[safe][root]`, outside the epoch: the first index of a root that never held an owner, recorded whenever a root leaves a slot (`setRoot`, `removeSlot`, re-`initialize`). Any later commitment of that root must start at or above it. This closes address reuse: without it, re-committing an old tree at a low index puts already-exposed addresses back in as owners (found by the invariant suite).
- The tree file's IPFS CID is emitted in `SlotConfigured`, not stored.

### Leaf format

`keccak256(keccak256(abi.encode(chainId, safe, slot, index, address)))`

- The double hash prevents second-preimage tricks on internal nodes.
- Binding `chainId` and `safe` prevents a proof from being reused under another Safe.

### Staging

Why stage at all: to rotate a signer, the Guard needs that slot's next address and its Merkle proof, but it only stores the root. The proof cannot be built into each proposal because the proposer does not know who will sign, and the signed Safe tx cannot be changed after confirmations start. Supplying proofs for every slot inside every tx was rejected because it forces every tx through our app and breaks the Safe UI's normal send, WalletConnect dapps and other Safe Apps. Pre-staging keeps the signed tx unchanged, so txs from any interface work.

`stage(safe, slot, entries[])`, with each entry `(index, address, proof)`, is permissionless. For each entry it checks:

- the proof against the slot's root,
- `index == nextStageIndex` (strictly sequential; a permissionless call that could skip would let a griefer stage index 9,999 and burn the tree; only the Safe itself may skip, through an admin function),
- `index < size`,
- `address` is not already an owner, not already in the buffer, and not the zero address, the sentinel or the Safe,
- the buffer is not full (capacity 5).

On rotation the Guard pops the head of each signer's buffer and swaps it in; no proof or external data is needed at execution time.

A stager cannot inject an address (it would fail the proof) or skip indexes, so the worst a malicious or broken stager can do is waste its own gas or fail to stage, which only delays txs until someone else stages. Anyone with the public tree file can stage.

`setRoot` clears the slot's buffer and sets `nextStageIndex` to the new start index.

### `checkTransaction` (receives `msgSender`)

1. Recompute the safeTxHash using `nonce - 1`, since Safe has already incremented the nonce.
2. Require `signatures` to be exactly `threshold * 65` bytes. Extra signatures would be public without being rotated, so they are rejected rather than parsed.
3. Recover every signer, mirroring Safe's `checkNSignatures`:
   - ECDSA,
   - eth_sign (v > 30, prefixed hash),
   - pre-validated (v = 1): allowed only when r = `msgSender`,
   - contract signature (v = 0): rejected for now. With the exact-length rule this branch is unreachable (a contract signature needs dynamic data after the static part); it stays as defense in depth. Phase 7's hash-based 1271 co-signer will need this rule relaxed for flagged non-rotating owners.
4. Executor rule: `msgSender` must be among the signers through v = 1 (Safe has already checked it is an owner).
5. Delegatecall is allowed only to the allowlisted MultiSendCallOnly.
6. Revert if a guarded transaction is already in progress for this Safe (no nested `execTransaction`).
7. Store the signer set in transient storage (EIP-1153), keyed by Safe.

### `checkAfterExecution`

1. Rotate every recorded signer regardless of `success`. A failed inner call still consumed the nonce and exposed the signatures.
2. Signers that are no longer owners (removed or force-rotated earlier in the same transaction) are skipped.
3. Each rotation pops the head of the slot's buffer and calls `execTransactionFromModule(safe, swapOwner(prev, old, next))`, then updates the slot owner, and emits `OwnerRotated(safe, slot, oldOwner, newOwner, index)`.
4. Revert if any signer's buffer is empty. (The executor's pre-flight simulation must catch this before broadcast; see section 5, limit 3.)
5. Invariant: `getOwners()` equals exactly the set of current slot owners.
6. Invariant: the transaction guard, module guard and module are all still this contract.

### Module guard (Safe 1.5.0)

Set RotationGuard as the module guard as well. It rejects module txs from any module other than itself, which closes the "other modules bypass the guard" hole on-chain. It must allow, and be tested for, its own `execTransactionFromModule` call made from inside `checkAfterExecution` (reentrancy into the Safe during the guard hook).

### Admin functions (callable only by the Safe itself, so they need the threshold)

- `initialize(oldOwners, configs)`: setup, and also a full reset under a new epoch. Records every old slot's consumed indexes first.
- `addSlot(config, threshold)` and `removeSlot(slot, threshold)`, which add or remove the owner through the module.
- `setRoot(slot, root, size, startIndex, cid)`, for an exhausted tree or a signer re-keying. Rejects a start index already consumed under that root.
- `forceRotate(slots[])`, for owners exposed outside the Guard's view. Uses the slot's buffer like a normal rotation.
- `skipTo(slot, index)`, the only way to skip indexes (for example after an address is known to be burned before use). Clears the slot's buffer.

### Restrictions

- Direct `addOwnerWithThreshold`, `removeOwner` and `swapOwner` calls outside the Guard's flow break the owner-set invariant and revert. `changeThreshold` is allowed.
- No other modules (enforced by the module guard).

### Escape hatch

If the tx is exactly `setGuard(address(0))` to the Safe itself (value 0, plain call), both hooks return immediately. This must be explicit: Safe caches the guard address before execution, so `checkAfterExecution` still runs on the old guard after `setGuard(0)`.

The escape tx skips every check, including the executor rule and rotation, because the point of the hatch is to work even if those checks are what is broken. Its signers are exposed and not rotated, so they must be treated as burned. The module guard and module stay installed after escaping; removing them is a follow-up (now unguarded) transaction.

The `to == safe` part matters: without it, any tx carrying `setGuard(0)` calldata to any address would skip rotation (caught by mutation testing).

### Gas estimates

Measured (`test/RotationGuard.gas.t.sol`, local, Prague rules, before refunds), against an identical unguarded Safe, after the owner-to-slot mapping was dropped (2026-10-08):

| Safe | Unguarded | Guarded | Overhead per signer | Before the change |
|---|---|---|---|---|
| 2-of-3 | 67k | 154k | 43.5k | 197k, 65.1k per signer |
| 3-of-5 | 71k | 216k | 48.2k | 278k, 68.9k |
| 7-of-10 | 87k | 477k | 55.8k | 608k, 74.5k |
| 20-of-20 | 139k | 1.49M | 67.5k | 1.79M, 82.4k |

The test budgets are pinned at 50k, 55k, 62k and 75k per signer. About 22k of each rotation is the one unavoidable zero-to-nonzero write (Safe's owner list entry for the new owner); the rest is the module call through the module guard, signature recovery, the slot scan and bookkeeping. Overhead grows with owner count because `_prevOwner` re-reads the owner list per rotation and `_findSlot` scans more slots. Under Sepolia's repricing (expected on mainnet later), measured on-chain: a 2-of-3 rotating transfer used 651,905 gas on the first guard and 430,119 on the current one (-34%); installing three slots 4,181,594 and 3,859,156; deploying the guard 16,697,418 and 16,106,927 gas, and 16,402,276 for the review-fixed guard, which dropped the `slotOf` and `consumedUpTo` views to stay under the cap at 10,471 bytes (`deployments/sepolia.json`).

Staging: after the first fill, about 15-20k per address (non-zero SSTORE plus proof calldata and verification). A batch of 5 is roughly 100-120k gas, about 0.0002-0.0005 ETH at 2-4 gwei.

## 7. Keeper and funding

### What the keeper does

A small TypeScript service that we run (on a VPS, or as a Gelato Web3 Function if we prefer not to host it), using a plain non-owner EOA.

1. Watches the Guard's `Rotated(safe, slot, oldOwner, newOwner, index)` events.
2. When a slot's buffer drops below the low-water mark (2 of 5), fetches the slot's tree file from IPFS by its on-chain CID, builds the next proofs and calls `stage` with a batch that refills the buffer.
3. Tops up gas: each slot's current owner must hold enough ETH to execute one rotation tx, so the keeper sends a small amount (for example 0.003 ETH) to each newly rotated-in owner. Receiving ETH does not expose a pubkey.

With a buffer of 5 and a refill at 2, the keeper refills about once every 3 rotations per slot and is not time-critical.

### Who pays

The Safe pays, through the keeper. The keeper EOA is funded from the Safe with a normal tx (for example 0.05 ETH, enough for many rotations). The dashboard shows its balance and warns when low. The keeper's own pubkey being exposed is irrelevant: it has no power over the Safe and holds only a small balance.

Hard rule: an owner must never send stage or top-up txs from an owner address, since that exposes the pubkey outside the rotation flow.

### Keeper down

`stage` is permissionless, so anyone with any non-owner wallet can press "Stage" in the Safe App (which reads the tree from IPFS), and a backup machine can run the same keeper script. The executor's pre-flight check blocks broadcast if any slot's buffer is empty or the executor lacks gas, so the worst case is a delay, never a mined revert that exposes keys.

### Trust model

A compromised keeper can waste its own ETH or stop staging (a delay until someone else stages). It cannot inject owners, skip indexes or move funds.

### Rejected alternative

Having the Guard pull the gas top-up from the Safe automatically during rotation. It adds external calls and failure modes inside the Guard hooks, against the rule of keeping the Guard small so it cannot brick the Safe.

## 8. Exposure paths the Guard cannot see

| Leak | Handling |
|---|---|
| Confirmations posted to the Safe Transaction Service are public before execution | Executor rule keeps a single pending tx below threshold; one pending tx at a time; tracker monitors the union of confirmers |
| Signed but never executed (replaced or rejected nonce) | Signers marked burned; `forceRotate` in the next tx |
| Off-chain messages (EIP-1271 via SignMessageLib, Permit, SIWE, Snapshot) | Burned. Operational rule: owner keys sign Safe txs only |
| An owner EOA that has ever sent a tx (`nonce > 0`) other than as the executor of a rotating tx | Burned |
| A reverted `execTransaction` that was mined | All its signers burned; immediate `forceRotate`; prevented by simulation and a revert-protected private RPC |
| An execution sent but never mined (dropped, or held by a private relay) | Executor exposed on top of the confirmers: a full threshold of exposed, unrotated keys. Land it (speed up) or `forceRotate` every signer of it at the same nonce; the app detects it from its own signing ledger (4j-16) |
| Same owner address used on another chain | Mainnet only for now. Never reuse an owner address elsewhere |

## 9. Off-chain key management

- Each Safe's keys live under their own hardened path, `m/44'/60'/{account}'/{branch}'/{i}`, with account and branch derived from the chain and Safe address (section 14). Earlier trees used `m/44'/60'/{base+i}'/0/0` and `m/44'/60'/{account}'/0/{i}`; joining still recognizes both. Never share an xpub: an extended public key reveals every child public key below it. Share addresses only.
- Generator modes:
  - Seed on an air-gapped machine: fast, but the seed sits in software.
  - Hardware wallet `getAddress` loop: about 100 ms per address, so roughly 17 minutes for 10,000, and the seed never leaves the device.
  - In both modes the CLI discards pubkeys immediately and outputs addresses only.
- The tree file is not secret and not trusted. It holds only hashes, and a tampered proof fails against the on-chain root. It is pinned to IPFS and its CID is emitted on-chain so anyone can stage.
- The root is the trust anchor. Before setup is signed, each signer compares their slot's on-chain root with their own CLI output. A wrong root committed at setup hands future ownership of that slot to an attacker.
- Lost tree file: regenerate from the seed with the same parameters, which reproduces the same root.

## 10. Safe App and rotation signer

### Safe App features

1. Setup wizard: point to the singleton, register each signer's slot (root, size, CID), then one batch that enables the module, sets the guard and module guard, swaps all current owners to index 0 and stages indexes 1-5 for every slot. Existing owners have almost certainly signed before, so they are treated as exposed.
2. Dashboard: per slot, current owner, index, addresses remaining, buffer depth, gas balance of the current owner, exposure status; keeper balance. Warns below about 10% of the tree remaining, on an empty or low buffer, and on a low keeper balance.
3. Signing helper: tells each signer which derivation index and path to connect for the next signature, and who the designated executor is.
4. Staging: manual "Stage" button that refills buffers from the IPFS tree file using any non-owner wallet (fallback when the keeper is down), and can also add a `stage` call to batches the app builds.
5. Exposure tracker: scans Transaction Service confirmations, message signatures, `ApproveHash` events, owner EOA nonces and the signers of any escape-hatch tx; computes exposed-but-not-rotated owners; warns at threshold-2, blocks at threshold-1; offers one-click `forceRotate`.
6. Executor flow: simulate, check that every signer has a staged next owner with gas, warn if the executor already confirmed off-chain, then broadcast through a private revert-protected RPC.
7. Admin: add or remove a signer, replace a root, force-rotate all, remove the guard (escape hatch).

### Architecture

- Runs as a Safe App inside Safe{Wallet} (Safe Apps SDK). Transactions are proposed into the Safe{Wallet} queue with `sdk.txs.send`, so owners confirm and execute in the normal Safe UI. The app never holds keys.
- Also runs standalone, read-only, against any RPC and Safe address. This is how it is developed and tested against the Anvil demo, since Safe{Wallet} cannot load a local chain.
- Shared logic lives in `packages/core` (npm workspace): the tree format, leaf and proof code moved out of the generator, the RotationGuard ABI, read helpers and calldata builders. The generator and app both depend on it, so there is one implementation of the leaf.
- Tree files come from an upload or from IPFS, using the CID in the `SlotConfigured` event. They are verified on load (root rebuilt from addresses) and against the on-chain root.
- Pending transactions and confirmations come from the Safe Transaction Service API.
- The executor flow cannot choose the RPC Safe{Wallet} broadcasts through. It runs the pre-flight checks and tells the executor to point their wallet at a private, revert-protected RPC (for example Flashbots Protect) before executing.

### Rotation signer (milestone 4i)

The problem: after every signature, a signer's owner address moves to the next address in their tree. Ordinary wallets (Rabby, MetaMask, Ledger Live) are built around a few stable accounts, so every rotation means adding or switching to a new account before the next signature. This is the largest day-to-day cost of the design.

Options considered:

| Option | Verdict |
|---|---|
| Pre-load the next 10-20 tree accounts into the wallet | Stopgap for testing: still a manual switch per signature, wallet clutter, periodic refresh |
| Derive trees on the standard wallet path `m/44'/60'/0'/0/i` from a dedicated seed (or Ledger passphrase wallet), so "Add account" yields the next owner | Not adopted: needs a separate seed per signer per Safe, still a click per rotation, and non-hardened children mean a leaked account xpub would expose every future public key |
| A dedicated signing tool that always signs with the right key | **Chosen** |
| Hash-based co-signer (phase 7) | The long-term exit: owners that do not rely on ECDSA need no rotation |

Design:

- Interface (decided): a local web UI. `rotation-signer` starts a process on the signer's machine that holds the key (seed file or Ledger over USB) and serves a browser UI on `127.0.0.1`. Keys never enter the browser. The session is protected by a random token in the URL fragment, a Host-header check against DNS rebinding, and no cross-origin access.
- Scope of v1 (decided): confirm and execute. Transactions are still created in Safe{Wallet}. v2 adds proposing from the app, signed as the proposer's own confirmation; a fixed non-owner proposer was tested on Sepolia and does not survive rotation (see open questions).
- Layers: browser-safe logic in `packages/core` (Transaction Service client, local EIP-712 SafeTx hashing, action decoding, and a rules engine that decides per transaction and per signer whether Confirm or Execute is allowed and why not); key handling in a Node-only `packages/keys` (seed and Ledger sources moved out of the generator); the server and UI in `signer/`. It is not part of the generator, which stays offline-only; the signer needs network access.
- Key source: the signer's seed file or Ledger, with the same derivation and code as the generator. The signer's tree file identifies their slot; the tool reads the slot's current owner index on-chain and derives exactly that key. The signer never picks an account.
- Safe{Wallet} stays the place where transactions are created and the queue is viewed. Only confirming and executing move into the tool.
- Commands:
  - `status`: my slot, my current owner address and tree index, buffer depth, owner gas, pending transactions and how many confirmations each has.
  - `confirm <safeTxHash>`: fetch the transaction from the Safe Transaction Service, recompute its hash locally from the fields (never trust the service's hash), show a decoded summary, sign the EIP-712 SafeTx hash (on the Ledger, clear-signed where the app supports it) and post the confirmation.
  - `execute <safeTxHash>`: for the last signer. Collect the confirmations, add the executor's pre-validated signature, sort, simulate with `eth_call` from the executor, then broadcast through a private, revert-protected RPC and report the new owners.
- Rules the tool enforces instead of leaving them to memory:
  - never post a confirmation that would exceed `threshold - 1` off-chain confirmations; the last signer must execute;
  - refuse to confirm or execute when any involved slot has an empty buffer, when the transaction's nonce is not next, or when simulation reverts;
  - execute only through the configured private RPC;
  - warn when the exposure tracker's findings (section 8) say exposed-but-not-rotated owners would reach the threshold;
  - never send any other transaction from a tree key.
- Proposing: creating a transaction in Safe{Wallet} needs a current owner or a registered proposer, and an owner's proposal counts as their confirmation. The tool should support proposing from a non-owner proposer account once the Sepolia test shows how proposers behave across rotation (open questions below).

Open questions to settle on Sepolia before mainnet:

- Settled on Sepolia (setup tx `0x7584d52c…9c116799`): Safe{Wallet} creates Safes at 1.5.0 (SafeL2), and batches through MultiSendCallOnly `0xA83c…1836`, the one the guard allows.
- Settled: when the last owner clicks Execute without confirming first, Safe{Wallet} submits their signature as pre-validated (v = 1, `APPROVED_HASH` in the Transaction Service) next to the other confirmation, exactly `threshold` signatures. This is the form the executor rule requires.
- Settled: the 2-of-3 setup transaction used 4,367,352 gas on Sepolia.
- Settled: the first guarded transaction (`0xb163d027…f091fd`, a 2-of-3 transfer) rotated exactly its two signers to tree index 1, matching the generated trees. The Transaction Service accepted a confirmation from an owner rotated in by the previous transaction with no delay.
- Settled: the rotation signer works on Sepolia end to end. Nonce 2 (`0x0edb6cfc…28098d4a`, 662,328 gas) was confirmed from signer 1's app through the real Transaction Service and executed from signer 3's app; both rotated as their trees predict, with no keys imported anywhere.
- Found: Flashbots Protect on Sepolia held the execution privately and never included it (few Flashbots-connected Sepolia builders), and the app waited without a timeout. Resending through the normal RPC worked. Fixes: show the transaction hash immediately with a status and a timeout, and default to the read RPC on Sepolia (Flashbots Protect stays the mainnet default).
- The Transaction Service API has moved to `https://api.safe.global/tx-service/<network>/api/v1/...` (for Sepolia, `sep`); the per-network domains now redirect.
- When more owners confirm than the threshold needs, does Safe{Wallet} include the extra signatures (which the guard rejects)?
- Does Rabby's Safe integration execute with the owner's own pre-validated signature, like Safe{Wallet}?
- Settled, no: registered proposers do not survive rotation. A proposer registered by slot 2's owner (Transaction Service delegate, EIP-712 domain "Safe Transaction Service") proposed nonce 2 with zero owner confirmations, but once that owner rotated out the service deleted the delegate and rejected its next proposal ("not an owner or delegate"). Registering also needs an owner's off-chain signature, which exposes that key. So the rotation signer proposes itself instead: proposing signs as the proposer's own confirmation, which costs no extra exposure.
- How quickly does the Transaction Service accept confirmations from a newly rotated-in owner?

## 11. Testing and assurance

Status: in place for phase 2. Run with `forge test`; fork tests read `MAINNET_RPC_URL` from `.env` (gitignored) and skip without it.

- Unit tests (`test/RotationGuard.t.sol`): rotation, executor rule, every restriction, escape hatch, staging and every admin path.
- Fork tests (`test/RotationGuard.fork.t.sol`): the full unit suite rerun against the canonical Safe 1.5.0 mainnet singleton (`0xFf51A5898e281Db6DfC7855790607438dF2ca44b`), proxy factory (`0x14F2982D601c9458F93bd70B218933A6f8165e7b`) and MultiSendCallOnly (`0xA83c336B20401Af773B6219BA5027174338D1836`) at a pinned block.
- Fuzz (`test/RotationGuard.fuzz.t.sol`):
  - exactly the signers rotate, for any threshold, signer subset and signature type,
  - a differential test of every signature encoding (ECDSA, eth_sign, executor and non-executor pre-validated, relayer executor, appended extra) against a reference model of the executor rule,
  - proofs bound to the chain and the Safe; any tampered proof element, index or address is rejected.
- Invariants (`test/RotationGuard.invariant.t.sol`), with `fail_on_revert` on, over honest executions, staging, every admin path, careless operators re-committing old trees, adversarial Safe transactions, rogue modules and bad signature encodings:
  - every signer of an executed tx leaves the owner set in that tx,
  - no address that ever left the owner set comes back or is staged,
  - the owner set equals the slot owners and the threshold stays valid,
  - buffers stay bounded, ordered and equal to the tree addresses,
  - honest staging never fails, dishonest staging never succeeds,
  - no adversarial action succeeds and ETH only leaves through honest transfers,
  - hooks stay installed,
  - liveness: the escape hatch always works, and owners can always execute after a refill.
  `test/HandlerCoverage.t.sol` asserts the handler really exercises every admin path.
- Gas budgets (`test/RotationGuard.gas.t.sol`): per-signer overhead regression limits from 2-of-3 to 20-of-20.
- Mutation testing: 35 mutants that each delete or weaken one safety check. 34 are killed; the survivor is the unreachable v = 0 branch described in section 6.

Still to do:

- Optional coverage-guided campaign with Echidna/Medusa.
- External audit before any mainnet value, then a low-value mainnet canary.

## 12. Phases

1. Spec and threat model (this document).
2. Contracts: RotationGuard, Foundry tests, fuzz and invariant suite. Done, pending audit.
3. Generator CLI (TypeScript): both modes, tree file format, shared leaf and proof library. Done in `generator/`, cross-checked against the contract.
4. Safe App: setup, dashboard, staging, exposure tracker, executor flow, admin. In progress, in milestones:
   - 4a. `packages/core`: shared tree code, guard ABI, read helpers, calldata builders and revert decoding. Done; 24 tests including an integration run on a local chain.
   - 4b. App shell: Vite + React + TypeScript, Safe Apps SDK connection, standalone read-only mode. Done.
   - 4c. Dashboard: slots, owners, tree progress, buffers, owner gas, warnings. Done (keeper balance waits for phase 5, when the keeper has an address).
   - 4d. Setup wizard: load tree files, check roots, propose the install batch. Done (validation in `packages/core/src/setup.ts`).
   - 4e. Staging: refill buffers from tree files, from a non-owner wallet or inside a batch.
   - 4f. Exposure tracker: Transaction Service confirmations, `ApproveHash` events, owner nonces, escape-hatch signers; one-click `forceRotate`.
   - 4g. Executor pre-flight: simulate the next transaction with the executor's signature, check buffers and gas, warn on prior confirmation, point to a private RPC.
   - 4h. Admin: add or remove a slot, replace a root, skip indexes, escape hatch. In the signer app (2026-10-08): add a signer (the newcomer chooses "I'm being added to a Safe", their app generates a tree for the next slot ID and a slot package; an existing signer proposes `addSlot` plus staging in one batch), remove a signer, change the threshold, force-rotate (with select all), and the escape hatch behind a typed confirmation. Each is checked against chain state before signing and proposed like any transaction. Replacing a slot's root (renewing a nearly used tree) and skipping indexes are still to do; a 10,000-key tree lasts 10,000 signatures.
   - 4i. Rotation signer: local web UI that confirms and executes with the signer's current owner key (section 10). In progress:
     - 4i-1. Core: Transaction Service client, SafeTx hashing checked against the contract, action decoding, rules engine.
     - 4i-2. `packages/keys`: seed and Ledger sources shared with the generator; resolve the current owner key from tree file and chain.
     - 4i-3. Local server and JSON API (status, queue, confirm, execute) with token, Host check and private-RPC execution. Done, with the `rotation-signer` CLI (Flashbots Protect by default).
     - 4i-4. React UI: identity header, decoded queue, one action per transaction with blocking reasons, pre-flight checklist. Done (`signer/ui`; `npm run demo -w signer` runs it locally).
     - 4i-5. End-to-end tests on a local chain with three signer instances: done (`signer/test/e2e.test.ts`), and a Sepolia run with the real Transaction Service: done.
     - 4i-6. Desktop app (Electron 44): same UI, talking to the signing process over IPC instead of HTTP (no port, no token), with a setup screen and an all-signers view. Done for seed files; Ledger in the desktop app needs the USB library rebuilt for Electron. Packaging and code signing are not done.
   - 4j. One app for each signer, from onboarding to daily use (decided 2026-10-08). The desktop app becomes the main interface; Safe{Wallet} is an optional viewer. Each signer runs their own copy holding only their own keys; signers share only public data (chain, Transaction Service queue, slot packages).
     - Decisions: seeds live in an encrypted vault in the app's data folder (scrypt + AES-256-GCM, password unlock each launch), with Ledger as the hardware alternative; slot packages travel by copy-paste or file; external wallets are limited to seed and Ledger (tree keys need one of them); v1 proposals cover ETH and ERC-20 transfers plus guard admin actions.
     - Accounts: the seed's standard first account is the signer's operator account (their initial owner, which stops being an owner at install) and pays for staging and gas top-ups; tree accounts are only ever used as owners.
     - 4j-1. Wallet vault: import or unlock, replacing seed files in the desktop app. Done (`signer/desktop/vault.ts`).
     - 4j-2. Join a Safe. Done for Safes that already have the guard: the signer enters only seed, password and Safe address; the app detects the network, finds the signer's slot by matching the key at each slot's current tree index, rebuilds the tree and checks it against the on-chain root (`signer/src/join.ts`), using public RPCs by default. Tree ranges now start at a base derived from chain and Safe (`defaultBase` in core; the generator defaults to it too), with 100,000 tried as a fallback for the first Sepolia test Safe. Brand-new Safes: done in 4j-3.
     - 4j-3. Create a new Safe from the app. Done (`packages/core/src/create.ts`, `signer/src/newsafe.ts`, setup screens in `signer/ui/src/Setup.tsx`). The creator lists every signer's operator address and the threshold; the app predicts the Safe's CREATE2 address (canonical factory, SafeL2 on Sepolia and Safe on mainnet as Safe{Wallet} does, Safe{Wallet}'s fallback handler) and produces an invite code. Each invited signer pastes it; their app recomputes the address from the signers and salt, finds their slot by their operator address, generates their tree at the Safe's default base and returns a slot package (first key, next 5 keys, proofs). The creator's app checks every proof against its root and the cross-slot rules, then sends two transactions from the creator's operator account: deploy (operators as owners, threshold 1) and install (guard, slot swaps, staging, final threshold) with a pre-validated signature. Every signer's app then joins on its own and checks its root on-chain. Two transactions are needed because tree leaves bind the Safe address, which depends on the initializer. Tested on Sepolia: Safe 0x9Ed45FdF1598295CF7804719A4E3BB1719aEd1BD (2-of-3) created and installed from the three test seeds (deploy 1.41M gas, install 4.18M gas after the hardfork repricing), indexed by the Transaction Service as 1.5.0+L2, and each signer joined its own slot. Trust note: the creator alone executes the install, so each signer must check after joining that their slot and the threshold are as agreed before funds go in. Mainnet waits for a mainnet guard deployment.
     - 4j-4. Self-staging and gas: the app stages its own slot's next keys and tops up its current owner from the operator account, automatically when low. Gas done (decided 2026-10-08: just-in-time funding, not a guard change). Rotation keys hold no ETH between uses; only the executor ever pays gas. Before executing, the app sends the current key exactly the estimated gas plus a sweep's cost from the operator account (the seed's first account, shown as the gas account), waits for it, executes, and once the execution is mined sends the key's remainder back with a legacy transfer whose gas is estimated (Sepolia's repricing makes some plain transfers cost more than 21,000 gas, and funding a never-used key creates its account at about 205k gas there), leaving the key at zero or a fraction of a gwei. Tested on Sepolia with Safe 0x9Ed4…d1BD: two funded executions, keys swept back to the gas accounts. Nothing is stranded on retired keys and the guard is unchanged. A key that already holds enough is not topped up but is still swept. Self-staging done too: the app checks every minute and, once its slot's buffer has two free places (or is empty), stages its next keys from its own tree up to full, sent and paid by the gas account; staging is permissionless and the gas account is not an owner. A failure (for example an empty gas account) shows as a warning; Overview has a manual Refill. This replaces the keeper bot of phase 5 for signers who run the app.
     - 4j-5. Propose in the app: transfers and guard admin, signed as the proposer's own confirmation. Done for ETH and ERC-20 transfers and force-rotating chosen slots (`buildProposal` in core, `SignerSession.propose`, New transaction on the Transactions page); a proposal needs threshold 2 or more and an empty queue, is checked by the same rules as a confirmation, and is posted to the Transaction Service with the proposer's signature. Proposers (delegates) are not used: a delegate dies when the owner who registered it rotates. Other guard admin actions are still to do.
     - 4j-6. Ledger in Electron, then packaging and code signing. Profiles done (2026-10-08): any number of seed or Ledger profiles, each with its own folder (vault, settings, trees, Safe creation), one unlocked at a time; a Ledger profile stores only its device's first address and refuses another device; old installs migrate into a first profile (`signer/desktop/profiles.ts`). The Ledger USB library (node-hid, N-API) loads in Electron without a rebuild; signing on a real device is still to verify, then packaging and code signing.
     - 4j-7. dApp browser (decided 2026-10-08). Done: Browse dApps opens any https dApp in a sandboxed view with its own session partition and no permissions, and injects an EIP-1193 wallet (also announced through EIP-6963) whose account is the Safe. Reads go to the RPC; `eth_sendTransaction` and EIP-5792 `wallet_sendCalls` become one proposal (several calls batched through MultiSendCallOnly) that the user reviews in the app's own UI, with the page hidden, and signs as their confirmation. The dApp gets the safeTxHash; `wallet_getCallsStatus` and receipt lookups for it answer from the Safe's execution events once a signer executes. dApps may not call the Safe or the guard. Message signing is refused, since it would expose an owner key without rotation and the signature dies when owners rotate. One request is reviewed at a time, and proposing still needs an empty queue. The main UI's IPC now rejects calls from any other web contents. Not done: WalletConnect for dApps in the user's own browser; an owner-key mode for Safe{Wallet}.
     - 4j-8. Name and icon: the desktop app is called **Cicada** (a cicada climbs out of its shell and leaves the empty husk behind, as each signature leaves its exposed key). Icon in `signer/desktop/assets` (SVG source, PNG, macOS `.icns`): an amber cicada with folded wings on dark green, also the icon dApps see for the wallet (EIP-6963). Done 2026-10-09. The key-derivation domain strings are `cicada/two-level` and `cicada/per-safe` (renamed 2026-10-09, which moved every key: Safes created before then must be recreated); changing them again would do the same.
     - 4j-9. Transaction queue. Done 2026-10-08.
       - A "Queue transactions" switch at the bottom of the sidebar makes Add to queue the default for New transaction, signer management and dApp requests; with it off, each action is still proposed on its own, and Add to queue stays available per action. The escape hatch cannot be queued.
       - The queue lives in memory in the signing process (lost on lock). The Transactions page shows it: reorder, remove, clear, and a simulated outcome (each call's success, the Safe's balance changes, new approvals, with unlimited approvals flagged). Review, then Sign & propose sends everything as one MultiSendCallOnly transaction (nested batches flattened), so each signer signs and rotates once.
       - Simulation uses `eth_simulateV1` with `traceTransfers` (the default public RPCs and Anvil support it), running the calls as the Safe without signatures; Geth's duplicate system-address transfer logs are ignored. Tenderly is not needed.
       - Approve then deposit with a dApp that sends them separately: the queued approval gets a placeholder hash whose receipt reports success at once, and while the queue is not empty the dApp's `eth_call` and `eth_estimateGas` run on top of the queued calls, so the dApp sees the allowance and offers the deposit; both then go out in one proposal. Once proposed, the placeholder follows the real proposal. dApps that use EIP-5792 `wallet_sendCalls` already send both in one request.
       - dApps that read the chain through their own RPC (found on testnet.raac.io, which fills in nonce and gas itself and never reads through the wallet) cannot see queued actions or Safe proposals, only mined transactions. So `eth_sendTransaction` now answers with the real execution's transaction hash once a signer executes the proposal (the dApp waits until then), and the wallet flags such dApps (they set the nonce, or never read through the wallet) with a warning that queueing would leave them waiting, making Sign & propose the default. For them, approve and then swap take two executions. EIP-5792 `wallet_sendCalls` still answers at once with an ID.
       - Limits: checks run against current chain state, not the state after earlier queued items (simulation covers that); two "add a signer" items in one batch are refused.
     - 4j-22. Safes without ETH could not execute. Found on Sepolia 2026-10-09 (1-of-1 Safe `0x3400…CAA5`): every execution, and the recovery after it, was mined and reverted with GS011, leaving the key exposed and unrotated. Since 4j-18 guarded transactions sign `gasPrice` = 1 wei, so Safe refunds the executor from its own balance, and the Safe held 0 ETH; simulations run at gas price 0, where the refund is 0, so they passed. Fixed: the executor attaches the refund's upper bound (gas limit x 1 wei) as value to `execTransaction`, which is payable, and Safe pays it straight back as the refund, so an empty Safe works and nobody has to fund it. Also: a reverted execution now shows why (the call replayed just before its block at the gas price it paid, with Safe's GSxxx codes explained); a newer local transaction at the same nonce replaces an older one; and the Transactions page shows every execution this app started in the last 30 minutes with its live steps, since a sole signer's transaction can land before the list refreshes and vanished without a trace. Tests: an empty-Safe execution in `signer/test/sole.test.ts`, and an Electron end-to-end test where the app's user is the only signer of an empty Safe.
     - 4j-21. dApp browser compatibility and tabs. Done 2026-10-09. Uniswap rendered blank: the injected wallet was frozen and its startup sets a legacy MetaMask field on it; it is now extensible (end-to-end test with a strict-mode page). Curve stalled on its loading screen on Sepolia because the wallet reported an account on a network Curve does not support; the wallet now connects per site on request, as MetaMask does, so such dApps load read-only. The browser now has tabs, and popups and new windows open as tabs that keep their opener and the wallet (end-to-end test). Checked against Uniswap, Aave, CoW Swap, Lido, 1inch and Curve. Saved pages: a star in the address bar saves the page (per profile, `bookmarks.json`), and a dropdown under Browse dApps in the sidebar opens a saved page in a new tab. While an action is sent, buttons say "Simulating…" (only signer) or "Signing…", and the dApp review shows what it is doing instead of only disabling its buttons.
     - 4j-20. Migrate an existing Safe (planned, 2026-10-09). The project's original promise is protecting Safes that already hold funds, but Cicada can only create new Safes or join ones that already have the guard: joining a plain Safe stops with "This Safe doesn't have rotation set up yet", and converting one today needs the legacy Safe App wizard plus generator key-list files. Plan: a "Migrate my Safe" path on the setup screen, next to Create, that walks every owner through the conversion and shows each step and who it is waiting for. The Safe keeps its address and funds; each owner's current address is swapped for the first key of their own key list.
       - Check: enter the Safe address; Cicada reads owners, threshold, version, modules and guard, and stops with a plain explanation if it cannot be migrated as is (not Safe 1.5.0, another guard or module guard installed, an unknown module enabled). Safes on 1.3.0 or 1.4.1 need upgrading to 1.5.0 first: find out how (Safe{Wallet}'s upgrade, or Safe's migration contracts) and either guide the user through it or include it in the migration.
       - Invite: the owner who starts it produces a migration invite listing the current owners and the target threshold. Each owner opens it in Cicada (creating their profile first if they have none), links the owner address they currently sign with to their profile (a signature from that address proves control, so an owner whose Safe address is not their seed's first account, or is on another wallet or Ledger account, can still take part), and Cicada generates their key list and a signed slot package, as in the create flow.
       - Install: once every owner's package is in, Cicada builds the install batch (enable the guard as module, set the transaction and module guards, `initialize` swapping each current owner for its slot's first key, stage the next keys, set the threshold), checks it in simulation, and proposes it to the Transaction Service, so the current owners can sign it with their existing wallets in Safe{Wallet} or Cicada; the guard is not active yet, so Safe{Wallet}'s gas settings are fine for this one transaction. The batch is split if it would pass the per-transaction gas cap (stage fewer keys; each owner's app stages the rest).
       - Progress: a checklist that every owner sees: Safe checked, owners who have prepared their key list (and who is still missing), install proposed, confirmations so far, executed, each owner joined. Every owner's Cicada joins the migrated Safe by itself once the install executes, as after creating a Safe.
       - After: the old owner addresses are no longer owners (they had signed before, so their keys were exposed); the Safe is used from Cicada with rotating keys. The app explains this before the install is signed.
       - Test: an end-to-end run on anvil migrating a plain 2-of-3 Safe with existing funds, including an owner whose current address is not their seed's first account.
     - 4j-19. Threshold-1 Safes and Transaction Service limits. Done 2026-10-09. The guard always allowed a 1-of-1 Safe (the executor's own pre-validated signature is the one signature, and it rotates), but the app refused to propose below threshold 2, so a 1-of-1 Safe the create flow allowed could not transact. Now, at threshold 1, proposing posts nothing to the Transaction Service: the session keeps the transaction and executes it at once with the usual steps, and every "Sign & propose" becomes "Execute" (`signer/test/sole.test.ts`). Separately, the public Transaction Service answered 429 (too many requests per second) because each 10 s refresh fetched the same pending list twice at once, plus once per Safe in the switcher: the client now shares concurrent reads, reuses them for 3 s (actions read fresh; its own proposals and confirmations clear it), retries 429 with backoff, and the UI keeps the last queue when only the Transaction Service fails.
     - 4j-18. Second security review fixes and scaling to 32 signers. Done 2026-10-09; deployed on Sepolia at `0xeE3b971850b9649D62b407bd7ADb44b8DE8bD074` (16,001,740 gas, 775k under the cap), and new Safes use it. Safes on earlier guards keep their old rules until their signers escape and reinstall.
       - Gas-burning callee: with `gasPrice` 0 Safe gave the inner call 63/64 of the gas, so a callee that behaved in simulation and burned gas on-chain made the whole transaction revert at the app's 1.2x gas limit, leaving every signature public and nobody rotated. The guard now requires `safeTxGas` and `gasPrice` both non-zero, so Safe caps the inner call at `safeTxGas`; the app signs `gasPrice` = 1 wei (Safe refunds the executor a few hundred thousand wei) and sends executions with the simulated gas plus the whole `safeTxGas`.
       - Failing refund: refunds may only be in ETH to the executor (`RefundNotAllowed`), since a refund to a receiver that rejects ETH or in a failing token reverted the whole transaction. The Safe must keep a little ETH; the escape hatch keeps `safeTxGas` and `gasPrice` at zero and needs none.
       - Escape snapshot bypass: a batch could change the owners before the replayed escape `checkTransaction` took the first review's owner-set snapshot. `checkTransaction` now runs at most once per Safe nonce (transient nonce lock), which stops the replay itself; the snapshot is gone, which also made the guard smaller.
       - Stolen staged address: another slot could rotate into an address a slot had already staged and block that slot's rotation. Rotation now skips staged entries that are already owners.
       - App: the decoder marks calls to the guard's hooks, and owner or hook changes that bypass the guard, as blocked; the rules engine mirrors the new gas and refund rules.
       - Consolidation: the guard's header now states its three properties (rotation, owner set, no reuse) and derives every rule from them. Three checks the later fixes had made redundant are gone: `SignerNotOwner` (replays now stop at the nonce lock, and Safe already verifies signers before the hook), the escape path's guard-removed check (only a genuine `setGuard(0)` reaches it), and the duplicate check within a slot's buffer at staging (rotation skips a key that is already an owner). Mutation-tested again: removing any of the four fixes fails at least four tests.
       - Size: 10,212 bytes (10,547 before the consolidation).
       - Scaling, simulated with `eth_simulateV1` on the live networks (new guard injected as a state override): create the Safe, install, then an N-of-N rotating transfer. `MAX_SLOTS` = 32 is the guard's limit (slot IDs per configuration); Safe itself has no owner limit. Rotating transfers fit easily: N-of-N on Sepolia costs 0.78M (3), 1.12M (5), 2.01M (10), 3.96M (20) and 6.58M (32) gas, at most 39% of the cap; on mainnet 0.30M, 0.83M (10), 1.77M (20), 3.18M (32). The install is the limit on Sepolia: one transaction fits 15 signers with 5 keys staged each, 29 with 1 key each, and 32 with none (13.4M); mainnet fits 32 with 5 keys each (9.96M). Creating a Safe therefore stages fewer keys when the full install would not fit (5, then 1, then none), and each signer's app stages the rest of its own slot (about 0.65M gas for 5 keys on Sepolia).
     - 4j-17. Welcome page and loading skeletons. Done 2026-10-09. On first launch (no profile yet) the app opens on a welcome page: the mark, a one-line pitch, Get started, three cards (one key per signature, next keys committed ahead, nothing to switch) and an "addresses only" note (the app works from on-chain addresses; Ledger keys never leave the device; a seed is encrypted locally and only the key in use is derived when it signs). Get started leads to Add a profile, and Cancel returns to the welcome page; once a profile has existed in the session the welcome page is not shown again (removing the last profile goes to Add a profile). The shell shows an Overview-shaped skeleton instead of "Loading…" until the first status arrives, and the Safe switcher shows skeleton lines while it lists Safes.
     - 4j-16. Executions that never land. Done 2026-10-09: signing log and open executions on disk per Safe (`signer/src/store.ts`), attempts resumed after a restart, Speed up from the same key and account nonce, `replaced` once the nonce is used, exposure finding with one-button recovery (`recover`: force-rotate of every exposed slot at the lost transaction's nonce), rules engine counts recorded exposures and refuses a second execution from a key with one out; tested in `signer/test/attempts.test.ts` against a black-hole RPC. Original plan (2026-10-08): An execution sent but never mined (dropped, underpriced, or stuck behind a private relay) or mined but reverted leaves every signer of that transaction exposed without rotation. The confirmers were already exposed on the Transaction Service (at most threshold - 1, which the rules engine enforces); the executor's signed transaction adds the last one, so a full threshold of exposed, unrotated keys exists. Under ordinary ECDSA nothing follows (the signatures authorize only that Safe transaction, and the executor rule means only the executor's own signed transaction can land it), but under the threat rotation defends against (public key to private key) that is enough to take the Safe. Today the app detects a mined revert (red checklist, used-nonce alert) and reports "stuck" after a timeout, but the execution record lives in memory and is lost on restart, a dropped transaction leaves no nonce to detect, nothing stops a second Execute while the first is out, and the stuck message talks about RPCs and nonces. A normal user would just refresh and try again.
       - Signing ledger: whenever the app signs with an owner key (an execution or a confirmation), it records the key, Safe, chain, Safe nonce and safeTxHash on disk. On every refresh, a recorded key that is still an owner while nothing of its own is pending is an exposure: Overview shows, in plain words, that the last transaction was sent but never went through and the keys that signed it must be replaced, with one button to fix it. Works without any view of the mempool, including private relays.
       - Persistent attempts: executions are saved to disk and resumed after a restart. While an attempt is open, the transaction shows "Still waiting for the network" with Speed up (the same transaction from the same key and account nonce, higher fee) instead of a fresh Execute, so a second attempt can never race the first or raise a false "nobody rotated" alarm.
       - Recovery order: first try to land the original (speed up), since landing it rotates every signer and finishes the job. If abandoned, propose a force-rotate of every slot that signed it (executor and confirmers, not only the executor) at the same Safe nonce, which also cancels the stuck transaction for good; the signers of the force-rotate rotate as usual. The rules engine treats recorded exposures like confirmations when counting exposed keys, so no new confirmation can push exposure past the threshold while a recovery is pending.
       - Test: an end-to-end run that sends an execution into a black-hole RPC, restarts the app, and checks the alert, Speed up, and the force-rotate recovery.
     - 4j-15. Renewing a key list, and contract calls. Done 2026-10-08.
       - Renewal: Settings (and Overview when a list runs low) offers Renew my key list. The app derives the next generation of the Safe's two-level path (`safeKeyPath(chain, Safe, generation)`; generation 0 keeps the original hash input, joining tries generations 0 to 7), starts at the first run of unused keys, and proposes one batch: `setRoot` to the new list plus staging its first five keys. `setRoot` is a Safe transaction like any other, so it needs the threshold, not every signer; staging must be in the same batch because `setRoot` empties the buffer and the renewing signer rotates in that same transaction, straight onto the new list. The new list is saved beside the slot's tree when proposed, and the session switches to it once the slot's root on-chain is its root (no re-join). The session checks the new keys' proofs and that none was used elsewhere. A slot on an older layout moves to generation 0 of the two-level path. The command-line server keeps the switched list in memory only.
       - Contract call: New transaction has a Contract call tab: target, ETH value, and either an ABI (JSON or human-readable signatures, one function chosen, typed inputs with JSON for arrays and tuples) or raw call data. It is proposed as an app call, so calls to the Safe or the guard are refused, and it can be queued like any action.
     - 4j-14. Signed slot packages. Done 2026-10-08. A slot package carries an EIP-191 signature by its signer address (the seed's first account, never an owner), over a readable text naming slot, Safe, chain, first key and root plus a digest of the whole package (`packageMessage`, `packageDigest`). Creating a Safe: the creator's app requires each package to be signed by the address the invite lists for its slot (`verifySignedPackages`), so a swapped or impostor package is rejected outright. Adding a signer: the session refuses unsigned packages, and the owner's screen shows the package's signer address and requires confirming it with the newcomer over a separate channel before Review. Ledger profiles may sign that one message with the operator account only; owner keys still refuse every message.
     - 4j-13. Two-level key path and collision alarm. Done 2026-10-08.
       - New trees derive key `i` at `m/44'/60'/{account}'/{branch}'/{i}`, account and branch both hardened and both from one hash of chain and Safe (`safeKeyPath`). Two Safes of one seed share keys only if both collide: about 1 in 4.6 × 10^18 per pair (100 Safes per seed: about 1 in 900 trillion), with no coordination between devices, since every device derives the same path from the Safe address. The path has five levels like before, so each address costs the same to derive on a Ledger (one fixed-cost step per level; the size of the numbers does not matter); the time per address is the device's public-key computation and USB round trip. The app keeps deriving addresses one by one rather than exporting an extended public key, which would put a whole slot's future public keys in one place.
       - Joining tries the two-level path, then the one-level per-Safe account (4j-11), then the ranged layouts, so every earlier Safe still works. The generator defaults to it (`--layout account` and `--layout range` for the earlier ones).
       - Collision alarm: before keys are installed or staged, the app also reads the guard's OwnerStaged and OwnerRotated events (from the first guard deployment, in 45,000-block chunks, then only new blocks) and flags any key the guard already staged or rotated to for another Safe, from the chain alone and across devices. Public RPCs refuse log searches without a contract address, so it searches the guard rather than Safe's AddedOwner events. It cannot see a slot's very first key (swapped in directly at install); the search is best effort and never blocks staging if the RPC refuses it.
       - Ledger: the two-level path is a valid BIP-32 path but non-standard in depth; the Ethereum app may warn about or refuse it. To verify on a device before relying on Ledger profiles.
     - 4j-12. Several Safes per profile. Done 2026-10-08. A profile's settings list every Safe it signs for plus the one shown (older single-Safe settings convert on read). Each Safe gets its own session while the profile is unlocked, so each keeps its own queue and automatic refills; the shown one drives the screens and the dApp browser (which closes on a switch). The Safe card at the top of the sidebar opens a switcher with each Safe's network, slot, transactions waiting for you and queued actions, plus Add a Safe (the usual Join, Create, Invite and Being-added choices). Settings has Add another Safe and Remove from Cicada (forgets the Safe on this device only). One seed's Safes never share keys: each has its own account (4j-11), and the gas account is shared.
     - 4j-11. Per-Safe key path. Done 2026-10-08. New trees derive key `i` at `m/44'/60'/{account}'/0/{i}`, where the hardened account is a hash of the chain and Safe (`safeAccount`, in [100,000, 2^31 - 2^20)). Two Safes of one seed now share keys only if their accounts collide, about 1 in 2 billion, instead of about 1 in 50,000 for overlapping 10,000-key ranges in the earlier layout (`m/44'/60'/{base + i}'/0/0`). The tree file records its path template; joining tries the per-Safe account first, then the ranged base, then the legacy base 100,000, so existing Safes keep working. The generator defaults to the new layout (`--layout range` for the old one). Trade-off: one Safe's keys share a parent at the account level, so that account's extended public key (never exported) would link them.
     - 4j-10. Unused-key check. Done 2026-10-08. A key counts as used if its nonce is above zero on the Safe's network or on Ethereum mainnet (it signed a transaction, so its public key is out). Unreadable networks fail closed.
       - Slot packages (new Safe, being added) start at the first run of six consecutive unused keys instead of always index 0; the install and `addSlot` accept any start.
       - Refills stage only the unused keys before the first used one, and refuse when the next key is used.
       - Every minute the app checks its current key, staged keys and the next five; a used one raises a critical finding, and Overview offers Skip used keys: one proposal that calls `skipTo` past the last used key and stages the next fresh run in the same transaction (skipping empties the buffer, so the slot is never left without staged keys). A current key that has sent a transaction outside rotation is flagged for force-rotation.
       - Limits: off-chain signatures (permits, sign-in, signatures elsewhere) leave no nonce, so the derived base per Safe stays the main protection; only the Safe's network and mainnet are checked.
   - Sepolia validation: deploy the guard, create a 2-of-3 Safe in Safe{Wallet} with three independent test signers, install through the app, and settle the open questions in section 10. Test seeds live in `.sepolia/` (gitignored, testnet only).
5. Keeper: buffer refills and gas top-ups.
6. Audit, then mainnet canary.
7. Hash-based EIP-1271 co-signer (path out of bunker mode).
8. Optional hardening: private signature collection through a standalone signing app (option B), which removes the Transaction Service exposure window entirely.
9. v2: RotatingWallet, our own multisig where every approval is on-chain and rotates its key (section 13). Planned, not scheduled.

## 13. v2: RotatingWallet (planned, not scheduled)

Planned 2026-10-08. v1 (Safe 1.5.0 plus RotationGuard) stays the production path until v2 is built, tested, audited and has run as a mainnet canary. This section replaces the earlier "rotating approvals module" proposal; the module on Safe is kept as the fallback in 13.11.

### 13.1 Goal

Our own multisig wallet in which a signer key is used exactly once, and the call that uses it also replaces it. There are no off-chain confirmations waiting anywhere, so a key is never exposed while it is still an owner. Every new Ledger or seed can join, and signers can be added later.

v1 needs the threshold−1 confirmation rule, the last-signer-executes rule with a pre-validated signature, exact signature lengths, nonce-ordering checks, staging with a ring buffer and a keeper, Merkle proofs, the Transaction Service, and just-in-time gas funding with sweeps. v2 needs none of them.

### 13.2 Decisions

- Standalone wallet, not a Safe module. The module design (13.11) stays the fallback if leaving Safe's audited vault and ecosystem turns out too costly.
- Approvals are on-chain. Each approval is an EIP-712 signature by the slot's current owner key, submitted and verified on-chain in the same call that rotates the slot to its next owner.
- Approvals are relayed. A per-app gas account submits them, so owner keys never hold ETH and never become on-chain accounts (no account creation, no funding, no sweeps).
- The next owner is committed one step ahead (13.4), not by a Merkle tree. The app derives keys from the seed by index as in v1, but no tree file exists.
- No message signing (EIP-1271) at first. dApps that need it are refused, as in the v1 dApp browser. Open question in 13.12.
- Immutable implementation, one minimal proxy (ERC-1167) per wallet, created through our factory with CREATE2.

### 13.3 Threat model recap

The adversary can derive a private key from an exposed public key, possibly fast. A key is exposed by any signature it makes, including one sitting in a mempool or a failed transaction. Addresses alone reveal nothing. So:

- a key may sign only in a call that also rotates it away;
- the replacement must already be fixed before the key signs, so an attacker who derives the key in flight cannot choose the next owner;
- anything that can make a signed approval land without rotating (a revert, a dropped transaction) must be prevented or recoverable.

### 13.4 Next-owner commitment

Each slot stores `owner` and `nextCommitment = keccak256(abi.encode(wallet, chainId, slotId, index + 1, nextOwner))`. An approval by the owner at `index`:

- reveals `nextOwner`, which must hash to `nextCommitment`;
- supplies the commitment for `index + 2`.

The contract sets `owner = nextOwner`, stores the new commitment and increments `index`, all in the approval call.

If an attacker derives the key in flight and front-runs the approval, they must still reveal the committed next owner. They can only plant a wrong commitment for the step after, which freezes the slot: the legitimate next owner cannot match it. They cannot take the slot, and their approval is one vote at most. A frozen slot is reset by the other signers (`resetSlot`, 13.5). Private submission makes a front-run unlikely in the first place.

Compared with v1's Merkle tree: no tree to generate or store, no proofs in calldata, one storage write per rotation. The cost is that a front-run freezes the slot rather than being harmless. If audit or review prefers the stronger guarantee, the slot can commit to a Merkle root of its key sequence instead, with the same interface plus a proof argument.

### 13.5 Contract

State per wallet:

- slots, each with `owner`, `index` and `nextCommitment`;
- `threshold` and `slotCount`;
- proposals, each with the hash of its call list, deadline, approval bitmap by slot ID, and status (open, executed, failed, cancelled);
- a sequential proposal ID.

Functions:

- `propose(calls, deadline, approval) → id`: only a signer can propose, and proposing counts as their approval, so it rotates them. Calls are stored as a hash; the full calls go in an event for the app to read.
- `approve(id, approval)`: checks the signature against the slot's current owner and index, checks the commitment, records the slot's bit, and rotates.
- When an approval reaches the threshold, it executes the calls. The execution runs through a self-call whose failure is caught: a reverting payload marks the proposal failed but never undoes the rotation. `execute(id)` lets anyone retry a failed or deferred execution once the threshold is met.
- `revoke(id, approval)`: withdraws an approval; it is itself a key use, so it rotates.
- Self-administration, only through proposals the wallet makes on itself:
  - `addSlot(owner, commitment, newThreshold)`, `removeSlot(slotId, newThreshold)`, `changeThreshold(n)`;
  - `resetSlot(slotId, owner, commitment)` for a frozen, lost or leaked slot (the v1 force-rotate case).
- Receiving: plain ETH, ERC-721 and ERC-1155 receiver hooks, ERC-165.

Approval payload (EIP-712, domain = wallet and chain): `Approve(uint256 proposalId, bytes32 callsHash, uint256 slotId, uint32 index, address nextOwner, bytes32 nextNextCommitment)`, and `Revoke` likewise. Binding to `index` makes every signature single-use even before the owner changes.

Rules the contract enforces:

- one approval per slot per proposal;
- approvals are recorded by slot ID, so they survive the rotations they cause;
- proposals are immutable, and an expired proposal cannot be approved or executed;
- execution is a CALL per entry, with no delegatecall;
- the wallet's own admin functions are reachable only as calls from the wallet to itself.

Creation:

- `factory.create(salt, slots, threshold)` deploys a clone at a CREATE2 address derived from the creator and their salt, and initializes it in the same transaction. The address is predictable before creation, and nobody else can front-run initialization at that address. This is one transaction, against v1's two.
- Initial slots are each signer's index-0 address and the commitment to index 1.

### 13.6 App

- **Keys:** as in v1, slot keys are at `m/44'/60'/{base+i}'/0/0` with a base per wallet. To approve, the app derives key `i` to sign, `i+1` to reveal, and `i+2` to commit. Nothing else is stored.
- **Gas account:** a per-app account (the seed's first account as in v1, or a separate seed in the vault). It submits every proposal and approval through a private RPC, and is never an owner. It holds only gas money; anyone can top it up. Any signer's gas account can relay anyone's approval, so no single relayer is needed.
- **Signing discipline:** sign only immediately before submitting, never store signatures, and simulate first. If a submission is dropped or reorged out, resubmit the same signature: the state it checks is unchanged. Never sign a fresh one with the same key.
- **Queue:** pending proposals come from the wallet's events, with no Transaction Service. The New transaction screen and the dApp browser propose in the same way as today.
- **Setup:** each signer sends the creator their index-0 address and their index-1 commitment. This is far smaller than v1's slot package, since it carries no proofs. The creator creates the wallet in one transaction.
- **Ledger:** approvals are EIP-712, which the device can show field by field. A clear-signing descriptor (ERC-7730) is needed for the call list itself.

### 13.7 Gas (to measure before committing to v2)

- Expected per approval on mainnet: about 21k base, plus calldata, the approval bit, one owner write and one commitment write. That is roughly 50 to 80k.
- The proposal adds its event data.
- The final approval adds the calls themselves.
- Compare against v1's single rotating execution (about 650k gas for a 2-of-3 transfer on repriced Sepolia) plus v1's staging transactions and execution funding.
- Since owner keys never hold ETH, the repriced account creation (about 205k gas per fresh account on Sepolia) never applies.
- Measure on a mainnet fork and on Sepolia for 1-of-1, 2-of-3 and 3-of-5.

### 13.8 Caveats and mitigations

- **Signed but not rotated:** a reverted, out-of-gas or dropped submission publishes a signature without rotating. Mitigations:
  - simulate before submitting, with a generous gas limit;
  - use a private relay that does not include reverting transactions;
  - make the payload's failure unable to revert the rotation (13.5);
  - resubmit the same signature after a drop;
  - `resetSlot` by the others as the last resort.
- **Front-running by a fast attacker:** the outcome is a frozen slot and one stray vote, never a takeover (13.4). Private submission makes it unlikely.
- **Concurrency:** two approvals by the same slot in one block. The second one fails its index check, and its signature is then exposed for a key that already rotated away, which is harmless. The app serializes approvals per slot.
- **Relayer liveness:** if the gas account is empty, any other signer's app or any account can relay, since signatures do not depend on who submits.
- **Visibility:** proposals and their calls are public on-chain, as they are in the Transaction Service today.
- **Ecosystem:** no Safe{Wallet}, Transaction Service, Safe modules or Safe-specific dApp support. Our app is the interface; the dApp browser presents the wallet as the account.
- **Audit scope:** the whole wallet, factory and clone pattern, instead of a guard on top of an audited Safe.
- **No message signing:** some dApp flows (permits, off-chain orders, sign-in) will not work until EIP-1271 is decided.

### 13.9 Testing

Same bar as v1: unit tests, invariant and fuzz suites, and mutation testing. Invariants include:

- every executed proposal had at least `threshold` distinct slot approvals;
- every slot owner changes exactly when it approves, revokes or proposes;
- no owner address ever repeats across a slot's history;
- a revealed next owner always matches the stored commitment;
- a payload revert never undoes a rotation;
- admin functions are reachable only by the wallet itself.

### 13.10 Migration from v1

1. Create the v2 wallet with the same signers, each on a fresh index range.
2. Move assets from the Safe with ordinary v1 transfers, one rotating execution per batch.
3. Point the app at the new wallet.

The Safe can remain as an empty, guarded vault or be retired.

### 13.11 Fallback: rotating approvals as a Safe module

The same approval and commitment logic implemented as a module on Safe:

- the Safe keeps the funds and its address;
- Safe's own owners become unusable placeholders;
- the guard blocks `execTransaction`;
- the module executes through `execTransactionFromModule`.

This keeps the audited vault and Safe{Wallet} as a viewer, at the cost of Safe's gas overhead and a more complex migration.

### 13.12 Open questions

- EIP-1271 message signing: support it with an on-chain approval per message (each one rotating), or keep refusing.
- Commitment or Merkle root per slot (13.4).
- Auto-execution on the final approval, or always a separate `execute`.
- A separate gas seed or the seed's first account as the gas account.
- Optional spending limits or timelocks for large transfers.

### 13.13 Milestones

1. v2-1. Specification and invariants (this section turned into a spec).
2. v2-2. Contract, factory and clone, with unit, invariant, fuzz and mutation tests.
3. v2-3. Gas measurements against v1 on a mainnet fork and on Sepolia. Go or no-go.
4. v2-4. App: approvals, gas account relay, wallet creation, event-based queue, dApp browser.
5. v2-5. Sepolia with independent test signers.
6. v2-6. Audit.
7. v2-7. Migration tooling and mainnet canary.

## 14. Key derivation and the collision analysis

Added 2026-10-08. Where a signer's keys for each Safe live, and why two Safes of one seed sharing a key is no longer a practical concern.

### 14.1 The threat

A seed (or Ledger) can sign for several Safes, possibly from different computers that never talk to each other. If two of those Safes used the same key at some position, a key exposed by signing in Safe A could later be rotated into Safe B as a fresh owner: a silent break of B's guarantee for that signer's slot. Only the same seed can collide with itself: different seeds derive independent keys, and two distinct keys sharing an address is a 160-bit hash collision (about 2^-160).

### 14.2 The three layouts

| Layout | Key `i` at | Where the numbers come from | Status |
|---|---|---|---|
| Ranged | `m/44'/60'/{base + i}'/0/0` | `base = 100,000 + keccak(chain, Safe) mod 10^9` | First Sepolia Safes |
| One-level per Safe | `m/44'/60'/{a}'/0/{i}` | `a = 100,000 + h mod S`, `S = 2^31 - 2^20 - 100,000 = 2,146,335,072` | Briefly on 2026-10-08 |
| Two-level per Safe | `m/44'/60'/{a}'/{b}'/{i}` | `h = keccak(chain, Safe, "cicada/two-level")`; `a = 100,000 + h mod S`; `b = (h >> 128) mod 2^31` | Current, all new Safes |

Every device computes `a` and `b` from the chain and Safe address alone, so no coordination or shared registry is needed, which is what makes the result hold across computers.

### 14.3 Collisions with ordinary wallets and with earlier layouts: impossible by construction

BIP-32 derives each child from its parent with a distinct index, and two different child indexes under the same parent give different keys except with probability around 2^-256 (it would take an HMAC-SHA512 collision). Compare the fourth level of each path:

- ordinary wallets (Ledger Live, MetaMask, any BIP-44 account) use `/0/` there, a non-hardened index 0;
- the ranged and one-level layouts also use `/0/` there, but differ from wallets in the account level (at least 100,000) and from each other per Safe;
- the two-level layout uses `{b}'`, a hardened index, which is always at least 2^31 and therefore never equal to the non-hardened 0.

So a two-level key can never equal a key of an ordinary wallet path or of either earlier layout, whatever account numbers they use. It could only meet another two-level key, which requires both `a` and `b` to match.

### 14.4 Collisions between two-level Safes: the bound

Model keccak as a random function. `a` takes one of `S = 2,146,335,072` values (modulo bias at most `S / 2^256`, about 2^-225) and `b` one of `2^31 = 2,147,483,648` values (exactly uniform: the low 31 bits of a 128-bit value), so `(a, b)` is uniform over

`N = S × 2^31 = 4,609,219,470,248,902,656 ≈ 4.61 × 10^18`

pairs. Two different Safes of one seed collide with probability `1/N`. For one seed in `n` Safes, the union bound over the `n(n-1)/2` pairs gives

`P(any collision) ≤ n(n-1) / (2N)`

| Safes per seed | Two-level (now) | One-level | Ranged |
|---|---|---|---|
| 2 | ≤ 2.2 × 10^-19 (1 in 4.6 × 10^18) | 4.7 × 10^-10 | 2 × 10^-5 (1 in 50,000) |
| 10 | ≤ 9.8 × 10^-18 | 2.1 × 10^-8 | 9 × 10^-4 |
| 100 | ≤ 1.1 × 10^-15 | 2.3 × 10^-6 | about 0.1 |
| 1,000 | ≤ 1.1 × 10^-13 | 2.3 × 10^-4 | about 1 |
| 10,000 | ≤ 1.1 × 10^-11 | about 0.02 | about 1 |
| 1,000,000 | ≤ 1.1 × 10^-7 | certain | certain |

(Ranged: two 10,000-key ranges in a span of 10^9 overlap when their starts are within 10,000, about `2 × 10,000 / 10^9` per pair.)

Across a whole user base: a billion seeds, each signing for 10 Safes, expect about `10^9 × 9.8 × 10^-18 ≈ 10^-8` colliding seeds in total. For scale, that is far below the chance of an undetected hardware fault corrupting a signature, and no larger than other risks the design already accepts.

What this does and does not claim: a collision is not mathematically impossible, but with fewer than about 10,000 Safes per seed it is below 10^-11, and with any realistic count it is negligible by many orders of magnitude. Against ordinary wallets and the earlier layouts (14.3) it is impossible outright.

### 14.5 Defenses on top of the math

- **Guard history:** before installing or staging, Cicada reads the guard's `OwnerStaged` and `OwnerRotated` events (from the first deployment, in 45,000-block chunks, cached) and refuses any key already staged or rotated to for another Safe. This is on-chain, so it covers other computers too. It cannot see a slot's very first key, and is best effort if an RPC refuses the search.
- **Nonce check:** a key that has sent a transaction on the Safe's network or on mainnet is never installed or staged.
- **Fresh starts:** slot packages begin at the first run of six unused keys; `skipTo` (Skip used keys) moves a slot past a key found used later.

### 14.6 Cost

Each path level is one fixed-cost derivation step, whatever its number, and every layout has five levels, so the two-level path costs the same per address on a seed or a Ledger. The time on a Ledger is its public-key computation and USB round trip (roughly 30 to 100 ms per address, several minutes for 10,000). The app does not speed this up by exporting an extended public key, since that would put a whole slot's future public keys in one place. Open item: confirm on a real Ledger that the Ethereum app accepts the hardened fourth level without refusing it.

