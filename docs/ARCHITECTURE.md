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

## Contract list and sizes (target)

Each contract stays small so pallet-revive deploys it cleanly and so a judge can read all contracts in 20 minutes.

| Contract | Target LOC | Reused libraries |
|---|---|---|
| `Router.sol` | ~150 | OZ IERC20, SafeERC20 |
| `StakingVault.sol` | ~250 | OZ ERC4626, ReentrancyGuard, AccessControl |
| `InsuranceFund.sol` | ~150 | OZ ERC4626 |
| `PolicyNFT.sol` | ~120 | OZ ERC721URIStorage |
| `OracleCommittee.sol` | ~250 | OZ ECDSA, EnumerableSet |
| `Governance.sol` | ~300 | OZ Governor-light / custom minimal |
| `MiniLend.sol` | ~150 | OZ |
| `DecimalsOracle.sol` | ~30 | — |

Total EVM footprint target: under 1,400 lines of Solidity. Reviewable in one sitting.

## Decimals handling

- Substrate side: read `system.properties.tokenDecimals` on relayer startup. Expected 10 or 14.
- EVM side: pallet-revive exposes 18 decimals by convention; the runtime scales.
- Everything on the EVM side uses 18. The `DecimalsOracle` records the Substrate value so off-chain readers (frontend, indexer) can display consistent numbers.

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
4. Attester daemons sign a slashing event of 5 POT. `OracleCommittee` reaches threshold; `InsuranceFund.payout` reimburses vault.
5. User A locks 50 stPOT into veSTPOT, proposes raising insurance split from 15% to 20%. After 24h timelock, parameter updates on-chain.
6. User A deposits 50 stPOT into `MiniLend`, borrows 25 POT. Repays. Collateral released.

Every step emits an event the frontend consumes. If a step cannot run live (e.g., no real slashing on testnet), the demo falls back to a documented simulated-slashing button, clearly labeled.
