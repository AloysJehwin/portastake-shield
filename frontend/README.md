# frontend/

Minimalist light-theme web app for PortaStake Shield, live-wired to the contracts via wagmi + viem. Mobile-first with a glass-nav bar; expands to a sidebar layout on desktop.

## Stack

- Vite 5 + React 18 + TypeScript
- TailwindCSS 3 (design tokens in `tailwind.config.ts`, utilities in `src/styles/index.css`)
- wagmi 2 + viem 2 + @tanstack/react-query
- @rainbow-me/rainbowkit for the wallet modal
- lucide-react for icons
- Chains: `420420777` (Portaldot V3) and `31337` (local anvil)

## Pages

| Route | What it does | Gated by |
|---|---|---|
| `/` | Home. Balance tile, APY chip, policy badge, three CTAs, Safety stats. | — |
| `/deposit` | tUSD → stPOT via `SwapDesk.depositWithStable`, plus a native tPOT alt route via `vault.depositNative`. Live price, fee, slippage, approve-then-deposit flow. | SwapDesk address ≠ 0 (stage 2) |
| `/withdraw` | Instant redeem via desk if under the hot reserve; otherwise `requestUnstake`. Lists the user's pending unstake queue. | — |
| `/automate` | Save-on-autopilot: SAVE RECURRING mandates with pause/resume/cancel. Falls back to a muted empty state while `MandateManager` is undeployed. | MandateManager ≠ 0 (stage 4b) |
| `/tools` | On-chain tools: vault health, desk price check, wallet report and mandate scan, each paid per run in xUSD with x402. The wallet signs; the tools (`api/tools/[name].ts`, Vercel functions) settle the payment on Portaldot through an in-process facilitator. Needs `FACILITATOR_KEY` in the Vercel env; locally run `FACILITATOR_KEY=0x… pnpm tools` next to `pnpm dev`. `/pay-per-use` redirects here. | xUSD ≠ 0 (stage 5) |
| `/activity` | Last 10,000 blocks of the user's events: `StableDeposited`, `StableRedeemed`, `UnstakeRequested`, `UnstakeFulfilled`, `SlashCovered`, `MandateExecuted`. | — |

## Setup

```sh
cd frontend
pnpm install
```

The install enables build scripts for `esbuild`, `keccak`, `bufferutil`, `utf-8-validate` via `pnpm-workspace.yaml` (pnpm 11 moved this out of `package.json`).

## Keeping ABIs and addresses in sync with the contracts

After every `forge build` or stage deploy:

```sh
pnpm sync-abis
```

This script walks `../contracts/out/` for the nine contracts the UI uses and writes typed `const` ABIs to `src/abi/*.ts`, then copies `../contracts/deployments/<chainId>.json` into `src/deployments/`. The deployment JSONs are what feed `src/addresses.ts`; missing files are treated as "not deployed yet" (every address falls through to `0x…000` and the stage-aware UI hides the gated flows).

## Local anvil end-to-end

```sh
# terminal 1 — anvil on 127.0.0.1:8545
anvil

# terminal 2 — deploy the full suite and sync addresses into the frontend
cd contracts
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/DeployAll.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
cd ../frontend
pnpm sync-abis

# terminal 3 — dev server
pnpm dev
```

Then open http://127.0.0.1:5173, add anvil as a custom network in your wallet (chain id `31337`, RPC `http://127.0.0.1:8545`), import an anvil key, and the five pages read live state from the local chain.

## Portaldot V3 testnet

Once the staged deploys have run against the real chain, `pnpm sync-abis` picks up `420420777.json` and the UI switches to live mainnet-grade reads when the wallet is on that chain. No code change needed.

## Design tokens

| Token | Hex | Role |
|---|---|---|
| `bg` | `#FFFFFF` | page background (with a soft three-stop gradient wash the glass panels blur over) |
| `surface` | `#FAFAFA` | solid cards (tables, dense content) |
| `glass` | `rgba(255,255,255,0.55)` | frosted panels — hero card, nav, summary boxes |
| `fg` / `fg-muted` / `fg-subtle` | `#0A0A0A` / `#6B6B6B` / `#A3A3A3` | text ramp |
| `accent` | `#2563EB` | links, focus ring |
| `success` / `danger` | `#10B981` / `#DC2626` | APY on/off, errors |

Fonts: Inter Variable for text, JetBrains Mono for amounts. 4 px spacing grid. Glass surfaces fall back to the solid `surface` token when `backdrop-filter` isn't supported.

## Scripts

```
pnpm dev         # vite dev server
pnpm build       # tsc --noEmit + vite build
pnpm typecheck   # tsc --noEmit
pnpm preview     # serve the built app
pnpm sync-abis   # pull ABIs + deployments from ../contracts
```
