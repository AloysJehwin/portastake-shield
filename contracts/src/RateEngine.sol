// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title RateEngine
/// @notice Pure math behind the reserve-backed yield target ("8%").
///
/// Each era the relayer hands the vault the staking reward R. Users are owed
/// `base * targetRate * dt / year`. A surplus is split between the InsuranceFund and the
/// StabilizationReserve (reserve capped; overflow to treasury). A shortfall is topped up from the
/// reserve; if the reserve can't cover it, users get what there is and the rate is "downgraded".
library RateEngine {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;

    struct Params {
        uint256 targetRateBps;
        uint256 insuranceShareBps;
        uint256 maxAccrualWindow;
    }

    struct Split {
        uint256 owed;
        uint256 toUsers;
        uint256 toInsurance;
        uint256 toReserve;
        uint256 toTreasury;
        uint256 reserveDraw;
        bool downgraded;
    }

    /// @dev `dt` is clamped so a relayer outage can't make one call drain the reserve.
    function owedFor(uint256 base, uint256 rateBps, uint256 dt, uint256 maxAccrualWindow)
        internal
        pure
        returns (uint256)
    {
        if (dt > maxAccrualWindow) dt = maxAccrualWindow;
        return Math.mulDiv(base, rateBps * dt, BPS * YEAR);
    }

    /// @param reward         staking reward received this period
    /// @param base           vault totalAssets before the reward
    /// @param dt             seconds since the previous accrual
    /// @param reserveBalance WPOT currently in the StabilizationReserve
    /// @param reserveRoom    how much more the reserve may hold before hitting its cap
    function split(
        uint256 reward,
        uint256 base,
        uint256 dt,
        uint256 reserveBalance,
        uint256 reserveRoom,
        Params memory p
    ) internal pure returns (Split memory s) {
        s.owed = owedFor(base, p.targetRateBps, dt, p.maxAccrualWindow);

        if (reward >= s.owed) {
            s.toUsers = s.owed;
            uint256 surplus = reward - s.owed;
            s.toInsurance = Math.mulDiv(surplus, p.insuranceShareBps, BPS);
            uint256 rest = surplus - s.toInsurance;
            s.toReserve = rest < reserveRoom ? rest : reserveRoom;
            s.toTreasury = rest - s.toReserve;
        } else {
            uint256 deficit = s.owed - reward;
            s.reserveDraw = deficit < reserveBalance ? deficit : reserveBalance;
            s.toUsers = reward + s.reserveDraw;
            s.downgraded = s.reserveDraw < deficit;
        }
    }

    /// @notice Annualised rate actually credited to users for a period, in bps.
    function effectiveRateBps(uint256 toUsers, uint256 base, uint256 dt) internal pure returns (uint256) {
        if (base == 0 || dt == 0) return 0;
        return Math.mulDiv(toUsers, BPS * YEAR, base * dt);
    }
}
