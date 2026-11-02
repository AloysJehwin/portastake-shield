// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Script.sol";
import {Shared} from "./Shared.s.sol";

import {WPOT} from "../src/WPOT.sol";
import {InsuranceFund, StabilizationReserve} from "../src/WpotBuckets.sol";
import {StakingVault} from "../src/StakingVault.sol";

/// @notice Stage 1: the minimum deployable set that lets users deposit native tPOT and earn.
/// @dev Measured ~1,460 tPOT at 0.074 tPOT per byte of initcode, dead-shares seed included.
///
/// Env:
///   PRIVATE_KEY      deployer key (required)
///   RELAYER          relayer EVM address              (default: deployer)
///   STAKING_ACCOUNT  H160 of the relayer's SS58 stash (default: RELAYER)
///   TREASURY         overflow yield sink              (default: deployer)
///   SEED_POT         dead-shares seed deposit         (default: 1 tPOT)
contract Deploy1Core is Shared {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function run() external {
        Config memory c = _config();
        Addrs memory a = _load();

        vm.startBroadcast(c.pk);
        WPOT wpot = new WPOT();
        InsuranceFund insurance = new InsuranceFund(wpot);
        StabilizationReserve reserve = new StabilizationReserve(wpot);
        StakingVault vault = new StakingVault(wpot, insurance, reserve, c.deployer, c.treasury, c.stakingAccount);
        insurance.setVault(address(vault));
        reserve.setVault(address(vault));
        vault.grantRole(vault.RELAYER_ROLE(), c.relayer);
        vault.depositNative{value: c.seedPot}(DEAD); // first-depositor inflation guard
        vm.stopBroadcast();

        a.wpot = address(wpot);
        a.insurance = address(insurance);
        a.reserve = address(reserve);
        a.vault = address(vault);
        _write(c, a);

        console2.log("WPOT                  ", a.wpot);
        console2.log("InsuranceFund         ", a.insurance);
        console2.log("StabilizationReserve  ", a.reserve);
        console2.log("StakingVault          ", a.vault);
    }
}
