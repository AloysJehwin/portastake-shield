# relayer/

TypeScript daemon that connects Portaldot's EVM to its Substrate staking pallet and carries bridge transfers between chains.

```sh
npm install
cp .env.example .env     # fill in the keys you have
npm run check            # one read-only pass against the live chains; sends nothing
npm start                # run every job
npm start -- --only=price --once
```

| Job | Every | What it does |
|---|---|---|
| `price` | 5 min | Reads the Native/7777 `assetConversion` pool and calls `SwapDesk.setPrice` when the feed is half way to stale or the pool moved 1%. Refuses jumps over 50% |
| `staking` | 10 min | Maps the stash if needed, `sweepToStake`, `staking.bond` / `bond_extra` + `nominate`, claims each finished era, and reports rewards with `notifyReward{value}` |
| `bridge` | 15 s | Scans `Locked` on each deployed chain, waits for finality, signs, and calls `release` on the destination. Failed deliveries back off and retry |

State lives in `.state/state.json`. Losing it is safe for the bridge (it rescans, and `processed` blocks double pays). For staking, it loses any rewards claimed but not yet reported.

## Keys

| Env | Needs |
|---|---|
| `RELAYER_KEY` | `RELAYER_ROLE` and `FEEDER_ROLE` on Portaldot (the deployer has both), and gas on every bridge chain |
| `BRIDGE_SIGNER_KEYS` | Registered with `setSigner`. Use a separate key |
| `STASH_SURI`, or `STASH_JSON` + `STASH_PASSWORD` | The sr25519 stash, with enough tPOT for fees and the mapping deposit |

## Tests

```sh
npm test            # sweep, bond, price and account-mapping logic
npm run e2e:bridge  # real contracts + real relayer on three local anvil chains (run forge build first)
```

**Not exercised on-chain yet:** the staking path (`mapAccount`, `bond`, `nominate`, `payoutStakersByPage`, `notifyReward`). It was only read-tested against the live node, because the stash has no funds. Watch the first real pass.

Not built: slow-exit fulfilment (`fulfillUnstake`), policy-NFT minting, save/pay automation and the attester daemon.

`npm run run-mandates` runs the mandate keeper separately: it scans `MandateManager.isDue` and calls `execute(id)`.

## x402 payments

[x402](https://github.com/x402-foundation/x402) is pay-per-request over HTTP: a server answers `402 Payment Required` with a price, the client signs a stablecoin payment and retries, and a facilitator settles it on-chain. On Portaldot V3 (`eip155:420420777`) it settles in **xUSD** (`X402Dollar`, `contracts/src/X402Dollar.sol`), a 6-decimal test stablecoin with EIP-3009 `transferWithAuthorization`.

| File | Role |
|---|---|
| `x402/facilitator.mjs` | Standard facilitator API (`/supported`, `/verify`, `/settle`) on the official `@x402/evm` exact scheme. Pays the gas; funds move straight from payer to `payTo` |
| `x402/server.mjs` | Sample paid API: `GET /api/vault-stats` for 0.01 xUSD |
| `x402/client.mjs` | Pays for and fetches a URL. Spend controls allow only xUSD, capped per request (`MAX_PAY`, default 1 xUSD) |

```sh
FACILITATOR_KEY=0x... npm run x402:facilitator   # :4020 (needs tPOT for gas)
PAY_TO=0x...          npm run x402:api           # :4021
PAYER_KEY=0x...       npm run x402:pay           # payer needs xUSD only, no tPOT
```

The web app's **Pay per use** page (`frontend/src/pages/PayPerUse.tsx`) is a browser client for the same API: it reads the price from the 402, has the connected wallet sign the payment, and lists the wallet's past payments. Point it at the API with `VITE_X402_API_URL` (default `http://localhost:4021`); the API allows the dev origin via `CORS_ORIGINS`.

**Savings ⇄ xUSD.** `XusdGateway` (`contracts/src/XusdGateway.sol`) swaps xUSD and tUSD 1:1 from stock it holds and calls the SwapDesk: `depositXusd` turns xUSD into stPOT, `withdrawToXusd` turns stPOT into xUSD for any receiver. The app's Deposit and Withdraw pages offer xUSD, and Pay per use links to both. Keep it stocked: `tUSD.mint(gateway, …)` for deposits, and xUSD from the faucet for withdrawals; a swap it can't cover reverts.

Fund a payer with xUSD from a funded key: `xUSD.faucet(amount)` (up to 1,000 per call), then `transfer` to the payer.
