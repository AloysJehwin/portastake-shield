# Architecture

This document holds the design decisions behind PortaStake Shield. Keep high-level product narrative in the root `README.md`. This file is for implementers.

## Why `pallet-revive` matters

Portaldot V3's EVM is `pallet-revive` (PolkaVM), not Frontier's `pallet-evm`. Consequences:

- Standard Solidity compiles and deploys. OpenZeppelin libraries work.
- There is **no Moonbeam-style staking precompile**. A Solidity contract cannot call `staking.bond` or `staking.nominate` directly.
- Precompile set is small: `ecrecover`, `modexp`, `ripemd160`, `sha256`, `blake2f`, `bn128`, point eval. Nothing custom from Portaldot.
- Addresses are SS58-mapped. Users may receive testnet POT only to an SS58 address (`5…`), not an `0x…` address.
- Native token decimals likely differ between Substrate side and EVM side. Resolve at runtime via `system.properties.tokenDecimals` and write into a `DecimalsOracle` contract so the EVM has one source of truth.

The relayer in Layer 2 exists specifically to bridge the gap `pallet-revive` leaves open.

## Trust assumptions, called out plainly

| Risk | v1 | v2 | v3 |
|---|---|---|---|
| Relayer key compromise | Single key, hot | Multisig (3-of-5) | Native staking adapter / pallet-driven |
| Attester collusion | 1-of-3 bootstrap | N-of-M with slashable bonds | Larger committee + stake-weighted governance |
| Governance capture | Deployer-controlled timelock | veSTPOT-controlled timelock | Progressive decentralization milestones |
| Hot reserve shortfall | 10% of TVL | Dynamic sizing from withdraw velocity | Insurance-fund-backed overdraft |

Say v1 out loud in the pitch. Judges reward honesty over hand-waving.

## Chain facts (verified on PortaldotV3 testnet, Oct 2026)

Reproduce with `cd relayer && npm install && npm run probe`.

| Fact | Value | Consequence |
|---|---|---|
| EVM | `pallet-revive`, `allowEVMBytecode = true`, `autoMap = true`, chain id 420420777 | Plain Foundry + solc. 0x accounts auto-map to SS58 |
| WASM | `pallet-contracts` (ink!) alongside revive | Available for a future ink! component |
| Native token | tPOT, 14 decimals, SS58 prefix 42; `nativeToEthRatio = 10000` | EVM sees 18-decimal wei; only multiples of 1e4 wei move as native value |
| Staking | `staking` + `nominationPools` (min join 1 tPOT); 2 validators | No staking precompile; the relayer bonds |
| Timings | era = 6h; unbonding 672 eras ≈ 168 days; slash defer 168 eras ≈ 42 days | Hot reserve is the real liquidity path |
| Gross staking yield | ≈ 25% APY | Funds the 8% target with a large surplus |
| Stablecoins | `pUSD` (asset 7777) + DEX pool Native/7777 on Substrate; no ERC-20 precompile | EVM uses `tUSD`; the relayer prices POT from the Native/7777 pool |
| Storage deposits | 0.06 tPOT/byte, 0.15 tPOT/item | Small contracts, packed structs |

## Contracts as built

See `contracts/README.md`. Everything uses OpenZeppelin v5.4.0.

### Deploy cost — staged

revive holds a storage deposit of ~0.06 tPOT per byte of deployed (init) code, plus instantiate overhead (~20%) and the storage slots written during wiring. Sizes from `forge build --sizes` (`via_ir`, `optimizer_runs = 1`); stage 4 measured live with `relayer/scripts/measure-deploy.mjs`:

| Stage | Deploys | Added cost (tPOT) |
|---|---|---|
| 1 Core | WPOT, InsuranceFund, StabilizationReserve, StakingVault | ~1,450 |
| 2 Desk | MockStable (tUSD), SwapDesk | ~690 |
| 3 Committee | OracleCommittee | ~285 |
| 4 Extras | PolicyNFT (1,936 B), MandateManager (5,451 B) | **~540** |

All four stages are live on V3 (`deployments/420420777.json`). Stage 4 was trimmed to fit: PolicyNFT is a minimal soulbound ERC-721 (read surface + ERC-165 + ERC-5192, every transfer/approval reverts, immutable minter, terms carried in the `TermsSnapshot` event), and MandateManager carries no admin role or global pause, uses a 1-slot reentrancy guard, Solady `SafeTransferLib`, and numeric `InvalidParams` codes. The relayer drives `execute` as keeper (see below).

