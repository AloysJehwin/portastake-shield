# Architecture v1 — full on-chain design (superseded)

> **Status:** superseded on 2026-10-29 by the size-optimized v2 layout in [`ARCHITECTURE.md`](ARCHITECTURE.md).
> **Code:** commit [`eb73bb6`](https://github.com/AloysJehwin/portastake-shield/tree/eb73bb6) ("Document contracts, chain facts, 8% engine and debits").
> **Why it was replaced:** pallet-revive holds a storage deposit of 0.06 tPOT per byte of deployed code. v1's 10 contracts came to 54,209 deploy bytes, roughly **3,253 tPOT**, against a standard 500 tPOT hackathon allocation. v2 keeps the product but moves three pieces off the EVM, which brings it to ~1,957 tPOT.

This document keeps the v1 design so it can be restored later, for example once tPOT is cheap to obtain or on a mainnet where a fully on-chain design is worth the deposit.

---

## Overview

Ten contracts on Portaldot V3's `pallet-revive` EVM (chain ID 420420777), all on OpenZeppelin v5.4.0, plus an off-chain relayer and attesters.

```
   ┌────────────────┐   ┌──────────────┐
   │ MandateManager │──▶│   SwapDesk   │◀── PriceOracle (relayer-fed)
   │ save/pay rules │   │ tUSD ⇄ POT   │
   └────────────────┘   └──────┬───────┘
                               ▼
                    ┌──────────────────────┐        sweepToStake ──▶ relayer stash (Substrate)
                    │    StakingVault      │◀────── notifyReward{R} ── relayer
                    │  ERC-4626 → stPOT    │◀────── reportSlash ────── OracleCommittee (N-of-M)
                    │  10% hot reserve     │
                    └──┬────────┬───────┬──┘
                       │        │       │  RateEngine splits each era's reward R
                       ▼        ▼       ▼
            ┌───────────┐ ┌──────────────┐ ┌──────────────────────┐
            │ PolicyNFT │ │ InsuranceFund│ │ StabilizationReserve │
            │ soulbound │ │ pays slashes │ │ tops up a short era  │
            └───────────┘ └──────────────┘ └──────────────────────┘
```

The relayer's role in v1 was smaller than in v2. It bonded POT, reported rewards, fed the price and acted as a **permissionless keeper**: anyone could run `MandateManager.executeBatch`. Every rule, the coverage certificate and the price feed lived on the EVM.

## Contracts and measured size

Compiled with `optimizer_runs = 200`, `via_ir = false`. Deposit = initcode × 0.06 tPOT.

| Contract | Role | Runtime (B) | Initcode (B) | Deposit (tPOT) | In v2 |
|---|---|---|---|---|---|
| StakingVault | ERC-4626 over WPOT → stPOT; hot reserve, reward streaming, slash hook, exit queue; minted the PolicyNFT on deposit | 14,022 | 15,646 | ~939 | Kept (no NFT hook, 2 views removed) |
| **MandateManager** | On-chain save/pay rules, keeper-executed | 9,935 | 10,447 | ~627 | **Removed → relayer** |
| **PolicyNFT** | Soulbound ERC-721 coverage certificate | 5,499 | 6,238 | ~374 | **Removed → native `Nfts` pallet** |
| SwapDesk | tUSD ↔ POT ↔ stPOT, priced by PriceOracle | 5,123 | 6,279 | ~377 | Kept (+ price feed, + `depositFor`) |
| OracleCommittee | N-of-M ECDSA slash attestation | 4,186 | 4,542 | ~273 | Kept |
| MockStable (tUSD) | Test stablecoin with faucet | 2,320 | 2,998 | ~180 | Kept |
| WPOT | Wrapped tPOT, 1e4-wei unwrap granularity | 2,408 | 2,877 | ~173 | Kept |
| **PriceOracle** | POT/USD feed, staleness-checked | 1,801 | 2,214 | ~133 | **Merged into SwapDesk** |
| InsuranceFund | WPOT bucket, pays slashes | 1,313 | 1,484 | ~89 | Kept |
| StabilizationReserve | WPOT bucket, tops up short eras | 1,313 | 1,484 | ~89 | Kept |
| **Total** | | **47,920** | **54,209** | **~3,253** | v2: 32,610 B, ~1,957 tPOT |

---

## The three removed pieces

### 1. MandateManager: on-chain debit rules

Standing instructions over a user's savings, in both directions:

| | RECURRING ("auto") | SCHEDULED (one-time) | THRESHOLD |
|---|---|---|---|
| **SAVE** (wallet tUSD → stPOT) | every `interval` | once at `start` | wallet > `bound` → sweep the excess, capped at `amount` |
| **PAY** (stPOT → tUSD to `payee`) | every `interval` | once at `start` | payee < `bound` → top up the gap, capped at `amount` |

**Storage.** A `Mandate` was packed into 3 slots to keep revive deposits low:

```solidity
struct Mandate {
    // slot 1
    address owner; uint64 nextRun; Direction dir; Trigger trig; bool active; uint8 fails;
    // slot 2
    address payee; uint32 interval; uint32 runs; uint32 maxRuns;      // maxRuns 0 = unlimited
    // slot 3
    uint96 amount; uint96 bound; uint40 expiry; uint16 maxSlippageBps; // expiry 0 = never
}
```

**Interface.**

| Function | Who | Behaviour |
|---|---|---|
| `create(MandateParams)` | owner | Validates amount, slippage ≤ 5%, interval for RECURRING, start for SCHEDULED, bound for SAVE-THRESHOLD, future expiry, payee for PAY |
| `pauseMandate` / `resumeMandate` / `cancel` | owner | `cancel` deletes the struct, which releases its storage deposit |
| `isDue(id) → (due, amount)` | view | Checks active, expiry, `nextRun`, run limit and threshold condition |
| `execute(id)` | **anyone** | Runs one due mandate; reverts `NotDue` |
| `executeBatch(ids)` | **anyone** | Runs every due mandate; failures are caught and recorded instead of reverting the batch |
| `executeFromBatch(id)` | self only | `try/catch` target for the batch |
| `dueIds(cursor, count)` | view | Paginated scan the keeper uses to find work |
| `pause` / `unpause` | admin | Global kill switch |

**Guarantees enforced on-chain:**
- **Authority** came from the owner's ERC-20 allowances to `MandateManager`: tUSD for SAVE, stPOT shares for PAY. Amounts were always in tUSD.
- **3 consecutive failures auto-pause** a mandate (`MAX_FAILS = 3`).
- **No burst catch-up** after downtime: `nextRun` skips ahead instead of running every missed period.
- Threshold mandates use `interval` as a **cooldown**.
- A PAY mandate **fails cleanly** when the hot reserve can't cover it.
- Per-run slippage protection through SwapDesk's `minShares` / `minUsdOut`. SwapDesk exposed `quoteSharesForUsd` for this.

**What v1 had that v2 doesn't:** PAY ran **trustlessly and automatically**. Once a user set the rule and allowance, payments to a third party happened without a signature per payment, and any keeper could trigger them. In v2, saving is automatic but PAY is a one-tap reminder, because a relayer-held rule paying third parties would need trusting the relayer.

### 2. PolicyNFT: soulbound ERC-721

```solidity
contract PolicyNFT is ERC721("PortaStake Policy", "PSP"), AccessControl {
    bytes32 public constant MINTER_ROLE;          // granted to StakingVault
    mapping(address => uint256) public policyOf;  // one policy per holder
    event TermsSnapshot(uint256 indexed id, address indexed holder, uint256 targetRateBps, uint256 insuranceShareBps);
    function mintFor(address holder, uint256 targetRateBps, uint256 insuranceShareBps) external returns (uint256 id);
    // _update reverts Soulbound() on any transfer that isn't a mint or burn
}
```

- `StakingVault._deposit` and `depositNative` called `policy.mintFor(receiver, targetRateBps, insuranceShareBps)` on **every** deposit. It was idempotent, so the first deposit minted and later ones returned the existing ID.
- Coverage itself was always pool-wide. The NFT recorded the terms in force when the holder joined.
- **What v1 had that v2 doesn't:** the certificate was visible in EVM wallets and explorers (MetaMask, ERC-721 indexers), and other EVM contracts could check `balanceOf(user) > 0`. The v2 native-pallet NFT is visible on the Substrate side only.

### 3. PriceOracle: standalone feed

```solidity
contract PriceOracle is AccessControl {
    bytes32 public constant FEEDER_ROLE;        // the relayer
    uint256 public price; uint64 public updatedAt; uint64 public maxAge;  // maxAge 1 day at deploy
    function setPrice(uint256) external;        // FEEDER_ROLE, rejects 0
    function setMaxAge(uint64) external;        // admin
    function getPrice() external view returns (uint256);  // reverts InvalidPrice / StalePrice
}
```

The relayer fed it from the native Native/7777 (tPOT/pUSD) `assetConversion` pool. `SwapDesk` read it through `IPriceOracle`. v2 has the same fields and checks, inside `SwapDesk`. A separate contract only pays off if several consumers need the feed.

---

## Other v1-only details

**StakingVault**
- Constructor: `(WPOT, insuranceFund, reserve, IPolicyNFT policy, admin, treasury, stakingAccount)`.
- Transparency views, which v2 computes in the frontend:
  - `reserveCoverageDays() = reserveBalance × BPS × 365 / (totalAssets × targetRateBps)`
  - `insuranceRatioBps() = insuranceBalance × BPS / totalAssets`
- `setParams` emitted five `ParameterApplied(bytes32 name, uint256 value)` events. v2 emits one `ParamsUpdated(...)`.

**Interfaces** (`src/interfaces/Interfaces.sol`): `IPriceOracle`, `IWpotBucket`, `IPolicyNFT`, `ISlashableVault`, `ISwapDesk` (`quotePotForUsd`, `quoteSharesForUsd`, `depositWithStable`, `redeemToStable`).

**Deploy wiring** (`script/Deploy.s.sol`), in order:
1. Deploy WPOT, tUSD, PriceOracle (maxAge 1 day), InsuranceFund, StabilizationReserve, PolicyNFT, StakingVault, SwapDesk, MandateManager, OracleCommittee.
2. `insurance.setVault`, `reserve.setVault`.
3. `policy.grantRole(MINTER_ROLE, vault)`.
4. `vault.grantRole(RELAYER_ROLE, relayer)`, `vault.grantRole(SLASHER_ROLE, committee)`.
5. `oracle.grantRole(FEEDER_ROLE, relayer)`, `oracle.setPrice(POT_PRICE)`.
6. `committee.addAttester(attester)`, `committee.setThreshold(1)`.
7. Seed: 1 tPOT of dead shares (inflation-attack guard), desk inventory (100k tUSD, 50 tPOT).

**Tests:** 48 in total, including 14 in `test/MandateManager.t.sol` (recurring, no-burst, scheduled-once, threshold sweep with cooldown, pay recurring/scheduled/threshold, clean failure when the reserve is bonded, auto-pause after 3 failures, batch skips not-due, owner-only cancel, expiry and max runs, bad params, stale oracle blocks execution), plus `PolicyNFT` mint and soulbound checks in the vault suite.

---

## v1 vs v2 at a glance

| | v1 (this doc) | v2 (current) |
|---|---|---|
| Contracts | 10 | 7 |
| Deploy deposit | ~3,253 tPOT | ~1,957 tPOT |
| Save automation | On-chain rules, any keeper | Relayer rules; on-chain `depositFor` capped by a user-set budget |
| Pay automation | **Automatic and trustless** | One-tap reminder (user signs) |
| Coverage certificate | ERC-721 on the EVM, wallet-visible | Locked NFT in the native `Nfts` pallet |
| Price feed | Separate `PriceOracle` | Inside `SwapDesk` |
| Relayer trust | Rewards, price, bonding | Same, plus rule evaluation and NFT minting |
| Compiler | `optimizer_runs = 200` | `via_ir`, `optimizer_runs = 1` |

## Restoring a v1 piece

```sh
# view a file
git show eb73bb6:contracts/src/MandateManager.sol

# bring files back into the working tree
git checkout eb73bb6 -- contracts/src/MandateManager.sol contracts/test/MandateManager.t.sol
git checkout eb73bb6 -- contracts/src/PolicyNFT.sol contracts/src/PriceOracle.sol
```

The v2 API changed underneath them. Restored code needs:
- `ISwapDesk`, `IPolicyNFT` and `IPriceOracle` re-added to `Interfaces.sol`.
- `SwapDesk.quoteSharesForUsd`, which MandateManager uses for PAY.
- The vault's `policy` constructor argument and `mintFor` calls, if PolicyNFT returns.
- Test warps written as `vm.warp(vm.getBlockTimestamp() + …)`, because v2 compiles with `via_ir`.

**When it's worth bringing back:**
- **MandateManager:** when fully automatic, trustless PAY matters more than ~630 tPOT, e.g. for a mainnet launch.
- **PolicyNFT:** when the certificate needs to be visible in EVM wallets or readable by other EVM contracts.
- **PriceOracle:** when a second contract needs the same feed.
