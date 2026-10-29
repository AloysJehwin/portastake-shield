// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {SwapDesk} from "../src/SwapDesk.sol";

contract SwapDeskTest is Base {
    function setUp() public override {
        super.setUp();
        vm.startPrank(maria);
        usd.faucet(1_000e6);
        usd.approve(address(desk), type(uint256).max);
        vault.approve(address(desk), type(uint256).max);
        vm.stopPrank();
    }

    function test_depositWithStableMintsShares() public {
        vm.prank(maria);
        uint256 shares = desk.depositWithStable(100e6, 0, maria);
        // $100 at $0.50/POT = 200 POT, less the 0.30% fee.
        assertEq(shares, 199.4 ether);
        assertEq(vault.balanceOf(maria), shares);
        assertEq(usd.balanceOf(maria), 900e6);
    }

    function test_redeemToStableRoundTrip() public {
        vm.startPrank(maria);
        uint256 shares = desk.depositWithStable(100e6, 0, maria);
        uint256 out = desk.redeemToStable(shares, 0, maria);
        vm.stopPrank();
        assertEq(vault.balanceOf(maria), 0);
        assertApproxEqAbs(out, 99.4009e6, 1); // two 0.30% fees
    }

    function test_slippageGuard() public {
        vm.prank(maria);
        vm.expectRevert(abi.encodeWithSelector(SwapDesk.Slippage.selector, 199.4 ether, 200 ether));
        desk.depositWithStable(100e6, 200 ether, maria);
    }

    function test_stalePriceBlocksSwaps() public {
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.prank(maria);
        vm.expectRevert(abi.encodeWithSelector(SwapDesk.StalePrice.selector, uint64(1_700_000_000)));
        desk.depositWithStable(100e6, 0, maria);
    }

    function test_onlyFeederSetsPrice() public {
        vm.prank(maria);
        vm.expectRevert();
        desk.setPrice(1e18);

        vm.prank(admin);
        vm.expectRevert(SwapDesk.InvalidPrice.selector);
        desk.setPrice(0);
    }

    function test_autoSaveNeedsBudget() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SwapDesk.OverBudget.selector, 20e6, 0));
        desk.depositFor(maria, 20e6, 0);
    }

    function test_autoSaveSpendsBudgetIntoOwnersSavings() public {
        vm.prank(maria);
        desk.setAutoSaveBudget(50e6);

        vm.prank(keeper);
        uint256 shares = desk.depositFor(maria, 20e6, 0);
        assertEq(vault.balanceOf(maria), shares);
        assertEq(desk.autoSaveBudget(maria), 30e6);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SwapDesk.OverBudget.selector, 40e6, 30e6));
        desk.depositFor(maria, 40e6, 0);
    }

    function test_autoSaveStopsWhenBudgetZeroed() public {
        vm.prank(maria);
        desk.setAutoSaveBudget(50e6);
        vm.prank(maria);
        desk.setAutoSaveBudget(0);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SwapDesk.OverBudget.selector, 1e6, 0));
        desk.depositFor(maria, 1e6, 0);
    }

    function test_onlyKeeperCanAutoSave() public {
        vm.prank(maria);
        desk.setAutoSaveBudget(50e6);
        vm.prank(bob);
        vm.expectRevert();
        desk.depositFor(maria, 10e6, 0);
    }
}
