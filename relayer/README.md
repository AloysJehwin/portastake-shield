# relayer/

TypeScript daemon that bridges Portaldot V3's EVM contracts to the Substrate staking pallet.

Not yet initialized. Stack:

- `@polkadot/api` for Substrate side (SS58 account, `staking.*` extrinsics)
- `viem` for EVM side (watch events, call `notifyReward`, submit oracle proofs)

See `../docs/ARCHITECTURE.md` §"Why pallet-revive matters" for why this daemon exists.
