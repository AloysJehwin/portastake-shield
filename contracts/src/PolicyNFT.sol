// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IPolicyNFT} from "./interfaces/Interfaces.sol";

/// @title PortaStake Policy
/// @notice Soulbound coverage certificate, one per depositor, minted by the vault on first deposit.
///         Coverage itself is pool-wide; this records the terms in force when the holder joined.
contract PolicyNFT is IPolicyNFT, ERC721, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint256 public nextId = 1;
    mapping(address => uint256) public policyOf;
    string private baseTokenURI;

    event TermsSnapshot(uint256 indexed id, address indexed holder, uint256 targetRateBps, uint256 insuranceShareBps);

    error Soulbound();

    constructor(address admin) ERC721("PortaStake Policy", "PSP") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function mintFor(address holder, uint256 targetRateBps, uint256 insuranceShareBps)
        external
        onlyRole(MINTER_ROLE)
        returns (uint256 id)
    {
        id = policyOf[holder];
        if (id != 0) return id;
        id = nextId++;
        policyOf[holder] = id;
        _mint(holder, id);
        emit TermsSnapshot(id, holder, targetRateBps, insuranceShareBps);
    }

    function setBaseURI(string calldata uri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        baseTokenURI = uri;
    }

    function _baseURI() internal view override returns (string memory) {
        return baseTokenURI;
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0)) revert Soulbound();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
