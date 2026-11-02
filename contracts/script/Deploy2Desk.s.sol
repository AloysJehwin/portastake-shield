// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Script.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Shared} from "./Shared.s.sol";

import {WPOT} from "../src/WPOT.sol";
import {MockStable} from "../src/MockStable.sol";
import {SwapDesk} from "../src/SwapDesk.sol";

/// @notice Stage 2: the stablecoin on-ramp. Needs stage 1 already deployed.
/// @dev Adds ~725 tPOT (cumulative ~2,185 after stages 1+2).
///
/// Env:
///   PRIVATE_KEY   deployer key (required)
///   RELAYER       feeds POT/USD price             (default: deployer)
///   POT_PRICE     initial POT/USD, 1e18 scaled    (default: 0.5e18)
///   DESK_POT      SwapDesk POT inventory          (default: 50 tPOT)
///   DESK_USD      SwapDesk tUSD inventory         (default: 100,000 tUSD)
contract Deploy2Desk is Shared {
    error MissingStage1();

    function run() external {
        Config memory c = _config();
        Addrs memory a = _load();
        if (a.vault == address(0)) revert MissingStage1();

        vm.startBroadcast(c.pk);
        MockStable usd = new MockStable(c.deployer);
        SwapDesk desk = new SwapDesk(usd, IERC4626(a.vault), c.deployer, 1 days);
        desk.grantRole(desk.FEEDER_ROLE(), c.relayer);
        desk.setPrice(c.potPrice);

        // Seed inventory.
        usd.mint(address(desk), c.deskUsd);
        WPOT(payable(a.wpot)).deposit{value: c.deskPot}();
        WPOT(payable(a.wpot)).transfer(address(desk), c.deskPot);
        vm.stopBroadcast();

        a.tusd = address(usd);
        a.desk = address(desk);
        _write(c, a);

        console2.log("tUSD      ", a.tusd);
        console2.log("SwapDesk  ", a.desk);
    }
}
