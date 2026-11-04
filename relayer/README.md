# relayer/

TypeScript daemon that connects Portaldot's EVM to its Substrate staking pallet and carries bridge transfers between chains.

```sh
npm install
cp .env.example .env     # fill in the keys you have
npm run check            # one read-only pass against the live chains; sends nothing
npm start                # run every job
npm start -- --only=price --once
```

The x402 facilitator, sample tool, x402 client and mandate keeper (`x402/`, `scripts/run-mandates.mjs`) are built on [`@portastake/sdk`](../sdk/README.md).

| Job | Every | What it does |
|---|---|---|
| `price` | 5 min | Reads the Native/7777 `assetConversion` pool and calls `SwapDesk.setPrice` when the feed is half way to stale or the pool moved 1%. Refuses jumps over 50% |
| `staking` | 10 min | Maps the stash if needed, `sweepToStake`, `staking.bond` / `bond_extra` + `nominate`, claims each finished era, and reports rewards with `notifyReward{value}` |
| `bridge` | 15 s | Scans each chain for transfers, waits for finality, then pays from the relayer wallet on each wallet-held side (every chain today), or calls `release` on a chain with a `TokenBridge`. Failed deliveries back off and retry |

The `price` job can also run without the daemon: `.github/workflows/price-feed.yml` runs it hourly, using the `RELAYER_KEY` repository secret, and can be started by hand from the Actions tab.

State lives in `.state/state.json`. Losing it is safe for the bridge: it rescans, contract sides check `processed`, and wallet payouts are recognized by their on-chain tags. For staking, it loses any rewards claimed but not yet reported.

## Keys

| Env | Needs |
|---|---|
| `RELAYER_KEY` | `RELAYER_ROLE` and `FEEDER_ROLE` on Portaldot (the deployer has both), and gas on every bridge chain. This wallet also holds every bridge side, so it needs tUSD on Portaldot and USDC on the other chains |
| `BRIDGE_SIGNER_KEYS` | Registered with `setSigner`. Use a separate key |
| `STASH_SURI`, or `STASH_JSON` + `STASH_PASSWORD` | The sr25519 stash, with enough tPOT for fees and the mapping deposit |

## Tests

```sh
npm test            # sweep, bond, price, account-mapping and calldata-tag logic
npm run e2e:bridge  # real contracts + real relayer on three local anvil chains, with crashes mid-payout (run forge build first)
```

**Not exercised on-chain yet:** the staking path (`mapAccount`, `bond`, `nominate`, `payoutStakersByPage`, `notifyReward`). It was only read-tested against the live node, because the stash has no funds. Watch the first real pass.

Not built: slow-exit fulfilment (`fulfillUnstake`), policy-NFT minting, save/pay automation and the attester daemon.

`npm run run-mandates` runs the mandate keeper separately: it scans `MandateManager.isDue` and calls `execute(id)`.

## x402 payments

[x402](https://github.com/x402-foundation/x402) is pay-per-run over HTTP: a server answers `402 Payment Required` with a price, the client signs a stablecoin payment and retries, and a facilitator settles it on-chain. On Portaldot V3 (`eip155:420420777`) it settles in **xUSD** (`X402Dollar`, `contracts/src/X402Dollar.sol`), a 6-decimal test stablecoin with EIP-3009 `transferWithAuthorization`.

| File | Role |
|---|---|
| `x402/facilitator.mjs` | Standard facilitator API (`/supported`, `/verify`, `/settle`) on the official `@x402/evm` exact scheme. Pays the gas; funds move straight from payer to `payTo` |
| `x402/server.mjs` | Sample paid tool: `GET /api/vault-stats` for 0.01 xUSD |
| `x402/client.mjs` | Pays for and fetches a URL. Spend controls allow only xUSD, capped per request (`MAX_PAY`, default 1 xUSD) |

```sh
FACILITATOR_KEY=0x... npm run x402:facilitator   # :4020 (needs tPOT for gas)
PAY_TO=0x...          npm run x402:api           # :4021
PAYER_KEY=0x...       npm run x402:pay           # payer needs xUSD only, no tPOT
```

The web app's **On-chain tools** page (`frontend/src/pages/Tools.tsx`) runs four paid tools (vault health, desk price check, wallet report, mandate scan) served by the app itself at `/api/tools/*` (`frontend/api/`, Vercel functions with an in-process facilitator). It reads each price from the 402, has the connected wallet sign the payment, and lists the wallet's past runs. Locally, `FACILITATOR_KEY=0x… pnpm tools` serves them on :4021 and Vite proxies `/api` there.

**Savings ⇄ xUSD.** `XusdGateway` (`contracts/src/XusdGateway.sol`) swaps xUSD and tUSD 1:1 from stock it holds and calls the SwapDesk: `depositXusd` turns xUSD into stPOT, `withdrawToXusd` turns stPOT into xUSD for any receiver. The app's Deposit and Withdraw pages offer xUSD, and On-chain tools links to both. Keep it stocked: `tUSD.mint(gateway, …)` for deposits, and xUSD from the faucet for withdrawals; a swap it can't cover reverts.

Fund a payer with xUSD from a funded key: `xUSD.faucet(amount)` (up to 1,000 per call), then `transfer` to the payer.