The vault's `policy` field is settable (admin only), and `_deposit` + `depositNative` skip the mint while it is unset, so stage 1 works without the certificate contract. **Backfill caveat**: users who deposited before stage 4 do not retroactively receive a policy NFT.

On V3, deploy with `scripts/deploy-cast.mjs`: revive folds the storage deposit into gas, which `forge script` under-estimates (error 1010), while `cast send` uses the node's `eth_estimateGas`. The script is re-runnable and reuses anything already deployed. Each stage reads `deployments/<chainId>.json` from the previous stage and writes a merged version back. The in-memory `DeployAll.s.sol` script runs the whole suite in a single broadcast for local chain / CI parity.

Tests use `vm.getBlockTimestamp()` instead of `block.timestamp` for warps: under `via_ir` the compiler may cache `block.timestamp` within a test function.

Changes from the original sketch:
- `Router` → `SwapDesk`: an oracle-priced inventory desk, because no DEX is reachable from the EVM. The POT/USD feed is folded into `SwapDesk` itself (no separate `PriceOracle` contract).
- `InsuranceFund` is a plain WPOT bucket, not ERC-4626, since it has no external depositors in v1.
- `StabilizationReserve` is new.
- `PolicyNFT` is a minimal soulbound ERC-721 + ERC-5192 whose only minter is the vault, attached by an admin `setPolicy` call so it can arrive in a later deploy stage.
- `MandateManager` enforces every save/pay rule itself and exposes a permissionless `execute`. It depends on `SwapDesk` and the vault at construction, so it is naturally deployed last.
- `DecimalsOracle` was dropped: decimals are fixed (14 native, 18 EVM).
- `Governance` and `MiniLend` are deferred. Parameters sit behind the admin role, which moves to a 24h `TimelockController`.

## The 8% target (reserve-backed, POT-denominated)

`StakingVault.notifyReward{value: R}()` runs once per era. `RateEngine.split` decides where `R` goes:

```
owed = totalAssets × targetRateBps(800) × min(dt, maxAccrualWindow) / (10_000 × 365d)

R ≥ owed:  owed → users (streamed over one era)
           (R − owed) × 50% → InsuranceFund
           rest → StabilizationReserve, up to 10% of TVL; overflow → treasury
R < owed:  R + reserve draw → users
           reserve empty → users get what exists; emit RateDowngraded
```

- At today's ~25% gross, each 1,000 POT/yr pays 80 to users, 85 to insurance, and 85 to the reserve. A full reserve (10% of TVL) covers the target for ~15 months of zero yield.
- The users' share vests linearly over one era (sfrxETH pattern), so depositing just before a reward and withdrawing after earns nothing.
- `maxAccrualWindow` (2 days) stops a relayer outage from draining the reserve in one call.
- Transparency for the UI: `lastEffectiveRateBps` on-chain. Reserve runway (days) and insurance ratio are computed in the frontend from public balances, `totalAssets()` and `targetRateBps`.
- The promise is in POT. The USD value shown in the app moves with the POT price, and the UI must say so. Insurance covers slashing, not price.

## Savings automation (`MandateManager`)

| | RECURRING ("auto") | SCHEDULED | THRESHOLD |
|---|---|---|---|
| **SAVE** (wallet tUSD → stPOT) | every `interval` | once at `start` | wallet > `bound` → sweep the excess (capped at `amount`) |
| **PAY** (stPOT → tUSD to payee) | every `interval` | once at `start` | payee < `bound` → top up the gap (capped at `amount`) |

- **Rules** are checked in `MandateManager.isDue` / `execute`: per-run cap, run limit, expiry, threshold bound, cooldown (required for RECURRING and THRESHOLD), pause/cancel, no burst catch-up after downtime. State is written before any token moves.
- **Authority** is the owner's allowance to `MandateManager`: tUSD for SAVE, stPOT for PAY. SAVE shares always go to the owner; PAY goes to the payee fixed at creation. Revoking the allowance or cancelling stops the mandate.
- **Slippage**: PAY has a real floor (`amount × (1 − maxSlippageBps)` tUSD out). The SAVE floor is computed from the same desk price in the same transaction, so it guards against rounding only; the desk's price feed (staleness-checked, feeder-set) is what bounds a SAVE.
- **Keeper**: `execute` is permissionless because revive has no cron. `relayer/scripts/run-mandates.mjs` scans ids `[0, nextId)` with `isDue` and executes each due one; a reverting run leaves the mandate intact and is retried next pass. The keeper chooses only *when* to call, never *how much*.

