# rotation-signer

Confirms and executes Safe transactions with your **current** rotation key, so you never import or switch wallet accounts after a rotation. It reads which tree index currently owns your slot on-chain, derives exactly that key from your seed (or uses your Ledger), and refuses anything that would break the rotation rules.

It also proposes new transactions: **New transaction** on the Transactions page sends ETH or an ERC-20 token, or force-rotates chosen slots (for keys exposed outside a transaction). Your signature on the proposal counts as your confirmation, so another signer executes it and both of you rotate. It proposes only when nothing else is pending and the Safe holds enough to pay. Safe{Wallet} remains available for anything else and as a viewer.

## Desktop app

```sh
# From the repository root
npm install
npm run build
npm run desktop -w signer
```

On first launch, enter your seed phrase, a password and, to join an existing Safe, its address. That is all. The seed is encrypted (scrypt and AES-256-GCM) into the app's data folder, and the app then works out the rest itself:

- the network (it looks for the Safe on Ethereum and Sepolia),
- which signer you are, by matching the key your seed holds at each slot's current tree index against the slot's on-chain owner, so it works however many times you have already signed,
- your rotation keys, rebuilt from the seed and checked against the root committed on-chain.

### Profiles

The app holds any number of profiles, each one wallet with its own Safe: a seed phrase (encrypted with its own password) or a Ledger (nothing secret is stored; the app recognizes the device by its first address and refuses a different one). Choose a profile at launch, switch from the sidebar, and rename or remove it in Settings. One profile is unlocked at a time; switching locks the current one. An install from before profiles is moved into a first profile automatically.

Ledger profiles use the Ledger's USB library inside the desktop app; it loads without a rebuild, but signing has not been run on a real device yet.

To start a new Safe instead, leave the Safe address empty and choose **Create a new Safe**:

1. Every signer opens the app with their own seed and sends the creator their signer address (shown on the setup screen).
2. The creator enters the addresses and the number of signatures needed, and gets an invite code to send to everyone.
3. Each signer chooses **I have an invite** and pastes it. Their app checks it, generates their keys for that Safe and shows a slot package (addresses and proofs only) to send back.
4. The creator pastes each package and clicks **Create Safe**. Their signer address pays the gas for two transactions: creating the Safe, then installing rotation. Each signer's app then connects by itself.

After joining, every signer should check on Overview and Signers that their slot and the threshold are what was agreed, before anyone funds the Safe: the creator installs alone.

It reads the chain through public RPCs; Advanced lets you set your own RPC, an execution RPC, or pin the network. Each later launch asks only for the password. Settings changes the Safe, and Lock clears the key from memory.

Your seed's first account is your operator account (the wallet you were an initial owner with); your rotation keys are derived from the same seed on their own paths.

The window runs the same UI as the command-line version, but talks to the signing process directly instead of through a local web server, so there is no port and no session token. It is isolated from Node, sandboxed, and opens explorer links in your browser. Ledger signing is available in the command-line version; in the desktop app it needs the Ledger USB library rebuilt for Electron, which is not done yet.

### Browsing dApps

**Browse dApps** opens any dApp (https only) inside the app, connected as the Safe. The dApp sees the Safe's address as its wallet; when it sends a transaction, the page is hidden and the app shows what it asks for, decoded and checked by the same rules. **Sign & propose** posts it with your current key's signature as your confirmation, and another signer executes it from their app. Several calls sent together (EIP-5792 `wallet_sendCalls`) become one batched transaction.

- The dApp receives the Safe transaction hash. dApps that support smart accounts track it until execution; others show it as pending.
- Signing messages (log-in messages, permits, off-chain orders) is refused: it would expose your key without the guard rotating it, and the signature would stop working when owners rotate. CoW Swap and others fall back to an on-chain approval for Safes.
- dApps cannot ask the Safe to change owners, threshold, modules or the guard.
- One proposal at a time: if a transaction is pending, execute it first.
- Pages run sandboxed in their own storage, with no permissions and no access to the app; links that open new windows go to your normal browser.

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

### Gas

Your seed's first account is your gas account: it pays for every execution, so your rotation keys never need ETH. When you execute, the app sends your current key exactly the gas it needs, executes, and once the transaction is mined returns everything left on that key to the gas account, leaving the retired key empty (or with a fraction of a gwei). Confirming costs nothing. Keep some ETH in the gas account; Overview shows its balance and warns when it runs low.

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
