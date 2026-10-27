# contracts/

Foundry project for PortaStake Shield. Plain `solc` 0.8.28 bytecode: PortaldotV3's `pallet-revive` runs with `allowEVMBytecode = true`, so no `resolc` is needed. Uses OpenZeppelin v5.4.0.

## Layout

| File | What it does |
|---|---|
| `src/StakingVault.sol` | ERC-4626 over WPOT, mints **stPOT**. Hot reserve, stake sweep to the relayer, reward split + streaming, slash hook, slow-exit queue |
| `src/RateEngine.sol` | Pure math for the reserve-backed 8% target |
| `src/WpotBuckets.sol` | `InsuranceFund` and `StabilizationReserve`: WPOT pots only the vault can draw from |
| `src/MandateManager.sol` | Auto / scheduled / threshold debits, SAVE and PAY directions |
| `src/SwapDesk.sol` | tUSD ↔ POT ↔ stPOT in one call, priced by `PriceOracle` |
| `src/OracleCommittee.sol` | N-of-M ECDSA attesters prove a Substrate slash to the EVM |
| `src/PolicyNFT.sol` | Soulbound coverage certificate, minted on first deposit |
| `src/WPOT.sol` | Wrapped tPOT; unwraps only in 1e4-wei units (revive `nativeToEthRatio`) |
| `src/PriceOracle.sol` | POT/USD, pushed by the relayer, staleness-checked |
| `src/MockStable.sol` | `tUSD` test stablecoin (pUSD has no ERC-20 precompile on the EVM) |

## Build and test

```sh
forge build
forge test            # unit + fuzz + invariant suites
forge build --sizes   # every contract is under the 24 KB limit
```

## Deploy to PortaldotV3 testnet

```sh
export PRIVATE_KEY=0x...          # funded EVM key (tPOT on its mapped account)
export RELAYER=0x...              # optional, defaults to deployer
export STAKING_ACCOUNT=0x...      # H160 of the relayer's mapped SS58 stash
forge script script/Deploy.s.sol --rpc-url portaldot --broadcast --legacy --slow
```

Addresses are written to `deployments/<chainId>.json`.

The storage deposit is real: revive charges 0.06 tPOT per byte of stored code (~48 KB of runtime code in total) plus 0.15 tPOT per storage item. Make sure the deployer holds enough tPOT, and record the actual charge from the first deploy.
