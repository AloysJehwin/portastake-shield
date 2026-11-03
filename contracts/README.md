# contracts/

Foundry project for PortaStake Shield. Plain `solc` 0.8.28 bytecode: PortaldotV3's `pallet-revive` runs with `allowEVMBytecode = true`, so no `resolc` is needed. Uses OpenZeppelin v5.4.0.

## Layout

| File | What it does |
|---|---|
| `src/StakingVault.sol` | ERC-4626 over WPOT, mints **stPOT**. Hot reserve, stake sweep to the relayer, reward split + streaming, slash hook, slow-exit queue |
| `src/RateEngine.sol` | Pure math for the reserve-backed 8% target |
| `src/WpotBuckets.sol` | `InsuranceFund` and `StabilizationReserve`: WPOT pots only the vault can draw from |
| `src/SwapDesk.sol` | tUSD ↔ POT ↔ stPOT in one call. Holds the relayer-fed POT/USD feed (staleness-checked) |
| `src/PolicyNFT.sol` | Soulbound coverage certificate (minimal ERC-721 + ERC-5192), minted by the vault on first deposit |
| `src/MandateManager.sol` | Save / pay mandates (recurring, scheduled, threshold). Enforces caps, run limits, expiry, cooldowns and slippage floors; `execute` is permissionless and driven by the relayer keeper |
| `src/OracleCommittee.sol` | N-of-M ECDSA attesters prove a Substrate slash to the EVM |
| `src/WPOT.sol` | Wrapped tPOT; unwraps only in 1e4-wei units (revive `nativeToEthRatio`) |
| `src/MockStable.sol` | `tUSD` test stablecoin (pUSD has no ERC-20 precompile on the EVM) |

## Build and test

```sh
forge build
forge test            # unit + fuzz + invariant suites
forge build --sizes   # revive bills deploy bytes; compiled with via_ir + optimizer_runs = 1
```

## Deploy to PortaldotV3 testnet

```sh
set -a && . ./.env && set +a      # PRIVATE_KEY (+ optional RELAYER, STAKING_ACCOUNT, ATTESTER)
node ../scripts/deploy-cast.mjs   # stages 1-4; re-runnable, reuses anything already live
```

Addresses are written to `deployments/<chainId>.json`. Deploys go through `cast send` because revive folds its storage deposit into gas and `forge script` under-estimates it (error 1010).

The storage deposit is real: revive charges ~0.06 tPOT per byte of stored code plus 0.15 tPOT per storage item (see `docs/ARCHITECTURE.md#deploy-cost--staged`). `relayer/scripts/measure-deploy.mjs` prints the live per-contract cost before you spend it.
