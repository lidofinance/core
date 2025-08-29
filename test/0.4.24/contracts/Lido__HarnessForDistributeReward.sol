// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {Lido} from "contracts/0.4.24/Lido.sol";

/**
 * @dev Only for testing purposes! Lido version with some functions exposed.
 */
contract Lido__HarnessForDistributeReward is Lido {
    bytes32 internal constant ALLOW_TOKEN_POSITION = keccak256("lido.Lido.allowToken");
    uint256 internal constant UNLIMITED_TOKEN_REBASE = uint256(-1);
    uint256 private totalPooledEther;

    function initialize(address _lidoLocator, address _eip712StETH) public payable {
        super.initialize(_lidoLocator, _eip712StETH);

        _resume();
    }

    /**
     * @dev For use in tests to make protocol operational after deployment
     */
    function resumeProtocolAndStaking() public {
        _resume();
        _resumeStaking();
    }

    function setVersion(uint256 _version) external {
        CONTRACT_VERSION_POSITION.setStorageUint256(_version);
    }

    function allowRecoverability(address /*token*/) public view returns (bool) {
        return getAllowRecoverability();
    }

    function setAllowRecoverability(bool allow) public {
        ALLOW_TOKEN_POSITION.setStorageBool(allow);
    }

    function getAllowRecoverability() public view returns (bool) {
        return ALLOW_TOKEN_POSITION.getStorageBool();
    }

    function setTotalPooledEther(uint256 _totalPooledEther) public {
        totalPooledEther = _totalPooledEther;
    }

    function _getTotalPooledEther() internal view returns (uint256) {
        return totalPooledEther;
    }

    function mintShares(address _recipient, uint256 _sharesAmount) external {
        _mintShares(_recipient, _sharesAmount);
        _emitTransferAfterMintingShares(_recipient, _sharesAmount);
    }

    function mintSteth(address _recipient) public payable {
        uint256 sharesAmount = getSharesByPooledEth(msg.value);
        _mintShares(_recipient, sharesAmount);
        _emitTransferAfterMintingShares(_recipient, sharesAmount);
        setTotalPooledEther(_getTotalPooledEther().add(msg.value));
    }

    function burnShares(address _account, uint256 _sharesAmount) external {
        _burnShares(_account, _sharesAmount);
    }
}
