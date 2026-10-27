// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {ISlashableVault} from "./interfaces/Interfaces.sol";

/// @title OracleCommittee
/// @notice Proves a Substrate `staking.Slashed` event to the EVM. N-of-M attesters sign the same
///         digest; once the threshold is met anyone can submit, and the vault draws insurance.
/// @dev v1: attesters are admin-registered. Bonded, slashable attesters are a later pass.
contract OracleCommittee is AccessControl {
    using EnumerableSet for EnumerableSet.AddressSet;

    bytes32 public constant SLASH_TYPEHASH = keccak256("PortaStakeSlash(bytes32 validator,uint32 era,uint256 amount)");

    ISlashableVault public immutable vault;
    uint256 public threshold;
    mapping(bytes32 => bool) public processed;
    EnumerableSet.AddressSet private attesters;

    event AttesterAdded(address indexed attester);
    event AttesterRemoved(address indexed attester);
    event ThresholdUpdated(uint256 threshold);
    event SlashFinalized(
        bytes32 indexed slashId, bytes32 indexed validator, uint32 era, uint256 amount, uint256 covered, uint256 signers
    );

    error AlreadyProcessed(bytes32 slashId);
    error NotAttester(address signer);
    error SignersNotSorted();
    error BelowThreshold(uint256 signers, uint256 threshold);
    error InvalidThreshold(uint256 threshold);

    constructor(ISlashableVault vault_, address admin) {
        vault = vault_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice What each attester signs (EIP-191 personal_sign over this digest).
    ///         `validator` is the 32-byte SS58 public key; `amount` is in 18-decimal EVM units.
    function slashDigest(bytes32 validator, uint32 era, uint256 amount) public view returns (bytes32) {
        return keccak256(abi.encode(SLASH_TYPEHASH, block.chainid, address(this), validator, era, amount));
    }

    function slashId(bytes32 validator, uint32 era) public pure returns (bytes32) {
        return keccak256(abi.encode(validator, era));
    }

    /// @param sigs signatures ordered by strictly ascending signer address (cheap de-duplication)
    function submitSlash(bytes32 validator, uint32 era, uint256 amount, bytes[] calldata sigs)
        external
        returns (uint256 covered)
    {
        bytes32 id = slashId(validator, era);
        if (processed[id]) revert AlreadyProcessed(id);
        if (sigs.length < threshold || threshold == 0) revert BelowThreshold(sigs.length, threshold);

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(slashDigest(validator, era, amount));
        address last;
        for (uint256 i; i < sigs.length; ++i) {
            address signer = ECDSA.recover(digest, sigs[i]);
            if (signer <= last) revert SignersNotSorted();
            if (!attesters.contains(signer)) revert NotAttester(signer);
            last = signer;
        }

        processed[id] = true;
        covered = vault.reportSlash(amount);
        emit SlashFinalized(id, validator, era, amount, covered, sigs.length);
    }

    function addAttester(address attester) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (attesters.add(attester)) emit AttesterAdded(attester);
    }

    function removeAttester(address attester) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (attesters.remove(attester)) emit AttesterRemoved(attester);
        if (threshold > attesters.length()) _setThreshold(attesters.length());
    }

    function setThreshold(uint256 threshold_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (threshold_ == 0 || threshold_ > attesters.length()) revert InvalidThreshold(threshold_);
        _setThreshold(threshold_);
    }

    function attesterList() external view returns (address[] memory) {
        return attesters.values();
    }

    function _setThreshold(uint256 threshold_) internal {
        threshold = threshold_;
        emit ThresholdUpdated(threshold_);
    }
}