## Cross-chain bridge

No third-party bridge is available: on 2026-11-03, LayerZero, Across and Wormhole did not list Portaldot, and the live runtime has no XCM or ISMP pallet (`beefy` is the only bridge-related one). So this is a small lock-and-release bridge the relayer runs.

**Portaldot has no bridge contract.** Deploying one costs ~280 tPOT and the deployer has ~44, which is kept for testing. The relayer's wallet holds Portaldot's side instead. Other chains run `TokenBridge`, whose route to Portaldot points at that wallet.

```
INTO PORTALDOT
  Spoke: TokenBridge.bridge(dst, to, amount, minShares) -> tokens locked, Locked emitted
  Relayer waits for finality
  Portaldot: wallet calls SwapDesk.depositWithStable(amount, minShares, to), or tUSD.transfer(to, amount)
             if the desk can't take it

OUT OF PORTALDOT
  Portaldot: user calls tUSD.transfer(wallet, amount) with routing appended to the calldata
  Relayer waits for finality, signers sign
  Spoke: TokenBridge.release(...)
```

- **Routes are hub-and-spoke.** Adding a chain is one entry in `contracts/deployments/bridge-chains.json` plus a deploy run. Spoke-to-spoke goes through Portaldot in two transfers.
- **Calldata tags.** Solidity ignores trailing calldata, so routing and payout ids are appended to ordinary calls, and stay readable on-chain. Bridge-outs carry `PSB1 + uint64 dstChainId + address to`, payouts carry `PSBR + bytes32 releaseId`. A transfer to the wallet with no valid routing is treated as inventory, and that money does not come back automatically.
- **Double payment on Portaldot.** With no contract, nothing on-chain prevents it, so the relayer does (`relayer/src/bridge/hubWallet.ts`). A payout is signed and recorded before broadcast, and its fixed account nonce means rebroadcasting can only land it once. The relayer sends nothing while the wallet has an unconfirmed transaction. Tagged payouts rebuild the paid list from the chain if the state file is lost. The end-to-end test crashes the relayer mid-payout to check this.
- **Limits.** The wallet refuses a payout over 10 tUSD or past 100 tUSD a day, a transaction costing over 20 tPOT, and anything leaving it under 5 tPOT. All are configurable in `relayer/.env`.
- **Spoke side.** `TokenBridge` still enforces signatures, replay protection and a per-transfer cap.
- **Liquidity.** Payouts come from the destination's inventory. The UI refuses a transfer larger than the far side holds. If one still comes up short, it stays pending and delivers after a top-up; there is no refund path.
- **Trust.** One key controls Portaldot's side, and it is also the deployer with admin rights over the protocol. Whoever holds it can take the wallet's tUSD and skip or fake payouts. This is testnet-only and unaudited. Next steps are a real `TokenBridge` on Portaldot once tPOT allows, independent signers, then BEEFY light-client proofs (`beefy` is live).
- **tUSD has an open faucet**, so this demonstrates the flow, not a real stablecoin bridge.

### Going live

Nothing here sends a Portaldot transaction until a user bridges. Each spoke needs its testnet gas token for the deployer and relayer keys.

1. `cd contracts && forge build`, then deploy to the spokes you want:
   `PRIVATE_KEY=... BRIDGE_SIGNER=... node ../scripts/deploy-bridge.mjs base-sepolia`
2. `cd frontend && pnpm sync-abis`.
3. Set `RELAYER_KEY` to the deployer key and `BRIDGE_SIGNER_KEYS` in `relayer/.env`, then `cd relayer && npm start -- --only=bridge,price`.

Real costs on Portaldot, as estimated by the node and possibly overstated: ~11.7 tPOT for a save to a wallet new to stPOT, ~3.9 for paying tUSD to a new wallet, ~0.02 for a price update. Test with one wallet. The desk's POT inventory caps a save (about 15 POT today), and anything larger arrives as tUSD.

## Decimals handling

