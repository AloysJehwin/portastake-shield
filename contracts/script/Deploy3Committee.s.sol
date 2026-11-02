// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Script.sol";
import {Shared} from "./Shared.s.sol";

import {StakingVault} from "../src/StakingVault.sol";
import {OracleCommittee} from "../src/OracleCommittee.sol";

/// @notice Stage 3: slash attestation + insurance payouts. Needs stage 1 already deployed.
/// @dev Adds ~285 tPOT (cumulative ~2,470 after stages 1+2+3, under the 2,500 ceiling).
///
/// Env:
///   PRIVATE_KEY  deployer key (required)
///   ATTESTER     first OracleCommittee member (default: deployer)
contract Deploy3Committee is Shared {
    error MissingStage1();

    function run() external {
        Config memory c = _config();
        Addrs memory a = _load();
        if (a.vault == address(0)) revert MissingStage1();

        vm.startBroadcast(c.pk);
        OracleCommittee committee = new OracleCommittee(StakingVault(payable(a.vault)), c.deployer);
        committee.addAttester(c.attester);
        committee.setThreshold(1);
        StakingVault(payable(a.vault)).grantRole(StakingVault(payable(a.vault)).SLASHER_ROLE(), address(committee));
        vm.stopBroadcast();

        a.committee = address(committee);
        _write(c, a);

        console2.log("OracleCommittee  ", a.committee);
    }
}
