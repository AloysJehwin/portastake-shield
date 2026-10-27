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

See `contracts/README.md`. Everything uses OpenZeppelin v5.4.0; ~48 KB of runtime code total, the largest being `StakingVault` (14 KB).

Changes from the original sketch:
- `Router` → `SwapDesk`: an oracle-priced inventory desk, because no DEX is reachable from the EVM.
- `InsuranceFund` is a plain WPOT bucket, not ERC-4626, since it has no external depositors in v1.
- `StabilizationReserve` and `MandateManager` are new.
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
- Transparency views for the UI: `lastEffectiveRateBps`, `reserveCoverageDays`, `insuranceRatioBps`.
- The promise is in POT. The USD value shown in the app moves with the POT price, and the UI must say so. Insurance covers slashing, not price.

## Debit mandates (`MandateManager`)

| | RECURRING ("auto") | SCHEDULED | THRESHOLD |
|---|---|---|---|
| **SAVE** (wallet tUSD → stPOT) | every `interval` | once at `start` | wallet > `bound` → sweep the excess (capped at `amount`) |
| **PAY** (stPOT → tUSD to payee) | every `interval` | once at `start` | payee < `bound` → top up the gap (capped at `amount`) |

- **Authority**: the owner's allowances to `MandateManager` (tUSD for SAVE, stPOT for PAY). Amounts are in tUSD.
- **Execution**: permissionless `execute` / `executeBatch`; the relayer is the keeper (revive EVM has no cron).
  - The batch records failures; 3 in a row auto-pauses the mandate.
  - Recurring mandates don't burst-catch-up after downtime.
  - Threshold mandates use `interval` as a cooldown.
- A PAY mandate fails cleanly when the hot reserve can't cover it.
- `Mandate` packs into 3 storage slots to keep revive storage deposits low. `cancel` deletes it and frees the deposit.

## Decimals handling

- Substrate side: tPOT has 14 decimals.
- EVM side: pallet-revive exposes 18 decimals via `nativeToEthRatio = 10000`. Everything on the EVM side uses 18.
- Native value transfers must be multiples of 1e4 wei:
  - `WPOT.withdraw` and `StakingVault.sweepToStake` reject dust.
  - `requestUnstake` rounds down.
- `OracleCommittee` slash amounts are in 18-decimal units. Attesters multiply the Substrate amount by 1e4.

## Relayer ↔ vault account mapping

`StakingVault.stakingAccount` is the H160 of the relayer's SS58 stash. The relayer's sr25519 account calls `revive.map_account` once; its H160 is then the last 20 bytes of `keccak256(AccountId32)`. Native POT the vault sends there lands in the stash, which bonds it with `staking.bond` / `bond_extra` + `nominate`.

Rewards are paid to the stash, and the relayer returns them through `notifyReward{value}`.

## Event design

Rich, named events everywhere. Both the frontend and the relayer are event-driven. Minimum per contract:

- `StakingVault`: `Deposit`, `Withdraw`, `Rebalance`, `RewardNotified`, `HotReserveRefilled`, `SlashingPayout`
- `InsuranceFund`: `Funded`, `Payout`
- `OracleCommittee`: `AttesterBonded`, `AttesterSlashed`, `SlashingProofSubmitted`, `SlashingProofFinalized`
- `Governance`: `ProposalCreated`, `Voted`, `TimelockQueued`, `ParameterApplied`
- `PolicyNFT`: standard ERC-721 + a `TermsSnapshot(id, coverageConfig)`

## Development order (concrete)

1. WS probe script that enumerates pallets at `wss://test-node-v3.portaldot.dev` and prints the staking extrinsic signature. **Blocks every other decision below.**
2. Foundry scaffold with `StakingVault` + mock reward emitter. First real commit.
3. `InsuranceFund` + yield-split hook + `PolicyNFT`. End-to-end Foundry test.
4. Deploy to V3 EVM testnet. Capture addresses + first tx hashes.
5. Relayer v1: watches `Deposit`/`Withdraw`, submits `bond`/`unbond` or `nominationPools.join`/`unbond`.
6. `OracleCommittee` + attester daemon. Mock slashing path first.
7. `Governance` with veSTPOT + 24h timelock. Execute one real parameter change on live testnet.
8. `MiniLend`.
9. `Router` + stablecoin on-ramp (real DEX if available, mocked oracle swap otherwise).
10. Frontend.

## Verification plan — the demo script

Six steps, all on live V3 EVM testnet:

1. User A deposits 100 POT. Receives 100 stPOT. Policy NFT minted. Dashboard shows deposit.
2. Relayer bonds 100 POT on Substrate side; nominates a validator from the allowlist. Substrate explorer link visible.
3. Reward event: 10 POT posted to vault via `notifyReward`. 1.5 POT → InsuranceFund, 8.5 POT → share price up.
4. Attester daemons sign a slashing event of 5 POT. `OracleCommittee` reaches threshold; `StakingVault.reportSlash` draws the InsuranceFund to reimburse the vault.
5. User A locks 50 stPOT into veSTPOT, proposes raising insurance split from 15% to 20%. After 24h timelock, parameter updates on-chain.
6. User A deposits 50 stPOT into `MiniLend`, borrows 25 POT. Repays. Collateral released.

Every step emits an event the frontend consumes. If a step cannot run live (e.g., no real slashing on testnet), the demo falls back to a documented simulated-slashing button, clearly labeled.
