# rotation-signer

Confirms and executes Safe transactions with your **current** rotation key, so you never import or switch wallet accounts after a rotation. It reads which tree index currently owns your slot on-chain, derives exactly that key from your seed (or uses your Ledger), and refuses anything that would break the rotation rules.

Safe{Wallet} stays where transactions are created and the queue is viewed. This tool only does the two steps that need your key: confirm, and execute.

## Desktop app

```sh
# From the repository root
npm install
npm run build
npm run desktop -w signer
```

On first launch, import your seed phrase and choose a password: the seed is encrypted (scrypt and AES-256-GCM) into the app's data folder and never stored in plain text. Each later launch asks for the password. Then choose your tree file and an RPC; the app checks your key against the chain before saving. Settings changes them later, and Lock clears the key from memory.

Your seed's first account is your operator account (the wallet you were an initial owner with); your rotation keys are derived from the same seed on their own paths.

The window runs the same UI as the command-line version, but talks to the signing process directly instead of through a local web server, so there is no port and no session token. It is isolated from Node, sandboxed, and opens explorer links in your browser. Ledger signing is available in the command-line version; in the desktop app it needs the Ledger USB library rebuilt for Electron, which is not done yet.

## Command line

```sh
# From the repository root
npm install
npm run build

node signer/dist/cli.js --tree slot0.json --rpc <your RPC> --mnemonic-file seed.txt
node signer/dist/cli.js --tree slot0.json --rpc <your RPC> --ledger
```

It prints a link like `http://127.0.0.1:7373/#token=…`. Open it; that is your signer. The link contains a session token: anyone with it can ask this signer to sign, so do not share it.

- `--tree`: your tree file from `rotation-tree generate`. It names the Safe, the chain and your slot.
- `--rpc` (or `RPC_URL`): any RPC for reading.
- `--execution-rpc`: where executions are sent. Defaults to Flashbots Protect (`rpc.flashbots.net`, or `rpc-sepolia.flashbots.net`), which keeps the transaction private and does not publish it if it would revert.
- `SAFE_API_KEY`: sent to the Safe Transaction Service if set.

## What it enforces

- Only one signer short of the threshold may confirm off-chain; the last signer executes with their own signature (the guard rejects anything else).
- Transactions are handled in nonce order, and confirmations that would leave a full threshold of exposed keys across the queue are refused.
- Every slot involved must have a staged next address, or the action is refused with the reason.
- Each transaction's hash is recomputed from its fields; the Transaction Service is not trusted for it.
- Executions are simulated first and sent only through the execution RPC.

## Local demo

```sh
npm run build -w signer
npm run demo -w signer
```

Starts anvil with a guarded 2-of-3 Safe, an in-memory Transaction Service with one pending transfer, and three signers (one per test seed), and prints a link for each. Confirm in signer 1, execute in signer 2, and watch both rotate.
