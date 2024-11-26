// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {UnstructuredStorage} from "contracts/0.8.9/lib/UnstructuredStorage.sol";

interface IStETH {
    function approve(address _spender, uint256 _amount) external returns (bool);

    function transferFrom(address _sender, address _recipient, uint256 _amount) external returns (bool);

    function transfer(address _recipient, uint256 _amount) external returns (bool);

    function getSharesByPooledEth(uint256 _ethAmount) external view returns (uint256);

    function getPooledEthByShares(uint256 _sharesAmount) external view returns (uint256);

    function permit(
        address _owner,
        address _spender,
        uint256 _value,
        uint256 _deadline,
        uint8 _v,
        bytes32 _r,
        bytes32 _s
    ) external;
}

contract StETH__HarnessForWithdrawalQueue is IStETH {
    using UnstructuredStorage for bytes32;

    uint256 internal constant INFINITE_ALLOWANCE = ~uint256(0);

    uint256 public totalPooledEther;
    uint256 public totalShares;

    bytes32 internal constant TOTAL_SHARES_POSITION =
        0xe3b4b636e601189b5f4c6742edf2538ac12bb61ed03e6da26949d69838fa447e;

    mapping(address => uint256) private shares;

    mapping(address => mapping(address => uint256)) private allowances;

    bool internal isSignatureValid = true;

    // StETH::TransferShares
    event TransferShares(address indexed from, address indexed to, uint256 sharesValue);

    // openzeppelin-solidity/contracts/token/ERC20/IERC20.sol (0.4.24)
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // openzeppelin-solidity/contracts/token/ERC20/IERC20.sol (0.4.24)
    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor() {}

    // StETH interface implementation

    // StETH::getSharesByPooledEth
    function getSharesByPooledEth(uint256 _ethAmount) public view returns (uint256) {
        return (_ethAmount * _getTotalShares()) / totalPooledEther;
    }

    // StETH::getPooledEthByShares
    function getPooledEthByShares(uint256 _sharesAmount) public view returns (uint256) {
        return (_sharesAmount * totalPooledEther) / _getTotalShares();
    }

    // StETH::transfer
    function transfer(address _recipient, uint256 _amount) external returns (bool) {
        _transfer(msg.sender, _recipient, _amount);
        return true;
    }

    // StETH::transferFrom
    function transferFrom(address _sender, address _recipient, uint256 _amount) external returns (bool) {
        _spendAllowance(_sender, msg.sender, _amount);
        _transfer(_sender, _recipient, _amount);
        return true;
    }

    // StETH::approve
    function approve(address _spender, uint256 _amount) external returns (bool) {
        _approve(msg.sender, _spender, _amount);
        return true;
    }

    // StETHPermit interface implementation

    // @dev Overrides the actual permit function to allow testing without signatures based on `isSignatureValid` flag.
    // StETHPermit::permit
    function permit(
        address _owner,
        address _spender,
        uint256 _value,
        uint256 _deadline,
        uint8 _v,
        bytes32 _r,
        bytes32 _s
    ) external {
        require(block.timestamp <= _deadline, "DEADLINE_EXPIRED");
        require(isSignatureValid, "INVALID_SIGNATURE");

        _approve(_owner, _spender, _value);
    }

    // Exposed functions

    // StETH::_mintShares
    function harness__mintShares(address _to, uint256 _sharesAmount) public returns (uint256 newTotalShares) {
        require(_to != address(0), "MINT_TO_ZERO_ADDR");

        newTotalShares = _getTotalShares() + _sharesAmount;
        TOTAL_SHARES_POSITION.setStorageUint256(newTotalShares);

        shares[_to] = shares[_to] + _sharesAmount;
    }

    // Mock functions

    function mock__setTotalPooledEther(uint256 _totalPooledEther) external {
        totalPooledEther = _totalPooledEther;
    }

    function mock__setIsSignatureValid(bool _validSignature) external {
        isSignatureValid = _validSignature;
    }

    // Internal functions

    // StETH::_approve
    function _approve(address _owner, address _spender, uint256 _amount) internal {
        require(_owner != address(0), "APPROVE_FROM_ZERO_ADDR");
        require(_spender != address(0), "APPROVE_TO_ZERO_ADDR");

        allowances[_owner][_spender] = _amount;
        emit Approval(_owner, _spender, _amount);
    }

    // StETH::_getTotalShares
    function _getTotalShares() internal view returns (uint256) {
        return TOTAL_SHARES_POSITION.getStorageUint256();
    }

    // StETH::_transfer
    function _transfer(address _sender, address _recipient, uint256 _amount) internal {
        uint256 _sharesToTransfer = getSharesByPooledEth(_amount);
        _transferShares(_sender, _recipient, _sharesToTransfer);
        _emitTransferEvents(_sender, _recipient, _amount, _sharesToTransfer);
    }

    // StETH::_transferShares
    function _transferShares(address _sender, address _recipient, uint256 _sharesAmount) internal {
        require(_sender != address(0), "TRANSFER_FROM_ZERO_ADDR");
        require(_recipient != address(0), "TRANSFER_TO_ZERO_ADDR");
        require(_recipient != address(this), "TRANSFER_TO_STETH_CONTRACT");
        // _whenNotStopped();

        uint256 currentSenderShares = shares[_sender];
        require(_sharesAmount <= currentSenderShares, "BALANCE_EXCEEDED");

        shares[_sender] = currentSenderShares - _sharesAmount;
        shares[_recipient] = shares[_recipient] + _sharesAmount;
    }

    // StETH::_spendAllowance
    function _spendAllowance(address _owner, address _spender, uint256 _amount) internal {
        uint256 currentAllowance = allowances[_owner][_spender];
        if (currentAllowance != INFINITE_ALLOWANCE) {
            require(currentAllowance >= _amount, "ALLOWANCE_EXCEEDED");
            _approve(_owner, _spender, currentAllowance - _amount);
        }
    }

    // StETH::_emitTransferEvents
    function _emitTransferEvents(address _from, address _to, uint _tokenAmount, uint256 _sharesAmount) internal {
        emit Transfer(_from, _to, _tokenAmount);
        emit TransferShares(_from, _to, _sharesAmount);
    }
}
