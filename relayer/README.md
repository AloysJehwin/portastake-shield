# relayer/

TypeScript daemon that bridges Portaldot V3's EVM contracts to the Substrate staking pallet.

Stack:

- `@polkadot/api` for Substrate side (SS58 account, `staking.*` extrinsics)
- `viem` / `ethers` for EVM side (watch events, call `notifyReward`, submit oracle proofs)
- `@x402/*` for the x402 facilitator and sample paid API

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

Fund a payer with xUSD from a funded key: `xUSD.faucet(amount)` (up to 1,000 per call), then `transfer` to the payer.
