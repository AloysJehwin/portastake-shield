// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {MandateManager} from "../src/MandateManager.sol";

contract MandateManagerTest is Base {
    uint256 constant WEEK = 7 days;

    function setUp() public override {
        super.setUp();
        vm.startPrank(maria);
        usd.faucet(10_000e6);
        usd.approve(address(mandates), type(uint256).max);
        vault.approve(address(mandates), type(uint256).max);
        vm.stopPrank();
    }

    function _params(MandateManager.Direction dir, MandateManager.Trigger trig)
        internal
        view
        returns (MandateManager.MandateParams memory p)
    {
        p.dir = dir;
        p.trig = trig;
        p.payee = landlord;
        p.amount = 20e6;
        p.interval = uint32(WEEK);
        p.maxSlippageBps = 50;
        p.start = uint64(block.timestamp);
    }

    function _create(MandateManager.MandateParams memory p) internal returns (uint256 id) {
        vm.prank(maria);
        id = mandates.create(p);
    }

    // --- SAVE ---------------------------------------------------------------

    function test_saveRecurring() public {
        uint256 id = _create(_params(MandateManager.Direction.SAVE, MandateManager.Trigger.RECURRING));

        vm.prank(keeper);
        uint256 shares = mandates.execute(id);
        assertGt(shares, 0);
        assertEq(vault.balanceOf(maria), shares);
        assertEq(usd.balanceOf(maria), 10_000e6 - 20e6);
        // $20 at $0.50/POT minus 0.3% fee ≈ 39.88 POT
        assertApproxEqRel(vault.convertToAssets(shares), 39.88 ether, 1e15);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MandateManager.NotDue.selector, id));
        mandates.execute(id);

        _warp(WEEK);
        vm.prank(keeper);
        mandates.execute(id);
        assertEq(mandates.getMandate(id).runs, 2);
    }

    function test_recurringSkipsAheadInsteadOfBursting() public {
        uint256 id = _create(_params(MandateManager.Direction.SAVE, MandateManager.Trigger.RECURRING));
        _warp(5 * WEEK);
        mandates.execute(id);
        assertEq(mandates.getMandate(id).nextRun, block.timestamp + WEEK);
        (bool due,) = mandates.isDue(id);
        assertFalse(due);
    }

    function test_saveScheduledRunsOnce() public {
        MandateManager.MandateParams memory p = _params(MandateManager.Direction.SAVE, MandateManager.Trigger.SCHEDULED);
        p.start = uint64(block.timestamp + 1 days);
        p.amount = 500e6;
        uint256 id = _create(p);

        vm.expectRevert(abi.encodeWithSelector(MandateManager.NotDue.selector, id));
        mandates.execute(id);

        _warp(1 days);
        mandates.execute(id);
        assertEq(usd.balanceOf(maria), 10_000e6 - 500e6);
        assertFalse(mandates.getMandate(id).active);

        _warp(30 days);
        vm.expectRevert(abi.encodeWithSelector(MandateManager.NotDue.selector, id));
        mandates.execute(id);
    }

    function test_saveThresholdSweepsExcessWithCooldown() public {
        MandateManager.MandateParams memory p = _params(MandateManager.Direction.SAVE, MandateManager.Trigger.THRESHOLD);
        p.bound = 500e6; // keep $500 in the wallet
        p.amount = 20_000e6; // per-run cap
        p.interval = 1 days; // cooldown
        uint256 id = _create(p);

        (bool due, uint256 amt) = mandates.isDue(id);
        assertTrue(due);
        assertEq(amt, 9_500e6);
        mandates.execute(id);
        assertEq(usd.balanceOf(maria), 500e6);

        vm.prank(maria);
        usd.faucet(1_000e6);
        (due,) = mandates.isDue(id);
        assertFalse(due); // cooling down
        _warp(1 days);
        mandates.execute(id);
        assertEq(usd.balanceOf(maria), 500e6);
    }

    // --- PAY ----------------------------------------------------------------

    function test_payRecurringToLandlord() public {
        _depositNative(maria, 2_000 ether); // ≈ $1000 of savings
        MandateManager.MandateParams memory p = _params(MandateManager.Direction.PAY, MandateManager.Trigger.RECURRING);
        p.amount = 300e6;
        p.interval = 30 days;
        uint256 id = _create(p);

        mandates.execute(id);
        assertApproxEqAbs(usd.balanceOf(landlord), 300e6, 2);
        assertGe(usd.balanceOf(landlord), 300e6 * 9_950 / 10_000);
        assertLt(vault.balanceOf(maria), 2_000 ether);
    }

    function test_payScheduled() public {
        _depositNative(maria, 2_000 ether);
        MandateManager.MandateParams memory p = _params(MandateManager.Direction.PAY, MandateManager.Trigger.SCHEDULED);
        p.start = uint64(block.timestamp + 3 days);
        p.amount = 100e6;
        uint256 id = _create(p);
        _warp(3 days);
        mandates.execute(id);
        assertApproxEqAbs(usd.balanceOf(landlord), 100e6, 2);
    }

    function test_payThresholdTopsUpOwnWallet() public {
        _depositNative(maria, 2_000 ether);
        vm.prank(maria);
        usd.transfer(bob, 9_980e6); // wallet down to $20

        MandateManager.MandateParams memory p = _params(MandateManager.Direction.PAY, MandateManager.Trigger.THRESHOLD);
        p.payee = address(0); // defaults to owner
        p.bound = 100e6; // never below $100
        p.amount = 200e6;
        p.interval = 1 hours;
        uint256 id = _create(p);
        assertEq(mandates.getMandate(id).payee, maria);

        (, uint256 amt) = mandates.isDue(id);
        assertEq(amt, 80e6);
        mandates.execute(id);
        assertApproxEqAbs(usd.balanceOf(maria), 100e6, 2);
    }

    function test_payFailsCleanlyWhenReserveIsBonded() public {
        _depositNative(maria, 1_000 ether);
        vm.prank(relayer);
        vault.sweepToStake(900 ether); // only 100 POT ≈ $50 hot
        MandateManager.MandateParams memory p = _params(MandateManager.Direction.PAY, MandateManager.Trigger.RECURRING);
        p.amount = 300e6;
        uint256 id = _create(p);
        vm.expectRevert();
        mandates.execute(id);
    }

    // --- batch, failures, lifecycle -------------------------------------------

    function test_batchAutoPausesAfterThreeFailures() public {
        uint256 id = _create(_params(MandateManager.Direction.SAVE, MandateManager.Trigger.RECURRING));
        vm.prank(maria);
        usd.approve(address(mandates), 0); // revoke

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        for (uint256 i; i < 3; ++i) {
            assertEq(mandates.executeBatch(ids), 0);
        }
        MandateManager.Mandate memory m = mandates.getMandate(id);
        assertEq(m.fails, 3);
        assertFalse(m.active);

        vm.startPrank(maria);
        usd.approve(address(mandates), type(uint256).max);
        mandates.resumeMandate(id);
        vm.stopPrank();
        assertEq(mandates.executeBatch(ids), 1);
    }

    function test_batchSkipsNotDueAndRunsOthers() public {
        uint256 a = _create(_params(MandateManager.Direction.SAVE, MandateManager.Trigger.RECURRING));
        MandateManager.MandateParams memory p = _params(MandateManager.Direction.SAVE, MandateManager.Trigger.SCHEDULED);
        p.start = uint64(block.timestamp + 1 days);
        uint256 b = _create(p);

        (uint256[] memory due, uint256 next) = mandates.dueIds(0, 10);
        assertEq(due.length, 1);
        assertEq(due[0], a);
        assertEq(next, 2);

        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (a, b);
        assertEq(mandates.executeBatch(ids), 1);
        assertEq(mandates.getMandate(b).fails, 0);
    }

    function test_onlyOwnerCanCancelAndCancelDeletes() public {
        uint256 id = _create(_params(MandateManager.Direction.SAVE, MandateManager.Trigger.RECURRING));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MandateManager.NotOwner.selector, id));
        mandates.cancel(id);

        vm.prank(maria);
        mandates.cancel(id);
        assertEq(mandates.getMandate(id).owner, address(0));
        (bool due,) = mandates.isDue(id);
        assertFalse(due);
    }

    function test_expiryAndMaxRuns() public {
        MandateManager.MandateParams memory p = _params(MandateManager.Direction.SAVE, MandateManager.Trigger.RECURRING);
        p.maxRuns = 2;
        p.expiry = uint40(block.timestamp + 10 * WEEK);
        uint256 id = _create(p);
        mandates.execute(id);
        _warp(WEEK);
        mandates.execute(id);
        _warp(WEEK);
        (bool due,) = mandates.isDue(id);
        assertFalse(due); // maxRuns hit
    }

    function test_rejectsBadParams() public {
        MandateManager.MandateParams memory p = _params(MandateManager.Direction.SAVE, MandateManager.Trigger.RECURRING);
        p.interval = 0;
        vm.prank(maria);
        vm.expectRevert(abi.encodeWithSelector(MandateManager.InvalidParams.selector, "interval"));
        mandates.create(p);

        p = _params(MandateManager.Direction.PAY, MandateManager.Trigger.RECURRING);
        p.payee = address(0);
        vm.prank(maria);
        vm.expectRevert(abi.encodeWithSelector(MandateManager.InvalidParams.selector, "payee"));
        mandates.create(p);
    }

    function test_staleOracleBlocksExecution() public {
        uint256 id = _create(_params(MandateManager.Direction.SAVE, MandateManager.Trigger.RECURRING));
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert();
        mandates.execute(id);
    }
}
