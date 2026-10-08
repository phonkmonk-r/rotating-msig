# rotation-tree

Offline generator for RotationGuard signer trees. Each signer runs it on their own machine to derive fresh owner addresses for their slot, build the Merkle tree and produce the root, proofs and setup data the Safe needs.

## What it produces

A tree file (JSON) holding only addresses, which are hashes of public keys. It never contains public keys, xpubs, private keys or the mnemonic, so it is not secret and does not need to be trusted: every load rebuilds the root from the addresses and rejects any file whose stored root does not match. Pin it to IPFS so anyone (the keeper, the Safe App, another signer) can stage your next addresses.

Leaves are `keccak256(keccak256(abi.encode(chainId, safe, slotId, index, owner)))`, identical to `RotationGuard.leaf`, built with OpenZeppelin's `StandardMerkleTree`. The tree code lives in `packages/core`, shared with the Safe App. `test/GeneratorVector.t.sol` checks this against the contract.

## Usage

```sh
# From the repository root (npm workspace: builds packages/core, then the generator)
npm install
npm run build
cd generator

# Derive 10,000 addresses at m/44'/60'/{base+i}'/0/0 and write the tree file.
node dist/cli.js generate --safe 0xYourSafe --slot 0 --base 100000 --out slot0.json
node dist/cli.js generate --safe 0xYourSafe --slot 0 --base 100000 --out slot0.json --source ledger

# Check the file, compare with the root committed on-chain, and re-derive from your seed or device.
node dist/cli.js verify --tree slot0.json --root 0xOnChainRoot --source seed --sample 100

# Data for the Safe App and keeper.
node dist/cli.js config  --tree slot0.json --cid <ipfs-cid>          # SlotConfig for initialize / addSlot
node dist/cli.js entries --tree slot0.json --from 1 --count 5        # entries for RotationGuard.stage
node dist/cli.js proof   --tree slot0.json --index 42
```

`--chain-id` defaults to 1 and `--size` to 10,000 (about 9 seconds from a seed; about 17 minutes on a Ledger).

## Rules for signers

- **Pick a `--base` that no wallet has ever used.** Addresses depend only on your seed and the account index, not on the Safe. Low account indexes are where wallets put everyday accounts, whose keys may already be exposed, so the CLI refuses bases below 1000 unless you pass `--allow-low-base`. Use a different, non-overlapping range for every Safe.
- **Never share an xpub.** Share the tree file (addresses) only.
- **Seed mode belongs on an air-gapped machine.** The mnemonic is read from a hidden prompt or `--mnemonic-file`, never from a command-line argument. Ledger mode keeps the seed on the device; the device returns each public key with the address, and the CLI drops it immediately.
- **The on-chain root is the trust anchor.** Before the setup transaction is signed, run `verify --root <committed root> --source ...` yourself. A wrong root would hand your slot's future ownership to whoever generated it.
- **A lost tree file is recoverable.** Run `generate` again with the same seed, `--safe`, `--slot`, `--base`, `--size` and `--chain-id`; it reproduces the same root.
- **Use each address only as a Safe owner signing Safe transactions.** Do not fund it from or send transactions with it, and do not use it to sign in to websites or sign other messages; any signature exposes its public key.

## Development

```sh
npm test            # node:test suite, including a check that test/vectors/tree-vector.json is current
npm run typecheck
npm run vectors     # regenerate the cross-check vector after changing the format
```
