// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {Strings} from "@openzeppelin/contracts-v4.4/utils/Strings.sol";
import {INFTDescriptor} from "contracts/0.8.9/WithdrawalQueueERC721.sol";

contract NFTDescriptor__MockForWithdrawalQueue is INFTDescriptor {
    using Strings for uint256;

    bytes32 private BASE_TOKEN_URI;

    constructor(string memory _baseURI) INFTDescriptor() {
        BASE_TOKEN_URI = _toBytes32(_baseURI);
    }

    function constructTokenURI(uint256 _requestId) external view returns (string memory) {
        string memory baseURI = _toString(BASE_TOKEN_URI);
        return string(abi.encodePacked(baseURI, _requestId.toString()));
    }

    function baseTokenURI() external view returns (string memory) {
        return _toString(BASE_TOKEN_URI);
    }

    function setBaseTokenURI(string memory _baseURI) external {
        BASE_TOKEN_URI = _toBytes32(_baseURI);
    }

    function _toBytes32(string memory _str) internal pure returns (bytes32) {
        bytes memory bstr = bytes(_str);
        require(bstr.length <= 32, "NFTDescriptor: string too long");
        return bytes32(uint256(bytes32(bstr)) | bstr.length);
    }

    function _toString(bytes32 _sstr) internal pure returns (string memory) {
        uint256 len = uint256(_sstr) & 0xFF;
        string memory str = new string(32);
        /// @solidity memory-safe-assembly
        assembly {
            mstore(str, len)
            mstore(add(str, 0x20), _sstr)
        }
        return str;
    }
}
