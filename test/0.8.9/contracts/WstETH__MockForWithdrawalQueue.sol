// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {Counters__Mock} from "test/0.8.9/contracts/Counters__Mock.sol";
import {IStETH} from "test/0.8.9/contracts/StETH__HarnessForWithdrawalQueue.sol";

contract WstETH__MockForWithdrawalQueue {
    using Counters__Mock for Counters__Mock.Counter;

    IStETH public stETH;

    mapping(address => uint256) private _balances;

    mapping(address => mapping(address => uint256)) private _allowances;

    uint256 private _totalSupply;

    mapping(address => Counters__Mock.Counter) private _nonces;

    bool internal isSignatureValid = true;

    constructor(IStETH _stETH) {
        stETH = _stETH;
    }

    // openzeppelin/contracts/token/ERC20/IERC20.sol
    event Transfer(address indexed from, address indexed to, uint256 value);

    // openzeppelin/contracts/token/ERC20/IERC20.sol
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // WstEth interface implementations

    // WstETH::getStETHByWstETH
    function getStETHByWstETH(uint256 _wstETHAmount) external view returns (uint256) {
        return stETH.getPooledEthByShares(_wstETHAmount);
    }

    // WstETH::unwrap
    function unwrap(uint256 _wstETHAmount) external returns (uint256) {
        require(_wstETHAmount > 0, "wstETH: zero amount unwrap not allowed");
        uint256 stETHAmount = stETH.getPooledEthByShares(_wstETHAmount);
        _burn(msg.sender, _wstETHAmount);
        stETH.transfer(msg.sender, stETHAmount);
        return stETHAmount;
    }

    // openzeppelin/contracts/token/ERC20/ERC20.sol
    function approve(address spender, uint256 amount) public returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    // openzeppelin/contracts/token/ERC20/ERC20.sol
    function transferFrom(address sender, address recipient, uint256 amount) public virtual returns (bool) {
        _transfer(sender, recipient, amount);
        require(amount <= _allowances[sender][msg.sender], "ERC20: transfer amount exceeds allowance");
        _approve(sender, msg.sender, _allowances[sender][msg.sender] - amount);
        return true;
    }

    // @dev Overrides the actual permit function to allow for testing without signatures based on `isSignatureValid` flag.
    // openzeppelin/contracts/drafts/ERC20Permit.sol
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp <= deadline, "ERC20Permit: expired deadline");
        require(isSignatureValid, "ERC20Permit: invalid signature");

        _nonces[owner].increment();
        _approve(owner, spender, value);
    }

    // Exposed functions

    // openzeppelin/contracts/token/ERC20/ERC20.sol
    function mock__mint(address _recipient, uint256 _amount) public {
        _mint(_recipient, _amount);
    }

    // Workarounds

    function mock__setIsSignatureValid(bool _validSignature) external {
        isSignatureValid = _validSignature;
    }

    // Internal functions

    // openzeppelin/contracts/token/ERC20/ERC20.sol
    function _beforeTokenTransfer(address from, address to, uint256 amount) internal virtual {}

    // openzeppelin/contracts/token/ERC20/ERC20.sol
    function _mint(address account, uint256 amount) internal virtual {
        require(account != address(0), "ERC20: mint to the zero address");

        _beforeTokenTransfer(address(0), account, amount);

        _totalSupply = _totalSupply + amount;
        _balances[account] = _balances[account] + amount;
        emit Transfer(address(0), account, amount);
    }

    // openzeppelin/contracts/token/ERC20/ERC20.sol
    function _approve(address owner, address spender, uint256 amount) internal virtual {
        require(owner != address(0), "ERC20: approve from the zero address");
        require(spender != address(0), "ERC20: approve to the zero address");

        _allowances[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }

    // openzeppelin/contracts/token/ERC20/ERC20.sol
    function _transfer(address sender, address recipient, uint256 amount) internal virtual {
        require(sender != address(0), "ERC20: transfer from the zero address");
        require(recipient != address(0), "ERC20: transfer to the zero address");

        _beforeTokenTransfer(sender, recipient, amount);

        require(_balances[sender] >= amount, "ERC20: transfer amount exceeds balance");
        _balances[sender] = _balances[sender] - amount;
        _balances[recipient] = _balances[recipient] + amount;
        emit Transfer(sender, recipient, amount);
    }

    // openzeppelin/contracts/token/ERC20/ERC20.sol
    function _burn(address account, uint256 value) internal {
        require(account != address(0));
        require(value <= _balances[account]);

        _totalSupply = _totalSupply - value;
        _balances[account] = _balances[account] - value;
        emit Transfer(account, address(0), value);
    }
}
