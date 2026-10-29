// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {WPOT} from "../src/WPOT.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

contract StakingVaultTest is Base {
    function test_depositNativeMintsSharesAndEmitsDeposit() public {
        // The relayer mints the native-pallet policy NFT from this event.
        vm.expectEmit(address(vault));
        emit IERC4626.Deposit(maria, maria, 1_000 ether, 1_000 ether);
        uint256 shares = _depositNative(maria, 1_000 ether);
        assertEq(shares, 1_000 ether);
        assertEq(vault.balanceOf(maria), 1_000 ether);
        assertEq(vault.totalAssets(), 1_000 ether);
    }

    function test_sweepKeepsTotalAssetsAndSendsNative() public {
        _depositNative(maria, 1_000 ether);
        uint256 before = relayer.balance;
        vm.prank(relayer);
        vault.sweepToStake(900 ether);
        assertEq(relayer.balance - before, 900 ether);
        assertEq(vault.bondedPrincipal(), 900 ether);
        assertEq(vault.totalAssets(), 1_000 ether);
        assertEq(vault.availableLiquidity(), 100 ether);
    }

    function test_sweepRespectsHotTarget() public {
        _depositNative(maria, 1_000 ether);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.BelowHotTarget.selector, 99 ether, 100 ether));
        vault.sweepToStake(901 ether);
    }

    function test_sweepRejectsSubNativeUnit() public {
        _depositNative(maria, 1_000 ether);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.NotNativeUnit.selector, 1e4 + 1));
        vault.sweepToStake(1e4 + 1);
    }

    function test_wpotUnwrapRejectsDust() public {
        vm.deal(address(this), 1 ether);
        wpot.deposit{value: 1 ether}();
        vm.expectRevert(abi.encodeWithSelector(WPOT.NotNativeUnit.selector, 5));
        wpot.withdraw(5);
    }

    function test_rewardDeliversEightPercentAndStreams() public {
        _depositNative(maria, 1_000 ether);
        vm.prank(relayer);
        vault.sweepToStake(900 ether);

        vm.warp(vm.getBlockTimestamp() + ERA);
        uint256 gross = _grossReward(900 ether, 2_500, ERA);
        _reward(gross);

        uint256 owed = 1_000 ether * 800 * ERA / (10_000 * 365 days);
        // Nothing vests instantly…
        assertEq(vault.totalAssets(), 1_000 ether);
        // …half after half an era, all of it after a full era.
        vm.warp(vm.getBlockTimestamp() + ERA / 2);
        assertApproxEqAbs(vault.totalAssets(), 1_000 ether + owed / 2, 1);
        vm.warp(vm.getBlockTimestamp() + ERA / 2);
        assertEq(vault.totalAssets(), 1_000 ether + owed);

        uint256 surplus = gross - owed;
        assertEq(insurance.balance(), surplus / 2);
        assertEq(reserve.balance(), surplus - surplus / 2);
        assertEq(vault.lastEffectiveRateBps(), 799); // floor rounding of 800
    }

    function test_reserveCapOverflowsToTreasury() public {
        _depositNative(maria, 1_000 ether);
        vm.warp(vm.getBlockTimestamp() + ERA);
        _reward(300 ether); // huge reward: reserve room is only 10% of TVL = 100
        assertEq(reserve.balance(), 100 ether);
        assertGt(wpot.balanceOf(treasury), 0);
    }

    function test_shortfallToppedUpByReserve() public {
        _depositNative(maria, 1_000 ether);
        vm.warp(vm.getBlockTimestamp() + ERA);
        _reward(50 ether); // seeds insurance + reserve
        uint256 resBefore = reserve.balance();

        vm.warp(vm.getBlockTimestamp() + ERA);
        uint256 base = vault.totalAssets();
        _reward(0); // validator paid nothing this era
        uint256 owed = base * 800 * ERA / (10_000 * 365 days);
        assertEq(resBefore - reserve.balance(), owed);
        assertEq(vault.lastEffectiveRateBps(), 799);
    }

    function test_emptyReserveEmitsDowngrade() public {
        _depositNative(maria, 1_000 ether);
        vm.warp(vm.getBlockTimestamp() + ERA);
        vm.expectEmit(false, false, false, false, address(vault));
        emit StakingVault.RateDowngraded(0, 800);
        _reward(0);
        assertEq(vault.lastEffectiveRateBps(), 0);
    }

    function test_sandwichingARewardEarnsNothing() public {
        _depositNative(maria, 1_000 ether);
        vm.warp(vm.getBlockTimestamp() + ERA);

        uint256 bobShares = _depositNative(bob, 1_000 ether);
        _reward(_grossReward(2_000 ether, 2_500, ERA));
        vm.prank(bob);
        uint256 out = vault.redeem(bobShares, bob, bob);
        assertLe(out, 1_000 ether); // nothing vested yet
        assertApproxEqAbs(out, 1_000 ether, 1);
    }

    function test_coveredSlashKeepsSharePrice() public {
        _depositNative(maria, 1_000 ether);
        vm.prank(relayer);
        vault.sweepToStake(900 ether);
        vm.warp(vm.getBlockTimestamp() + ERA);
        _reward(60 ether); // funds insurance
        vm.warp(vm.getBlockTimestamp() + ERA);

        uint256 priceBefore = vault.convertToAssets(1 ether);
        vm.prank(address(committee));
        uint256 covered = vault.reportSlash(5 ether);
        assertEq(covered, 5 ether);
        assertEq(vault.convertToAssets(1 ether), priceBefore);
        assertEq(vault.bondedPrincipal(), 895 ether);
    }

    function test_uncoveredSlashLowersSharePrice() public {
        _depositNative(maria, 1_000 ether);
        vm.prank(relayer);
        vault.sweepToStake(900 ether);

        vm.expectEmit(address(vault));
        emit StakingVault.UncoveredLoss(10 ether);
        vm.prank(address(committee));
        vault.reportSlash(10 ether);
        assertEq(vault.totalAssets(), 990 ether);
    }

    function test_onlyCommitteeCanSlash() public {
        vm.prank(relayer);
        vm.expectRevert();
        vault.reportSlash(1 ether);
    }

    function test_withdrawCappedByHotReserve() public {
        _depositNative(maria, 1_000 ether);
        vm.prank(relayer);
        vault.sweepToStake(900 ether);
        assertEq(vault.maxWithdraw(maria), 100 ether);
        vm.prank(maria);
        vm.expectRevert();
        vault.withdraw(101 ether, maria, maria);
    }

    function test_unstakeQueueRoundTrip() public {
        _depositNative(maria, 1_000 ether);
        vm.prank(relayer);
        vault.sweepToStake(900 ether);

        vm.prank(maria);
        uint256 id = vault.requestUnstake(500 ether, maria);
        assertEq(vault.pendingUnstakeAssets(), 500 ether);
        assertEq(vault.totalAssets(), 500 ether);
        assertEq(vault.convertToAssets(1 ether), 1 ether);

        vm.prank(relayer);
        vault.fulfillUnstake{value: 500 ether}(id);
        assertEq(wpot.balanceOf(maria), 500 ether);
        assertEq(vault.bondedPrincipal(), 400 ether);
        assertEq(vault.totalAssets(), 500 ether);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.AlreadyFulfilled.selector, id));
        vault.fulfillUnstake{value: 500 ether}(id);
    }

    function test_paramBounds() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.OutOfBounds.selector, bytes32("targetRateBps"), 1_501));
        vault.setParams(1_501, 5_000, 1_000, 1_000, 2 days);
    }

    function test_strayNativeRejected() public {
        vm.prank(maria);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_paramsUpdatedEmitsOneEvent() public {
        vm.expectEmit(address(vault));
        emit StakingVault.ParamsUpdated(700, 4_000, 1_000, 1_000, 2 days);
        vm.prank(admin);
        vault.setParams(700, 4_000, 1_000, 1_000, 2 days);
        assertEq(vault.targetRateBps(), 700);
    }
}
