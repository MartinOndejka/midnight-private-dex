# Private Order Book DEX

A sample DApp for the [Midnight Network](https://midnight.network/): a limit order book where prices are public and makers are anonymous. It trades two shielded test tokens, BASE and QUOTE, and runs on the **Preview** testnet.

[![Compact Compiler](https://img.shields.io/badge/Compact%20Compiler-0.31.1-1abc9c.svg)](https://docs.midnight.network/relnotes/support-matrix)
[![Midnight.js](https://img.shields.io/badge/Midnight.js-4.1.1-blue.svg)](https://docs.midnight.network/relnotes/support-matrix)

> This is a sample for a testnet. It is not audited. Do not use it with real value.

The project started from the official [`bboard`](https://github.com/midnightntwrk/example-bboard) template (`npx create-mn-app --template bboard`). It keeps the template's wallet, provider and Lace wiring.

## How it works

| Step | Circuit | What is public | What stays private |
|---|---|---|---|
| Get test tokens | `faucet(isBase, amount)` | Token and amount | — |
| Place a limit order | `placeOrder(side, price, size, minFill, coin)` | Side, price, size, min fill, escrow coin | Who placed it: the book stores only `hash(domain, dex, orderId, secretKey)` |
| Fill an order | `fillOrder(orderId, amount, payment)` | Order, amount, payment | Taker wallet (see limits) |
| Claim proceeds | `claim(orderId)` | Order, amount claimed | Maker (proves knowledge of the secret key in ZK) |
| Cancel | `cancelOrder(orderId)` | Order, amounts returned | Maker (same) |

- **The book is lit.** Takers need to see prices, so side, price and size are public.
- **Makers are anonymous.** Each order has its own owner commitment, which includes the order id and the contract address. Thus, the book does not link two orders of one maker, or one maker in two deployments. The secret key stays on the user's machine.
- **Escrow is shielded coins.** When a maker places an order, the contract holds the maker's coin: `size` BASE for a SELL, or `size × price` QUOTE for a BUY. When a taker fills an order, the taker gets that part of the escrow. The taker's payment stays in the contract as *proceeds* until the maker claims it.
- **Taker selects the order.** Compact has no dynamic loops, so there is no matching engine on chain. The taker selects an order and an amount.
- **Price is an integer:** the number of QUOTE units for 1 BASE unit.

### Privacy limits

A security review found these limits. They are part of the design, not bugs:

1. **Use a coin key that you do not share.** The contract ledger holds the coin info of escrow and proceeds in public. The standard library derives output nonces from this info. If a person knows your shielded coin public key, they can match it to your fills, claims, cancels and faucet mints. The book does not link your orders to each other, but a known key can link them.
2. **Fills can delay a claim or cancel.** Each fill changes the order. A fill that lands first makes a pending claim or cancel of the same order fail, so you must send it again. Set `minFill` to limit how many fills a taker can use to do this.
3. **Contention.** All new orders use one shared order counter, and all faucet calls use one shared mint nonce. If two transactions use the same one at the same time, one of them fails. To fix it, send the failed transaction again.
4. **The faucet has no limits.** It is for the testnet only.

## Project structure

```
private-dex/
├── contract/   Compact contract (src/pdex.compact), witnesses, simulator tests
├── api/        PdexAPI: deploy/join, order book state$, faucet/place/fill/claim/cancel
├── dex-cli/    Node CLI with a headless wallet, plus a scripted end-to-end run
└── dex-ui/     React + MUI web app that uses the Lace wallet
```

## Prerequisites

- Node.js 24.11.1 or later (see `.nvmrc`)
- Docker (for the proof server)
- Compact compiler **0.31.1**. Use a pinned version, because the public networks run 0.31.1:
  ```bash
  curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
  compact update 0.31.1
  ```
- For the UI: the Lace wallet with Midnight support, set to Preview, with the proof server at `http://localhost:6300`

## Build and test

```bash
npm install
cd contract
npm run compact   # compile the contract with ZK keys (a few minutes)
npm run build
npm test          # simulator tests: no network, no proofs
```

## Run on Preview

### CLI

```bash
cd dex-cli
npm run preview-remote
```

The CLI starts a proof server in Docker. Then it builds or restores a wallet, requests tNIGHT from the faucet, and registers it for DUST. Then it asks you to deploy a new DEX or join one. To reuse a funded wallet, choose "Build wallet from a seed".

### Scripted end-to-end run

```bash
cd dex-cli
npm run preview-e2e
```

This deploys a DEX, mints BASE and QUOTE, places a SELL order, fills part of it, claims, and cancels. After each step it checks the shielded wallet balances. One wallet does both the maker and the taker steps. To reuse a funded wallet, set `PDEX_SEED=<hex seed>`.

### Web UI

```bash
docker run -d -p 6300:6300 midnightntwrk/proof-server:8.1.3
cd dex-ui
npm run build:start:preview
```

Open the URL that `http-server` prints. Then connect Lace, and deploy a DEX or join one by its address. The UI keeps your DEX secret key in `localStorage` for each wallet and contract. This storage is not encrypted. If you clear it, you can no longer claim or cancel your orders.

## Versions

| Component | Version |
|---|---|
| Compact compiler / language | 0.31.1 / 0.23 |
| Midnight.js, testkit-js | 4.1.1 |
| Wallet SDK | 1.2.0 |
| DApp Connector API | 4.0.1 |
| Proof server | 8.1.3 |

These versions match the [support matrix](https://docs.midnight.network/relnotes/support-matrix) for Preview and Preprod. To use Preprod, run `npm run preprod-remote` with `BLOCKFROST_PROJECT_ID` set.

## License

Apache-2.0. Parts of the CLI, API and UI come from `midnightntwrk/example-bboard`, which has the same license.
