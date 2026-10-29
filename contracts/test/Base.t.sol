// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {WPOT} from "../src/WPOT.sol";
import {MockStable} from "../src/MockStable.sol";
import {InsuranceFund, StabilizationReserve} from "../src/WpotBuckets.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {SwapDesk} from "../src/SwapDesk.sol";
import {OracleCommittee} from "../src/OracleCommittee.sol";

abstract contract Base is Test {
    WPOT wpot;
    MockStable usd;
    InsuranceFund insurance;
    StabilizationReserve reserve;
    StakingVault vault;
    SwapDesk desk;
    OracleCommittee committee;

    address admin = makeAddr("admin");
    address relayer = makeAddr("relayer"); // also the Substrate stash (mapped H160)
    address treasury = makeAddr("treasury");
    address maria = makeAddr("maria");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");

    uint256 constant POT_PRICE = 0.5e18; // $0.50 per POT
    uint256 constant ERA = 6 hours;

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        vm.startPrank(admin);
        wpot = new WPOT();
        usd = new MockStable(admin);
        insurance = new InsuranceFund(wpot);
        reserve = new StabilizationReserve(wpot);
        vault = new StakingVault(wpot, insurance, reserve, admin, treasury, relayer);
        insurance.setVault(address(vault));
        reserve.setVault(address(vault));
        vault.grantRole(vault.RELAYER_ROLE(), relayer);
        desk = new SwapDesk(usd, IERC4626(address(vault)), admin, 1 days);
        desk.setPrice(POT_PRICE);
        desk.grantRole(desk.KEEPER_ROLE(), keeper);
        committee = new OracleCommittee(vault, admin);
        vault.grantRole(vault.SLASHER_ROLE(), address(committee));
        vm.stopPrank();

        // Desk inventory: 1M tUSD and 100k POT.
        vm.prank(admin);
        usd.mint(address(desk), 1_000_000e6);
        vm.deal(address(this), 100_000 ether);
        wpot.deposit{value: 100_000 ether}();
        wpot.transfer(address(desk), 100_000 ether);

        vm.deal(maria, 10_000 ether);
        vm.deal(bob, 10_000 ether);
        vm.deal(relayer, 1_000_000 ether);
    }

    function _depositNative(address who, uint256 amount) internal returns (uint256 shares) {
        vm.prank(who);
        shares = vault.depositNative{value: amount}(who);
    }

    /// @dev Advance time the way production does: the relayer keeps the price feed fresh.
    function _warp(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
        vm.prank(admin);
        desk.setPrice(POT_PRICE);
    }

    function _reward(uint256 amount) internal {
        vm.prank(relayer);
        vault.notifyReward{value: amount}();
    }

    /// @dev Reward for `dt` seconds at an annual gross `bps` on the currently bonded principal.
    function _grossReward(uint256 base, uint256 bps, uint256 dt) internal pure returns (uint256 r) {
        r = base * bps * dt / (10_000 * 365 days);
        r -= r % 1e4; // native-unit granularity
    }
}
