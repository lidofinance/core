// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {Lido} from "contracts/0.4.24/Lido.sol";

/**
 * @dev Only for testing purposes! Lido version with some functions exposed.
 */
contract Lido__HarnessForDistributeReward is Lido {
    bytes32 internal constant ALLOW_TOKEN_POSITION = keccak256("lido.Lido.allowToken");
    uint256 internal constant UNLIMITED_TOKEN_REBASE = uint256(- 1);
    uint256 private totalPooledEther;

    function initialize(
        address _lidoLocator,
        address _eip712StETH
    )
        public
        payable
    {
        super.initialize(
            _lidoLocator,
            _eip712StETH
        );

        _resume();
        // _bootstrapInitialHolder
        uint256 balance = address(this).balance;
        assert(balance != 0);

        // address(0xdead) is a holder for initial shares
        setTotalPooledEther(balance);
        _mintInitialShares(balance);
        setAllowRecoverability(true);
    }

    /**
     * @dev For use in tests to make protocol operational after deployment
     */
    function resumeProtocolAndStaking() public {
        _resume();
        _resumeStaking();
    }

    /**
     * @dev Only for testing recovery vault
     */
    function makeUnaccountedEther() public payable {}

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

    function resetEip712StETH() external {
        EIP712_STETH_POSITION.setStorageAddress(0);
    }

    function setTotalPooledEther(uint256 _totalPooledEther) public {
        totalPooledEther = _totalPooledEther;
    }

    function _getTotalPooledEther() internal view returns (uint256) {
        return totalPooledEther;
    }

    function mintShares(address _to, uint256 _sharesAmount) public returns (uint256 newTotalShares) {
        newTotalShares = _mintShares(_to, _sharesAmount);
        _emitTransferAfterMintingShares(_to, _sharesAmount);
    }

    function mintSteth(address _to) public payable {
        uint256 sharesAmount = getSharesByPooledEth(msg.value);
        mintShares(_to, sharesAmount);
        setTotalPooledEther(_getTotalPooledEther().add(msg.value));
    }

    function burnShares(address _account, uint256 _sharesAmount) public returns (uint256 newTotalShares) {
        return _burnShares(_account, _sharesAmount);
    }

}
