// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Script.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Shared} from "./Shared.s.sol";

import {WPOT} from "../src/WPOT.sol";
import {MockStable} from "../src/MockStable.sol";
import {InsuranceFund, StabilizationReserve} from "../src/WpotBuckets.sol";
import {PolicyNFT} from "../src/PolicyNFT.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {SwapDesk} from "../src/SwapDesk.sol";
import {MandateManager} from "../src/MandateManager.sol";
import {OracleCommittee} from "../src/OracleCommittee.sol";

/// @notice Single-broadcast deploy of the full v1 suite — for local chain and CI parity.
/// @dev Production deploys use the per-stage scripts (`Deploy1Core` -> `Deploy4Extras`) so you
///      only pay for what you can afford right now. This script does them all in one tx stream
///      and writes the same `deployments/<chainId>.json`.
contract DeployAll is Shared {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function run() external {
        Config memory c = _config();
        Addrs memory a;

        vm.startBroadcast(c.pk);

        // Stage 1 — core
        WPOT wpot = new WPOT();
        InsuranceFund insurance = new InsuranceFund(wpot);
        StabilizationReserve reserve = new StabilizationReserve(wpot);
        StakingVault vault = new StakingVault(wpot, insurance, reserve, c.deployer, c.treasury, c.stakingAccount);
        insurance.setVault(address(vault));
        reserve.setVault(address(vault));
        vault.grantRole(vault.RELAYER_ROLE(), c.relayer);
        vault.depositNative{value: c.seedPot}(DEAD);

        // Stage 2 — desk
        MockStable usd = new MockStable(c.deployer);
        SwapDesk desk = new SwapDesk(usd, IERC4626(address(vault)), c.deployer, 1 days);
        desk.grantRole(desk.FEEDER_ROLE(), c.relayer);
        desk.setPrice(c.potPrice);
        usd.mint(address(desk), c.deskUsd);
        wpot.deposit{value: c.deskPot}();
        wpot.transfer(address(desk), c.deskPot);

        // Stage 3 — committee
        OracleCommittee committee = new OracleCommittee(vault, c.deployer);
        committee.addAttester(c.attester);
        committee.setThreshold(1);
        vault.grantRole(vault.SLASHER_ROLE(), address(committee));

        // Stage 4 — extras
        PolicyNFT policy = new PolicyNFT(c.deployer);
        policy.grantRole(policy.MINTER_ROLE(), address(vault));
        vault.setPolicy(policy);
        MandateManager mandates = new MandateManager(usd, IERC4626(address(vault)), desk, c.deployer);

        vm.stopBroadcast();

        a.wpot = address(wpot);
        a.tusd = address(usd);
        a.insurance = address(insurance);
        a.reserve = address(reserve);
        a.vault = address(vault);
        a.desk = address(desk);
        a.policy = address(policy);
        a.mandates = address(mandates);
        a.committee = address(committee);
        _write(c, a);

        console2.log("StakingVault     ", a.vault);
        console2.log("SwapDesk         ", a.desk);
        console2.log("MandateManager   ", a.mandates);
        console2.log("OracleCommittee  ", a.committee);
    }
}