- Substrate side: tPOT has 14 decimals.
- EVM side: pallet-revive exposes 18 decimals via `nativeToEthRatio = 10000`. Everything on the EVM side uses 18.
- Native value transfers must be multiples of 1e4 wei:
  - `WPOT.withdraw` and `StakingVault.sweepToStake` reject dust.
  - `requestUnstake` rounds down.
- `OracleCommittee` slash amounts are in 18-decimal units. Attesters multiply the Substrate amount by 1e4.

## Relayer ↔ vault account mapping

`StakingVault.stakingAccount` is the H160 of the relayer's SS58 stash. The relayer's sr25519 account calls `revive.map_account` once; its H160 is then the last 20 bytes of `keccak256(AccountId32)`. Native POT the vault sends there lands in the stash, which bonds it with `staking.bond` / `bond_extra` + `nominate`.

**The live vault does not point there yet.** `stakingAccount` is the deployer's H160, whose native balance sits in a fallback account (`<h160> + 0xEE…`) that no sr25519 key can sign for, so POT swept there could not be bonded. The relayer refuses to sweep until an admin calls `setStakingAccount` with the stash's H160 (`0x5868ebFF853c05E7feE6212f693b924AF2bbC6ba` for `5DUuK…`). `bondedPrincipal` is 0, so nothing is stranded.

The stash's reward destination is the relayer's EVM fallback account, so staking rewards land directly in the wallet that pays `notifyReward{value}`.

## Event design

Rich, named events everywhere. Both the frontend and the relayer are event-driven. Minimum per contract:

- `StakingVault`: `Deposit`, `Withdraw`, `Rebalance`, `RewardNotified`, `HotReserveRefilled`, `SlashingPayout`
- `InsuranceFund`: `Funded`, `Payout`
- `OracleCommittee`: `AttesterBonded`, `AttesterSlashed`, `SlashingProofSubmitted`, `SlashingProofFinalized`
- `Governance`: `ProposalCreated`, `Voted`, `TimelockQueued`, `ParameterApplied`
- `PolicyNFT`: `Transfer` (mint only), `Locked`, `TermsSnapshot(id, holder, targetRateBps, insuranceShareBps)`
- `MandateManager`: `MandateCreated`, `MandateExecuted`, `MandatePaused`, `MandateResumed`, `MandateCancelled`

## Development order (concrete)

1. WS probe script that enumerates pallets at `wss://test-node-v3.portaldot.dev` and prints the staking extrinsic signature. **Blocks every other decision below.**
2. Foundry scaffold with `StakingVault` + mock reward emitter. First real commit.
3. `InsuranceFund` + yield-split hook + soulbound `PolicyNFT` minted by the vault. End-to-end Foundry test.
4. Deploy to V3 EVM testnet. Capture addresses + first tx hashes.
5. Relayer v1: watches `Deposit`/`Withdraw`, submits `bond`/`unbond` or `nominationPools.join`/`unbond`.
6. `OracleCommittee` + attester daemon. Mock slashing path first.
7. `Governance` with veSTPOT + 24h timelock. Execute one real parameter change on live testnet.
8. `MiniLend`.
9. `Router` + stablecoin on-ramp (real DEX if available, mocked oracle swap otherwise).
10. Frontend.

## Verification plan — the demo script

Six steps, all on live V3 EVM testnet:

1. User A deposits 100 POT. Receives 100 stPOT. The vault mints her soulbound policy NFT. Dashboard shows deposit.
2. Relayer bonds 100 POT on Substrate side; nominates a validator from the allowlist. Substrate explorer link visible.
3. Reward event: 10 POT posted to vault via `notifyReward`. 1.5 POT → InsuranceFund, 8.5 POT → share price up.
4. Attester daemons sign a slashing event of 5 POT. `OracleCommittee` reaches threshold; `StakingVault.reportSlash` draws the InsuranceFund to reimburse the vault.
5. User A locks 50 stPOT into veSTPOT, proposes raising insurance split from 15% to 20%. After 24h timelock, parameter updates on-chain.
6. User A deposits 50 stPOT into `MiniLend`, borrows 25 POT. Repays. Collateral released.

Every step emits an event the frontend consumes. If a step cannot run live (e.g., no real slashing on testnet), the demo falls back to a documented simulated-slashing button, clearly labeled.
