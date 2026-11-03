// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ISwapDesk} from "./interfaces/Interfaces.sol";

/// @title TokenBridge
/// @notice Lock-and-release tUSD bridge. The same contract runs on every chain: `bridge` locks tokens
///         and emits `Locked`; N-of-M signers attest to it off-chain; anyone holding the signatures
///         calls `release` on the destination.
///
/// With `minShares > 0` the destination also tries to save the money: on Portaldot, where `desk` is
/// set, `release` deposits through SwapDesk so the receiver ends up holding stPOT in one flow. If the
/// desk can't take it (stale price, no inventory, slippage) the receiver gets plain tUSD instead, so a
/// transfer never gets stuck on the save step.
///
/// Trust: signers can release everything this contract holds. Testnet only, not audited. Access
/// control is hand-rolled like StakingVault's, and admin calls emit no events: revive bills deploy
/// bytes, and the deployer's budget is the constraint here. `token` must revert on failure (tUSD does).
contract TokenBridge {
    bytes32 private constant RELEASE_TYPEHASH = keccak256(
        "PortaStakeRelease(uint256 srcChainId,address srcBridge,uint256 dstChainId,address dstBridge,uint64 nonce,address to,uint256 amount,uint256 minShares)"
    );

    IERC20 public immutable token;
    /// @notice SwapDesk used for the save step. Zero on every chain except Portaldot.
    ISwapDesk public immutable desk;

    address public owner;
    bool public paused;
    uint8 public threshold;
    uint64 public nonce;
    uint256 public maxPerTx;

    /// @notice The TokenBridge on another chain. Unset means that route is closed.
    mapping(uint256 chainId => address) public remotes;
    mapping(address => bool) public isSigner;
    mapping(bytes32 id => bool) public processed;

    event Locked(
        uint64 indexed nonce,
        uint256 indexed dstChainId,
        address indexed sender,
        address to,
        uint256 amount,
        uint256 minShares
    );
    event Released(
        bytes32 indexed id, uint256 indexed srcChainId, uint64 nonce, address indexed to, uint256 amount, uint256 shares
    );

    error NotOwner();
    error IsPaused();
    error UnknownRoute();
    error BadAmount();
    error ZeroAddress();
    error AlreadyProcessed();
    error BadSignatures();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    constructor(IERC20 token_, ISwapDesk desk_, address owner_) {
        token = token_;
        desk = desk_;
        owner = owner_;
    }

    /// @notice Lock `amount` here for `to` on `dstChainId`. `minShares > 0` asks the destination to save it.
    function bridge(uint256 dstChainId, address to, uint256 amount, uint256 minShares) external whenNotPaused {
        if (remotes[dstChainId] == address(0)) revert UnknownRoute();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > maxPerTx) revert BadAmount();
        token.transferFrom(msg.sender, address(this), amount);
        emit Locked(nonce++, dstChainId, msg.sender, to, amount, minShares);
    }

    /// @notice What each signer signs (EIP-191 personal_sign over this digest).
    function releaseDigest(uint256 srcChainId, uint64 srcNonce, address to, uint256 amount, uint256 minShares)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                RELEASE_TYPEHASH,
                srcChainId,
                remotes[srcChainId],
                block.chainid,
                address(this),
                srcNonce,
                to,
                amount,
                minShares
            )
        );
    }

    function releaseId(uint256 srcChainId, uint64 srcNonce) public pure returns (bytes32) {
        return keccak256(abi.encode(srcChainId, srcNonce));
    }

    /// @param sigs 65-byte signatures, concatenated, ordered by strictly ascending signer address.
    function release(
        uint256 srcChainId,
        uint64 srcNonce,
        address to,
        uint256 amount,
        uint256 minShares,
        bytes calldata sigs
    ) external whenNotPaused returns (uint256 shares) {
        if (remotes[srcChainId] == address(0)) revert UnknownRoute();
        bytes32 id = releaseId(srcChainId, srcNonce);
        if (processed[id]) revert AlreadyProcessed();
        _checkSignatures(releaseDigest(srcChainId, srcNonce, to, amount, minShares), sigs);
        processed[id] = true;

        if (minShares != 0 && address(desk) != address(0)) {
            token.approve(address(desk), amount);
            try desk.depositWithStable(amount, minShares, to) returns (uint256 s) {
                shares = s;
            } catch {
                token.approve(address(desk), 0);
            }
        }
        if (shares == 0) token.transfer(to, amount);
        emit Released(id, srcChainId, srcNonce, to, amount, shares);
    }

    function _checkSignatures(bytes32 digest, bytes calldata sigs) internal view {
        uint256 count = sigs.length / 65;
        if (threshold == 0 || count < threshold || sigs.length % 65 != 0) revert BadSignatures();
        bytes32 signed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address last;
        for (uint256 i; i < count; ++i) {
            bytes calldata sig = sigs[i * 65:(i + 1) * 65];
            // ecrecover returns zero on a bad signature, which fails the ascending check below.
            address signer = ecrecover(signed, uint8(sig[64]), bytes32(sig[:32]), bytes32(sig[32:64]));
            if (signer <= last || !isSigner[signer]) revert BadSignatures();
            last = signer;
        }
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setConfig(uint256 maxPerTx_, uint8 threshold_, bool paused_) external onlyOwner {
        maxPerTx = maxPerTx_;
        threshold = threshold_;
        paused = paused_;
    }

    function setRemote(uint256 chainId, address remote) external onlyOwner {
        remotes[chainId] = remote;
    }

    function setSigner(address signer, bool allowed) external onlyOwner {
        isSigner[signer] = allowed;
    }
}
