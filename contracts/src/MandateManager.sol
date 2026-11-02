// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {ISwapDesk} from "./interfaces/Interfaces.sol";

/// @title MandateManager
/// @notice Standing instructions over a user's savings, in both directions:
///
///                 RECURRING (auto)         SCHEDULED (one-time)   THRESHOLD
///   SAVE  wallet tUSD -> stPOT every N s   once at nextRun         wallet > bound: sweep the excess
///   PAY   stPOT -> tUSD to payee every N s once at nextRun         payee < bound: top up the gap
///
/// There is no on-chain cron in the revive EVM, so `execute`/`executeBatch` are permissionless and
/// the relayer runs as keeper. Authority comes from the owner's allowances to this contract:
/// tUSD for SAVE, stPOT shares for PAY. Amounts are always in tUSD (the user thinks in dollars).
contract MandateManager is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    enum Direction {
        SAVE,
        PAY
    }

    enum Trigger {
        RECURRING,
        SCHEDULED,
        THRESHOLD
    }

    /// @dev Packed into 3 storage slots: revive charges a storage deposit per byte.
    struct Mandate {
        // slot 1
        address owner;
        uint64 nextRun;
        Direction dir;
        Trigger trig;
        bool active;
        uint8 fails;
        // slot 2
        address payee;
        uint32 interval; // RECURRING period, or THRESHOLD cooldown
        uint32 runs;
        uint32 maxRuns; // 0 = unlimited
        // slot 3
        uint96 amount; // per-run amount / per-run cap, tUSD
        uint96 bound; // THRESHOLD balance bound, tUSD
        uint40 expiry; // 0 = never
        uint16 maxSlippageBps;
    }

    struct MandateParams {
        Direction dir;
        Trigger trig;
        address payee;
        uint96 amount;
        uint96 bound;
        uint64 start;
        uint32 interval;
        uint32 maxRuns;
        uint40 expiry;
        uint16 maxSlippageBps;
    }

    uint256 public constant BPS = 10_000;
    uint8 public constant MAX_FAILS = 3;
    uint16 public constant MAX_SLIPPAGE_BPS = 500;

    IERC20 public immutable stable;
    IERC4626 public immutable vault;
    ISwapDesk public immutable desk;

    uint256 public nextId;
    mapping(uint256 => Mandate) internal mandates;

    event MandateCreated(
        uint256 indexed id, address indexed owner, Direction dir, Trigger trig, address payee, uint256 amount
    );
    event MandateExecuted(uint256 indexed id, uint256 usdAmount, uint256 shares, uint32 runs, uint64 nextRun);
    event MandateFailed(uint256 indexed id, bytes reason);
    event MandatePaused(uint256 indexed id, bool auto_);
    event MandateResumed(uint256 indexed id);
    event MandateCancelled(uint256 indexed id);

    error NotOwner(uint256 id);
    error NotDue(uint256 id);
    error InvalidParams(string why);
    error UnknownMandate(uint256 id);
    error OnlySelf();

    constructor(IERC20 stable_, IERC4626 vault_, ISwapDesk desk_, address admin) {
        stable = stable_;
        vault = vault_;
        desk = desk_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Owner actions
    // ---------------------------------------------------------------------

    function create(MandateParams calldata p) external whenNotPaused returns (uint256 id) {
        if (p.amount == 0) revert InvalidParams("amount");
        if (p.maxSlippageBps > MAX_SLIPPAGE_BPS) revert InvalidParams("slippage");
        if (p.trig == Trigger.RECURRING && p.interval == 0) revert InvalidParams("interval");
        if (p.trig == Trigger.SCHEDULED && p.start < block.timestamp) revert InvalidParams("start");
        if (p.trig == Trigger.THRESHOLD && p.dir == Direction.SAVE && p.bound == 0) revert InvalidParams("bound");
        if (p.expiry != 0 && p.expiry <= block.timestamp) revert InvalidParams("expiry");

        address payee = p.payee;
        if (p.dir == Direction.SAVE) {
            payee = msg.sender; // savings always accrue to the owner
        } else if (payee == address(0)) {
            if (p.trig != Trigger.THRESHOLD) revert InvalidParams("payee");
            payee = msg.sender; // "keep my own wallet topped up"
        }

        id = nextId++;
        mandates[id] = Mandate({
            owner: msg.sender,
            nextRun: p.start == 0 ? uint64(block.timestamp) : p.start,
            dir: p.dir,
            trig: p.trig,
            active: true,
            fails: 0,
            payee: payee,
            interval: p.interval,
            runs: 0,
            maxRuns: p.trig == Trigger.SCHEDULED ? 1 : p.maxRuns,
            amount: p.amount,
            bound: p.bound,
            expiry: p.expiry,
            maxSlippageBps: p.maxSlippageBps
        });
        emit MandateCreated(id, msg.sender, p.dir, p.trig, payee, p.amount);
    }

    function pauseMandate(uint256 id) external {
        Mandate storage m = _owned(id);
        m.active = false;
        emit MandatePaused(id, false);
    }

    function resumeMandate(uint256 id) external {
        Mandate storage m = _owned(id);
        m.active = true;
        m.fails = 0;
        emit MandateResumed(id);
    }

    /// @notice Deletes the mandate, which also releases its storage deposit.
    function cancel(uint256 id) external {
        _owned(id);
        delete mandates[id];
        emit MandateCancelled(id);
    }

    function getMandate(uint256 id) external view returns (Mandate memory) {
        return mandates[id];
    }

    // ---------------------------------------------------------------------
    // Keeper
    // ---------------------------------------------------------------------

    /// @return due    whether `execute(id)` would run now
    /// @return amount tUSD it would move
    function isDue(uint256 id) public view returns (bool due, uint256 amount) {
        Mandate storage m = mandates[id];
        if (m.owner == address(0) || !m.active) return (false, 0);
        if (m.expiry != 0 && block.timestamp > m.expiry) return (false, 0);
        if (m.maxRuns != 0 && m.runs >= m.maxRuns) return (false, 0);
        if (block.timestamp < m.nextRun) return (false, 0);

        if (m.trig != Trigger.THRESHOLD) return (true, m.amount);

        if (m.dir == Direction.SAVE) {
            uint256 bal = stable.balanceOf(m.owner);
            if (bal <= m.bound) return (false, 0);
            amount = bal - m.bound;
        } else {
            uint256 bal = stable.balanceOf(m.payee);
            if (bal >= m.bound) return (false, 0);
            amount = m.bound - bal;
        }
        if (amount > m.amount) amount = m.amount;
        due = amount > 0;
    }

    function execute(uint256 id) external nonReentrant whenNotPaused returns (uint256 shares) {
        return _execute(id);
    }

    /// @notice Runs every due mandate in `ids`; failures are recorded instead of reverting the batch.
    ///         A mandate that fails MAX_FAILS times in a row is auto-paused.
    function executeBatch(uint256[] calldata ids) external whenNotPaused returns (uint256 executed) {
        for (uint256 i; i < ids.length; ++i) {
            (bool due,) = isDue(ids[i]);
            if (!due) continue;
            try this.executeFromBatch(ids[i]) {
                ++executed;
            } catch (bytes memory reason) {
                Mandate storage m = mandates[ids[i]];
                m.fails += 1;
                emit MandateFailed(ids[i], reason);
                if (m.fails >= MAX_FAILS) {
                    m.active = false;
                    emit MandatePaused(ids[i], true);
                }
            }
        }
    }

    /// @dev External so executeBatch can try/catch it; callable only by this contract.
    function executeFromBatch(uint256 id) external nonReentrant returns (uint256) {
        if (msg.sender != address(this)) revert OnlySelf();
        return _execute(id);
    }

    /// @notice Scan ids [cursor, cursor + count) for due mandates. Returns the next cursor.
    function dueIds(uint256 cursor, uint256 count) external view returns (uint256[] memory ids, uint256 next) {
        uint256 end = cursor + count;
        if (end > nextId) end = nextId;
        uint256[] memory buf = new uint256[](end > cursor ? end - cursor : 0);
        uint256 n;
        for (uint256 id = cursor; id < end; ++id) {
            (bool due,) = isDue(id);
            if (due) buf[n++] = id;
        }
        assembly ("memory-safe") {
            mstore(buf, n)
        }
        return (buf, end);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _execute(uint256 id) internal returns (uint256 shares) {
        (bool due, uint256 amount) = isDue(id);
        if (!due) revert NotDue(id);
        Mandate storage m = mandates[id];

        // Effects before interactions.
        m.runs += 1;
        m.fails = 0;
        if (m.trig == Trigger.RECURRING) {
            uint64 next = m.nextRun + m.interval;
            m.nextRun = next > block.timestamp ? next : uint64(block.timestamp) + m.interval; // no burst catch-up
        } else if (m.trig == Trigger.THRESHOLD) {
            m.nextRun = uint64(block.timestamp) + m.interval; // cooldown
        } else {
            m.active = false;
        }

        uint256 keepBps = BPS - m.maxSlippageBps;
        if (m.dir == Direction.SAVE) {
            stable.safeTransferFrom(m.owner, address(this), amount);
            stable.forceApprove(address(desk), amount);
            uint256 minShares = vault.previewDeposit(desk.quotePotForUsd(amount)) * keepBps / BPS;
            shares = desk.depositWithStable(amount, minShares, m.owner);
        } else {
            shares = desk.quoteSharesForUsd(amount);
            IERC20(address(vault)).safeTransferFrom(m.owner, address(this), shares);
            IERC20(address(vault)).forceApprove(address(desk), shares);
            desk.redeemToStable(shares, amount * keepBps / BPS, m.payee);
        }

        emit MandateExecuted(id, amount, shares, m.runs, m.nextRun);
    }

    function _owned(uint256 id) internal view returns (Mandate storage m) {
        m = mandates[id];
        if (m.owner == address(0)) revert UnknownMandate(id);
        if (m.owner != msg.sender) revert NotOwner(id);
    }
}
