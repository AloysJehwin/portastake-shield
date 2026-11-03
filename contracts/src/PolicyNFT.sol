// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPolicyNFT} from "./interfaces/Interfaces.sol";

/// @title PortaStake Policy
/// @notice Soulbound coverage certificate, one per depositor, minted by the vault on first deposit.
///         Coverage itself is pool-wide; this records the terms in force when the holder joined.
///
/// A soulbound token never moves, so this is a minimal ERC-721 rather than a full one: it carries
/// the read surface wallets and explorers use (`balanceOf`, `ownerOf`, `tokenURI`, ERC-165) and
/// emits `Transfer` on mint, while every transfer/approval entry point reverts. It also implements
/// ERC-5192 (`locked` + `Locked`). Dropping the transfer machinery and the role table keeps the
/// revive code deposit to a fraction of an OpenZeppelin ERC721 + AccessControl build.
contract PolicyNFT is IPolicyNFT {
    string public constant name = "PortaStake Policy";
    string public constant symbol = "PSP";

    /// @notice The StakingVault — the only account that can mint.
    address public immutable minter;

    uint256 public nextId = 1;
    mapping(address => uint256) public policyOf;
    mapping(uint256 => address) internal _ownerOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 tokenId);
    event TermsSnapshot(uint256 indexed id, address indexed holder, uint256 targetRateBps, uint256 insuranceShareBps);

    error Soulbound();
    error NotAuthorized();
    error NonexistentToken(uint256 tokenId);

    constructor(address minter_) {
        minter = minter_;
    }

    function mintFor(address holder, uint256 targetRateBps, uint256 insuranceShareBps) external returns (uint256 id) {
        if (msg.sender != minter) revert NotAuthorized();
        id = policyOf[holder];
        if (id != 0) return id;
        id = nextId++;
        policyOf[holder] = id;
        _ownerOf[id] = holder;
        emit Transfer(address(0), holder, id);
        emit Locked(id);
        emit TermsSnapshot(id, holder, targetRateBps, insuranceShareBps);
    }

    // --- ERC-721 read surface ---------------------------------------------------

    function balanceOf(address owner) external view returns (uint256) {
        return policyOf[owner] == 0 ? 0 : 1;
    }

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = _ownerOf[tokenId];
        if (owner == address(0)) revert NonexistentToken(tokenId);
    }

    /// @notice Terms live in the TermsSnapshot event; the certificate needs no external metadata.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        return "";
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    /// @notice ERC-5192: every policy is permanently locked to its holder.
    function locked(uint256 tokenId) external view returns (bool) {
        ownerOf(tokenId);
        return true;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 // ERC-165
            || id == 0x80ac58cd // ERC-721
            || id == 0x5b5e139f // ERC-721 Metadata
            || id == 0xb45a3c0e; // ERC-5192
    }

    // --- transfers and approvals: always revert -------------------------------

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }
}
