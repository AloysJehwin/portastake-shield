// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Script.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Shared} from "./Shared.s.sol";

import {StakingVault} from "../src/StakingVault.sol";
import {SwapDesk} from "../src/SwapDesk.sol";
import {PolicyNFT} from "../src/PolicyNFT.sol";
import {MandateManager} from "../src/MandateManager.sol";

/// @notice Stage 4 (deferred): the on-chain coverage NFT and/or the on-chain save/pay automation.
/// @dev Each half is opt-in. Together, these are the biggest contracts and were cut from the
///      first deploy to stay under 2,500 tPOT; run this stage once Portaldot tops up.
///
///      WITH_POLICY=1    deploy PolicyNFT (minter = the vault), then call
///                       `vault.setPolicy`. New deposits start minting the certificate.
///      WITH_MANDATES=1  deploy MandateManager, wired against the already-deployed
///                       tUSD, vault and SwapDesk. Requires stage 2 (desk) to exist.
contract Deploy4Extras is Shared {
    error MissingStage1();
    error MissingStage2();
    error NothingToDo();

    function run() external {
        Config memory c = _config();
        Addrs memory a = _load();
        if (a.vault == address(0)) revert MissingStage1();

        bool withPolicy = vm.envOr("WITH_POLICY", uint256(0)) != 0;
        bool withMandates = vm.envOr("WITH_MANDATES", uint256(0)) != 0;
        if (!withPolicy && !withMandates) revert NothingToDo();
        if (withMandates && a.desk == address(0)) revert MissingStage2();

        vm.startBroadcast(c.pk);
        if (withPolicy) {
            PolicyNFT policy = new PolicyNFT(a.vault);
            StakingVault(payable(a.vault)).setPolicy(policy);
            a.policy = address(policy);
            console2.log("PolicyNFT       ", a.policy);
        }
        if (withMandates) {
            MandateManager mandates =
                new MandateManager(a.tusd, IERC4626(a.vault), SwapDesk(a.desk));
            a.mandates = address(mandates);
            console2.log("MandateManager  ", a.mandates);
        }
        vm.stopBroadcast();

        _write(c, a);
    }
}
