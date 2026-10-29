# relayer/

TypeScript daemon that bridges Portaldot V3's EVM contracts to the Substrate staking pallet.

Not yet initialized. Stack:

- `@polkadot/api` for Substrate side (SS58 account, `staking.*` extrinsics)
- `viem` for EVM side (watch events, call `notifyReward`, submit oracle proofs)

See `../docs/ARCHITECTURE.md` §"Why pallet-revive matters" for why this daemon exists.

Responsibilities:

| Job | EVM side | Substrate side |
|---|---|---|
| Staking bridge | watch `StakingVault` deposits, call `sweepToStake` | `staking.bond` / `bond_extra` / `nominate` |
| Rewards | `StakingVault.notifyReward{value}` each era | watch `staking.Rewarded`, `payout_stakers` |
| Slow exits | `StakingVault.fulfillUnstake{value}` | `staking.unbond` → `withdraw_unbonded` |
| Price feed | `SwapDesk.setPrice` (FEEDER_ROLE) | read the Native/7777 `assetConversion` pool |
| Policy NFT | watch `Deposit` (first per holder) | mint a locked item in the native `Nfts` pallet to the holder's mapped account |
| Automation | `SwapDesk.depositFor` (KEEPER_ROLE) for save rules | — |
| Pay reminders | prepare `redeemToStable(…, payee)` for the user to sign | — |
