// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @title x402 Test USD (xUSD)
/// @notice Testnet stablecoin for x402 pay-per-request payments on Portaldot.
///
/// x402's `exact` EVM scheme settles with EIP-3009 `transferWithAuthorization`: the payer signs an
/// EIP-712 authorization, and a facilitator submits it and pays the gas. This token implements that
/// entry point (plus `authorizationState` and `version`, which x402 facilitators read) on top of
/// Solady's ERC20, which already provides EIP-2612 `permit` and the EIP-712 domain.
///
/// Domain: name "x402 Test USD", version "1", chainId, this contract. Testnet only: anyone can mint
/// up to `FAUCET_MAX` per call.
contract X402Dollar is ERC20 {
    /// @dev keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    uint256 public constant FAUCET_MAX = 1_000e6;

    /// @notice Whether `nonce` has been used by `authorizer` (EIP-3009).
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error FaucetLimit(uint256 requested);
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationUsedAlready();
    error InvalidSignature();

    function name() public pure override returns (string memory) {
        return "x402 Test USD";
    }

    function symbol() public pure override returns (string memory) {
        return "xUSD";
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice EIP-712 domain version, read by x402 facilitators to build the domain.
    function version() external pure returns (string memory) {
        return "1";
    }

    function faucet(uint256 amount) external {
        if (amount > FAUCET_MAX) revert FaucetLimit(amount);
        _mint(msg.sender, amount);
    }

    /// @notice EIP-3009: move `value` from `from` to `to` using `from`'s signed authorization.
    ///         Anyone may submit it; the signature binds every field, and each nonce works once.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationUsedAlready();

        bytes32 structHash =
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        // Reject malleable (high-s) signatures, as OpenZeppelin's ECDSA does.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert InvalidSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != from) revert InvalidSignature();

        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @dev Precomputed so the domain separator doesn't hash `name()` on every call.
    function _constantNameHash() internal pure override returns (bytes32) {
        return keccak256("x402 Test USD");
    }

    /// @dev No implicit Permit2 allowance: allowances are exactly what holders set.
    function _givePermit2InfiniteAllowance() internal pure override returns (bool) {
        return false;
    }
}
