# relayer/

TypeScript daemon that bridges Portaldot V3's EVM contracts to the Substrate staking pallet.

Stack:

- `@polkadot/api` for Substrate side (SS58 account, `staking.*` extrinsics)
- `viem` / `ethers` for EVM side (watch events, call `notifyReward`, submit oracle proofs)
- [`@portastake/sdk`](../sdk/README.md) for the x402 facilitator, the sample paid tool, the x402 client and the mandate keeper

See `../docs/ARCHITECTURE.md` §"Why pallet-revive matters" for why this daemon exists.

Responsibilities:

| Job | EVM side | Substrate side |
|---|---|---|
| Staking bridge | watch `StakingVault` deposits, call `sweepToStake` | `staking.bond` / `bond_extra` / `nominate` |
| Rewards | `StakingVault.notifyReward{value}` each era | watch `staking.Rewarded`, `payout_stakers` |
| Slow exits | `StakingVault.fulfillUnstake{value}` | `staking.unbond` → `withdraw_unbonded` |
| Price feed | `SwapDesk.setPrice` (FEEDER_ROLE) | read the Native/7777 `assetConversion` pool |
| Mandate keeper | scan `MandateManager.isDue`, call `execute(id)` (`npm run run-mandates`) | — |
| x402 facilitator | verify and settle signed xUSD payments (`npm run x402:facilitator`) | — |

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
