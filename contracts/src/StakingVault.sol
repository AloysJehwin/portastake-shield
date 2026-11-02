// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC4626} from "solady/tokens/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {WPOT} from "./WPOT.sol";
import {RateEngine} from "./RateEngine.sol";
import {IWpotBucket, IPolicyNFT, ISlashableVault} from "./interfaces/Interfaces.sol";

/// @dev Minimal in-place replacement for OpenZeppelin's Math.min / mulDiv (no overflow magic;
/// our inputs are 18-decimal balances × bps, well under 2^192).
library TinyMath {
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
    function mulDiv(uint256 a, uint256 b, uint256 denom) internal pure returns (uint256) {
        return (a * b) / denom;
    }
}

/// @title StakingVault (stPOT)
/// @notice ERC-4626 vault over WPOT. Deposits mint stPOT; the relayer bonds swept POT on the
///         Substrate side (pallet-revive has no staking precompile) and reports rewards back.
///
/// Access control is a hand-rolled 2-role + admin table (RELAYER / SLASHER / ADMIN) instead of
/// OpenZeppelin's AccessControl: we only need boolean role checks, not role-admin trees or
/// enumeration, and OZ's version adds ~800 bytes of code for features we never call. Pause state
/// is a single bool. Reentrancy is a 1-slot guard. These three cuts shave roughly 1 kB off the
/// deployed vault, which is 60% of stage-1 revive deposit.
///
/// `policy` is settable so the coverage NFT can arrive in a later deploy stage without a vault
/// redeploy. While unset, deposits succeed and simply skip the mint.
contract StakingVault is ERC4626, ISlashableVault {
    using SafeERC20 for IERC20;
    using TinyMath for uint256;

    // --- roles (hand-rolled, zero-cost storage layout) ---
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    mapping(bytes32 => mapping(address => bool)) private _roles;

    uint256 public constant BPS = 10_000;
    uint256 public constant NATIVE_UNIT = 1e4;
    uint256 public constant REWARDS_CYCLE = 6 hours; // one Portaldot V3 era

    uint256 public constant MAX_TARGET_RATE_BPS = 1_500;
    uint256 public constant MAX_RESERVE_CAP_BPS = 5_000;
    uint256 public constant MAX_TARGET_HOT_BPS = 5_000;

    WPOT public immutable wpot;
    IWpotBucket public immutable insuranceFund;
    IWpotBucket public immutable reserve;

    /// @notice Coverage certificate contract. Settable so it can arrive in a later deploy stage.
    IPolicyNFT public policy;

    address public treasury;
    /// @notice H160 of the relayer's mapped SS58 stash; swept POT lands in that Substrate account.
    address public stakingAccount;

    // --- yield target parameters ---
    uint256 public targetRateBps = 800;
    uint256 public insuranceShareBps = 5_000;
    uint256 public reserveCapBps = 1_000;
    uint256 public targetHotBps = 1_000;
    uint256 public maxAccrualWindow = 2 days;

    // --- accounting ---
    uint256 public bondedPrincipal;
    uint256 public pendingUnstakeAssets;
    uint128 public streamAmount;
    uint64 public streamEnd;
    uint64 public lastAccrual;
    uint256 public lastEffectiveRateBps;

    // --- pause + reentrancy (1 slot each, both booleans) ---
    bool public paused;
    uint256 private _entered; // 0 = free, 1 = inside call

    struct UnstakeRequest {
        address receiver;
        bool fulfilled;
        uint256 assets;
    }

    UnstakeRequest[] public unstakeRequests;

    event StakeRequested(address indexed stakingAccount, uint256 amount);
    event RewardSplit(
        uint256 reward,
        uint256 owed,
        uint256 toUsers,
        uint256 toInsurance,
        uint256 toReserve,
        uint256 toTreasury,
        uint256 reserveDraw,
        uint256 effectiveRateBps
    );
    event RateDowngraded(uint256 effectiveRateBps, uint256 targetRateBps);
    event SlashCovered(uint256 amount, uint256 covered);
    event UncoveredLoss(uint256 amount);
    event UnstakeRequested(uint256 indexed id, address indexed owner, address receiver, uint256 shares, uint256 assets);
    event UnstakeFulfilled(uint256 indexed id, address indexed receiver, uint256 assets);
    event ParamsUpdated(
        uint256 targetRateBps,
        uint256 insuranceShareBps,
        uint256 reserveCapBps,
        uint256 targetHotBps,
        uint256 maxAccrualWindow
    );
    event AddressApplied(bytes32 indexed name, address value);
    event RoleGranted(bytes32 indexed role, address indexed account);
    event RoleRevoked(bytes32 indexed role, address indexed account);
    event Paused(address by);
    event Unpaused(address by);

    error ZeroAmount();
    error NotNativeUnit(uint256 amount);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error BelowHotTarget(uint256 remaining, uint256 floor);
    error InsufficientBonded(uint256 requested, uint256 available);
    error AlreadyFulfilled(uint256 id);
    error WrongValue(uint256 expected, uint256 got);
    error OutOfBounds(bytes32 name, uint256 value);
    error ZeroAddress();
    error NativeTransferFailed();
    error UnexpectedNative();
    error NotAuthorized(bytes32 role);
    error Reentrant();
    error IsPaused();

    modifier onlyRole(bytes32 role) {
        if (!_roles[role][msg.sender]) revert NotAuthorized(role);
        _;
    }

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrant();
        _entered = 1;
        _;
        _entered = 0;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    constructor(
        WPOT wpot_,
        IWpotBucket insuranceFund_,
        IWpotBucket reserve_,
        address admin,
        address treasury_,
        address stakingAccount_
    ) {
        if (treasury_ == address(0) || stakingAccount_ == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        wpot = wpot_;
        insuranceFund = insuranceFund_;
        reserve = reserve_;
        treasury = treasury_;
        stakingAccount = stakingAccount_;
        lastAccrual = uint64(block.timestamp);
        _roles[DEFAULT_ADMIN_ROLE][admin] = true;
        emit RoleGranted(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @dev Solady's ERC20 reads name/symbol from these virtual getters instead of storage.
    function name() public pure override returns (string memory) {
        return "Staked tPOT";
    }

    function symbol() public pure override returns (string memory) {
        return "stPOT";
    }

    /// @dev Solady's ERC4626 asset() is virtual; return the WPOT address.
    function asset() public view override returns (address) {
        return address(wpot);
    }

    /// @dev Native POT only arrives from WPOT unwraps; rewards/claims come through payable functions.
    receive() external payable {
        if (msg.sender != address(wpot)) revert UnexpectedNative();
    }

    // ---------------------------------------------------------------------
    // Access control
    // ---------------------------------------------------------------------

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return _roles[role][account];
    }

    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_roles[role][account]) {
            _roles[role][account] = true;
            emit RoleGranted(role, account);
        }
    }

    function revokeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_roles[role][account]) {
            _roles[role][account] = false;
            emit RoleRevoked(role, account);
        }
    }

    // ---------------------------------------------------------------------
    // ERC-4626 accounting
    // ---------------------------------------------------------------------

    function totalAssets() public view override returns (uint256) {
        uint256 held = wpot.balanceOf(address(this)) + bondedPrincipal;
        uint256 owedOut = unvestedRewards() + pendingUnstakeAssets;
        return held > owedOut ? held - owedOut : 0;
    }

    /// @notice User yield credited but not yet vested into the share price.
    function unvestedRewards() public view returns (uint256) {
        uint256 end = streamEnd;
        if (block.timestamp >= end) return 0;
        return (uint256(streamAmount) * (end - block.timestamp)) / REWARDS_CYCLE;
    }

    /// @notice WPOT that can leave the vault right now (hot reserve, excluding unvested yield).
    function availableLiquidity() public view returns (uint256) {
        uint256 bal = wpot.balanceOf(address(this));
        uint256 locked = unvestedRewards();
        return bal > locked ? bal - locked : 0;
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        return paused ? 0 : super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return paused ? 0 : super.maxMint(receiver);
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        return super.maxWithdraw(owner).min(availableLiquidity());
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return super.maxRedeem(owner).min(convertToShares(availableLiquidity()));
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (paused) revert IsPaused();
        super._deposit(caller, receiver, assets, shares);
        _issuePolicy(receiver);
    }

    /// @notice Deposit native tPOT directly (wraps to WPOT).
    function depositNative(address receiver) external payable nonReentrant whenNotPaused returns (uint256 shares) {
        uint256 assets = msg.value;
        if (assets == 0) revert ZeroAmount();
        shares = previewDeposit(assets); // before the wrap moves totalAssets
        wpot.deposit{value: assets}();
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
        _issuePolicy(receiver);
    }

    /// @dev Skip the mint while `policy` is unset so stage 1 (vault without the NFT) still works.
    function _issuePolicy(address holder) internal {
        IPolicyNFT p = policy;
        if (address(p) != address(0)) p.mintFor(holder, targetRateBps, insuranceShareBps);
    }

    // ---------------------------------------------------------------------
    // Relayer: staking bridge
    // ---------------------------------------------------------------------

    /// @notice Move hot WPOT to the Substrate stash for bonding. Keeps `targetHotBps` liquid.
    function sweepToStake(uint256 amount) external nonReentrant onlyRole(RELAYER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (amount % NATIVE_UNIT != 0) revert NotNativeUnit(amount);
        uint256 liquid = availableLiquidity();
        if (amount > liquid) revert InsufficientLiquidity(amount, liquid);
        uint256 floor = totalAssets().mulDiv(targetHotBps, BPS);
        if (liquid - amount < floor) revert BelowHotTarget(liquid - amount, floor);

        bondedPrincipal += amount;
        wpot.withdraw(amount);
        (bool ok,) = stakingAccount.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit StakeRequested(stakingAccount, amount);
    }

    /// @notice Report one era's staking reward (sent as native value) and apply the target-rate split.
    function notifyReward() external payable nonReentrant onlyRole(RELAYER_ROLE) {
        uint256 reward = msg.value;
        uint256 base = totalAssets();
        uint256 dt = block.timestamp - lastAccrual;

        uint256 reserveBal = wpot.balanceOf(address(reserve));
        uint256 cap = base.mulDiv(reserveCapBps, BPS);
        uint256 room = cap > reserveBal ? cap - reserveBal : 0;

        RateEngine.Split memory s = RateEngine.split(
            reward,
            base,
            dt,
            reserveBal,
            room,
            RateEngine.Params({
                targetRateBps: targetRateBps, insuranceShareBps: insuranceShareBps, maxAccrualWindow: maxAccrualWindow
            })
        );

        if (reward > 0) wpot.deposit{value: reward}();
        IERC20 asset_ = IERC20(address(wpot));
        if (s.toInsurance > 0) asset_.safeTransfer(address(insuranceFund), s.toInsurance);
        if (s.toReserve > 0) asset_.safeTransfer(address(reserve), s.toReserve);
        if (s.toTreasury > 0) asset_.safeTransfer(treasury, s.toTreasury);
        if (s.reserveDraw > 0) reserve.pull(s.reserveDraw);

        streamAmount = uint128(unvestedRewards() + s.toUsers);
        streamEnd = uint64(block.timestamp + REWARDS_CYCLE);
        lastAccrual = uint64(block.timestamp);
        lastEffectiveRateBps = RateEngine.effectiveRateBps(s.toUsers, base, dt);

        emit RewardSplit(
            reward, s.owed, s.toUsers, s.toInsurance, s.toReserve, s.toTreasury, s.reserveDraw, lastEffectiveRateBps
        );
        if (s.downgraded) emit RateDowngraded(lastEffectiveRateBps, targetRateBps);
    }

    /// @notice Record a validator slash (from OracleCommittee) and draw insurance to make the vault whole.
    function reportSlash(uint256 amount) external nonReentrant onlyRole(SLASHER_ROLE) returns (uint256 covered) {
        if (amount > bondedPrincipal) amount = bondedPrincipal;
        bondedPrincipal -= amount;
        covered = insuranceFund.pull(amount);
        if (covered < amount) emit UncoveredLoss(amount - covered);
        emit SlashCovered(amount, covered);
    }

    // ---------------------------------------------------------------------
    // Slow exit (unbonding takes 672 eras ≈ 168 days on V3 testnet)
    // ---------------------------------------------------------------------

    function requestUnstake(uint256 shares, address receiver) external nonReentrant returns (uint256 id) {
        if (shares == 0) revert ZeroAmount();
        uint256 assets = previewRedeem(shares);
        assets -= assets % NATIVE_UNIT; // Substrate can only unbond whole native units
        if (assets == 0) revert ZeroAmount();
        uint256 unclaimed = bondedPrincipal - pendingUnstakeAssets;
        if (assets > unclaimed) revert InsufficientBonded(assets, unclaimed);

        _burn(msg.sender, shares);
        pendingUnstakeAssets += assets;
        id = unstakeRequests.length;
        unstakeRequests.push(UnstakeRequest({receiver: receiver, fulfilled: false, assets: assets}));
        emit UnstakeRequested(id, msg.sender, receiver, shares, assets);
    }

    function fulfillUnstake(uint256 id) external payable nonReentrant onlyRole(RELAYER_ROLE) {
        UnstakeRequest storage r = unstakeRequests[id];
        if (r.fulfilled) revert AlreadyFulfilled(id);
        if (msg.value != r.assets) revert WrongValue(r.assets, msg.value);
        r.fulfilled = true;
        pendingUnstakeAssets -= r.assets;
        bondedPrincipal -= r.assets;
        wpot.deposit{value: msg.value}();
        IERC20(address(wpot)).safeTransfer(r.receiver, r.assets);
        emit UnstakeFulfilled(id, r.receiver, r.assets);
    }

    function unstakeRequestCount() external view returns (uint256) {
        return unstakeRequests.length;
    }

    // ---------------------------------------------------------------------
    // Admin (held by a 24h TimelockController after bootstrap)
    // ---------------------------------------------------------------------

    function setParams(
        uint256 targetRateBps_,
        uint256 insuranceShareBps_,
        uint256 reserveCapBps_,
        uint256 targetHotBps_,
        uint256 maxAccrualWindow_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (targetRateBps_ > MAX_TARGET_RATE_BPS) {
            revert OutOfBounds("targetRateBps", targetRateBps_);
        }
        if (insuranceShareBps_ > BPS) revert OutOfBounds("insuranceShareBps", insuranceShareBps_);
        if (reserveCapBps_ > MAX_RESERVE_CAP_BPS) revert OutOfBounds("reserveCapBps", reserveCapBps_);
        if (targetHotBps_ > MAX_TARGET_HOT_BPS) revert OutOfBounds("targetHotBps", targetHotBps_);
        if (maxAccrualWindow_ < 1 hours || maxAccrualWindow_ > 30 days) {
            revert OutOfBounds("maxAccrualWindow", maxAccrualWindow_);
        }
        targetRateBps = targetRateBps_;
        insuranceShareBps = insuranceShareBps_;
        reserveCapBps = reserveCapBps_;
        targetHotBps = targetHotBps_;
        maxAccrualWindow = maxAccrualWindow_;
        emit ParamsUpdated(targetRateBps_, insuranceShareBps_, reserveCapBps_, targetHotBps_, maxAccrualWindow_);
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit AddressApplied("treasury", treasury_);
    }

    function setStakingAccount(address stakingAccount_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (stakingAccount_ == address(0)) revert ZeroAddress();
        stakingAccount = stakingAccount_;
        emit AddressApplied("stakingAccount", stakingAccount_);
    }

    /// @notice Attach the coverage certificate contract. Zero address disables issuance.
    function setPolicy(IPolicyNFT policy_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        policy = policy_;
        emit AddressApplied("policy", address(policy_));
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = false;
        emit Unpaused(msg.sender);
    }
}
