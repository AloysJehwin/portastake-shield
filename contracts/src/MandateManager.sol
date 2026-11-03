// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {ISwapDesk} from "./interfaces/Interfaces.sol";

/// @dev The ERC-20 surface MandateManager reads (balances only; moves go through SafeTransferLib).
interface IBalanceOf {
    function balanceOf(address) external view returns (uint256);
}

/// @title MandateManager
/// @notice Standing instructions over a user's savings, in both directions:
///
///                 RECURRING (auto)         SCHEDULED (one-time)   THRESHOLD
///   SAVE  wallet tUSD -> stPOT every N s   once at nextRun         wallet > bound: sweep the excess
///   PAY   stPOT -> tUSD to payee every N s once at nextRun         payee < bound: top up the gap
///
/// The revive EVM has no native cron, so `execute` is permissionless and the relayer acts as keeper:
/// it walks ids `[0, nextId)` with the `isDue` view and calls `execute(id)` for each due mandate.
/// Every rule the keeper relies on — due time, cooldown, run cap, expiry, threshold bound, slippage
/// floor — is enforced here, so a keeper can only ever move what the owner's own mandate allows.
/// Authority comes from the owner's allowances to this contract: tUSD for SAVE, stPOT shares for PAY.
/// Amounts are always in tUSD (the user thinks in dollars).
///
/// Size note: revive charges a storage deposit per byte of deployed code, so this contract carries
/// no admin role or global pause, uses a 1-slot reentrancy guard, Solady's SafeTransferLib, and
/// numeric error codes instead of revert strings.
contract MandateManager {
    using SafeTransferLib for address;

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

    // InvalidParams codes.
    uint8 internal constant BAD_AMOUNT = 1;
    uint8 internal constant BAD_SLIPPAGE = 2;
    uint8 internal constant BAD_INTERVAL = 3;
    uint8 internal constant BAD_START = 4;
    uint8 internal constant BAD_BOUND = 5;
    uint8 internal constant BAD_EXPIRY = 6;
    uint8 internal constant BAD_PAYEE = 7;

    uint256 internal constant BPS = 10_000;
    uint16 internal constant MAX_SLIPPAGE_BPS = 500;

    address public immutable stable;
    IERC4626 public immutable vault;
    ISwapDesk public immutable desk;

    uint256 public nextId;
    mapping(uint256 => Mandate) internal mandates;
    uint256 private _entered;

    event MandateCreated(
        uint256 indexed id, address indexed owner, Direction dir, Trigger trig, address payee, uint256 amount
    );
    event MandateExecuted(uint256 indexed id, uint256 usdAmount, uint256 shares, uint32 runs, uint64 nextRun);
    event MandatePaused(uint256 indexed id);
    event MandateResumed(uint256 indexed id);
    event MandateCancelled(uint256 indexed id);

    error NotOwner(uint256 id);
    error NotDue(uint256 id);
    error InvalidParams(uint8 code);
    error UnknownMandate(uint256 id);
    error Reentrant();

    constructor(address stable_, IERC4626 vault_, ISwapDesk desk_) {
        stable = stable_;
        vault = vault_;
        desk = desk_;
    }

    // ---------------------------------------------------------------------
    // Owner actions
    // ---------------------------------------------------------------------

    function create(MandateParams calldata p) external returns (uint256 id) {
        if (p.amount == 0) revert InvalidParams(BAD_AMOUNT);
        if (p.maxSlippageBps > MAX_SLIPPAGE_BPS) revert InvalidParams(BAD_SLIPPAGE);
        // RECURRING needs a period; THRESHOLD needs a cooldown, or a payee that controls its own
        // balance could re-trigger the top-up repeatedly inside one transaction.
        if (p.trig != Trigger.SCHEDULED && p.interval == 0) revert InvalidParams(BAD_INTERVAL);
        if (p.trig == Trigger.SCHEDULED && p.start < block.timestamp) revert InvalidParams(BAD_START);
        if (p.trig == Trigger.THRESHOLD && p.dir == Direction.SAVE && p.bound == 0) revert InvalidParams(BAD_BOUND);
        if (p.expiry != 0 && p.expiry <= block.timestamp) revert InvalidParams(BAD_EXPIRY);

        address payee = p.payee;
        if (p.dir == Direction.SAVE) {
            payee = msg.sender; // savings always accrue to the owner
        } else if (payee == address(0)) {
            if (p.trig != Trigger.THRESHOLD) revert InvalidParams(BAD_PAYEE);
            payee = msg.sender; // "keep my own wallet topped up"
        }

        id = nextId++;
        mandates[id] = Mandate({
            owner: msg.sender,
            nextRun: p.start == 0 ? uint64(block.timestamp) : p.start,
            dir: p.dir,
            trig: p.trig,
            active: true,
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
        _owned(id).active = false;
        emit MandatePaused(id);
    }

    function resumeMandate(uint256 id) external {
        _owned(id).active = true;
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
            uint256 bal = IBalanceOf(stable).balanceOf(m.owner);
            if (bal <= m.bound) return (false, 0);
            amount = bal - m.bound;
        } else {
            uint256 bal = IBalanceOf(stable).balanceOf(m.payee);
            if (bal >= m.bound) return (false, 0);
            amount = m.bound - bal;
        }
        if (amount > m.amount) amount = m.amount;
        due = amount > 0;
    }

    /// @notice Run one due mandate. Permissionless; reverts with `NotDue` otherwise.
    function execute(uint256 id) external returns (uint256 shares) {
        if (_entered == 1) revert Reentrant();
        _entered = 1;

        (bool due, uint256 amount) = isDue(id);
        if (!due) revert NotDue(id);
        Mandate storage m = mandates[id];

        // Effects before interactions.
        m.runs += 1;
        if (m.trig == Trigger.RECURRING) {
            uint64 next = m.nextRun + m.interval;
            m.nextRun = next > block.timestamp ? next : uint64(block.timestamp) + m.interval; // no burst catch-up
        } else if (m.trig == Trigger.THRESHOLD) {
            m.nextRun = uint64(block.timestamp) + m.interval; // cooldown
        } else {
            m.active = false;
        }

        uint256 keepBps = BPS - m.maxSlippageBps;
        address desk_ = address(desk);
        if (m.dir == Direction.SAVE) {
            stable.safeTransferFrom(m.owner, address(this), amount);
            stable.safeApprove(desk_, amount);
            uint256 minShares = vault.previewDeposit(desk.quotePotForUsd(amount)) * keepBps / BPS;
            shares = desk.depositWithStable(amount, minShares, m.owner);
        } else {
            shares = desk.quoteSharesForUsd(amount);
            address shareToken = address(vault);
            shareToken.safeTransferFrom(m.owner, address(this), shares);
            shareToken.safeApprove(desk_, shares);
            desk.redeemToStable(shares, amount * keepBps / BPS, m.payee);
        }

        emit MandateExecuted(id, amount, shares, m.runs, m.nextRun);
        _entered = 0;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _owned(uint256 id) internal view returns (Mandate storage m) {
        m = mandates[id];
        if (m.owner == address(0)) revert UnknownMandate(id);
        if (m.owner != msg.sender) revert NotOwner(id);
    }
}
