// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RateEngine} from "../src/RateEngine.sol";

contract RateEngineTest is Test {
    RateEngine.Params p = RateEngine.Params({targetRateBps: 800, insuranceShareBps: 5000, maxAccrualWindow: 2 days});

    uint256 constant BASE = 1_000 ether;

    function _split(uint256 reward, uint256 dt, uint256 resBal, uint256 room)
        internal
        view
        returns (RateEngine.Split memory)
    {
        return RateEngine.split(reward, BASE, dt, resBal, room, p);
    }

    function test_owedIsEightPercentPerYear() public view {
        assertEq(RateEngine.owedFor(BASE, 800, 365 days, type(uint256).max), 80 ether);
        assertEq(
            RateEngine.owedFor(BASE, p.targetRateBps, 6 hours, p.maxAccrualWindow),
            uint256(80 ether) * 6 hours / 365 days
        );
    }

    function test_surplusSplitsInsuranceAndReserve() public view {
        // 25% gross for one year on 1000 POT = 250 POT. Users 80, surplus 170 → 85 / 85.
        RateEngine.Split memory s = RateEngine.split(250 ether, BASE, 365 days, 0, type(uint256).max, _noClamp());
        assertEq(s.toUsers, 80 ether);
        assertEq(s.toInsurance, 85 ether);
        assertEq(s.toReserve, 85 ether);
        assertEq(s.toTreasury, 0);
        assertFalse(s.downgraded);
        assertEq(RateEngine.effectiveRateBps(s.toUsers, BASE, 365 days), 800);
    }

    function test_reserveOverflowGoesToTreasury() public view {
        RateEngine.Split memory s = RateEngine.split(250 ether, BASE, 365 days, 70 ether, 30 ether, _noClamp());
        assertEq(s.toReserve, 30 ether);
        assertEq(s.toTreasury, 55 ether);
        assertEq(s.toUsers + s.toInsurance + s.toReserve + s.toTreasury, 250 ether);
    }

    function test_shortfallDrawsReserve() public view {
        uint256 owed = RateEngine.owedFor(BASE, 800, 6 hours, p.maxAccrualWindow);
        RateEngine.Split memory s = _split(owed / 4, 6 hours, 1_000 ether, 0);
        assertEq(s.toUsers, owed);
        assertEq(s.reserveDraw, owed - owed / 4);
        assertFalse(s.downgraded);
    }

    function test_emptyReserveDowngrades() public view {
        uint256 owed = RateEngine.owedFor(BASE, 800, 6 hours, p.maxAccrualWindow);
        RateEngine.Split memory s = _split(owed / 2, 6 hours, owed / 4, 0);
        assertEq(s.reserveDraw, owed / 4);
        assertEq(s.toUsers, owed / 2 + owed / 4);
        assertTrue(s.downgraded);
        assertLt(RateEngine.effectiveRateBps(s.toUsers, BASE, 6 hours), 800);
    }

    function test_zeroDtOwesNothing() public view {
        RateEngine.Split memory s = _split(1 ether, 0, 0, type(uint256).max);
        assertEq(s.owed, 0);
        assertEq(s.toUsers, 0);
        assertEq(s.toInsurance + s.toReserve, 1 ether);
    }

    function test_accrualWindowClamp() public view {
        // A 30-day relayer outage only accrues the 2-day window, so the reserve can't be drained at once.
        RateEngine.Split memory s = _split(0, 30 days, 1_000 ether, 0);
        assertEq(s.owed, RateEngine.owedFor(BASE, 800, 2 days, type(uint256).max));
    }

    function testFuzz_splitConservesReward(uint96 reward, uint32 dt, uint96 resBal, uint96 room) public view {
        RateEngine.Split memory s = _split(reward, dt, resBal, room);
        if (reward >= s.owed) {
            assertEq(s.toUsers + s.toInsurance + s.toReserve + s.toTreasury, reward);
            assertEq(s.reserveDraw, 0);
        } else {
            assertEq(s.toUsers, uint256(reward) + s.reserveDraw);
            assertLe(s.reserveDraw, resBal);
            assertLe(s.toUsers, s.owed);
        }
    }

    function _noClamp() internal pure returns (RateEngine.Params memory) {
        return RateEngine.Params({targetRateBps: 800, insuranceShareBps: 5000, maxAccrualWindow: type(uint256).max});
    }
}
