// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";

// ============ MOCKS ============

contract MockStETH {
    uint256 public totalShares;
    uint256 public totalPooledEther;
    mapping(address => uint256) public shares;
    mapping(address => mapping(address => uint256)) public allowances;

    constructor() {
        // Start with 1:1 ratio but can be changed
        totalPooledEther = 1 ether;
        totalShares = 1 ether;
    }

    /**
     * @notice Set total pooled ether while keeping shares constant
     * @dev This simulates staking rewards accumulating, changing the share rate
     */
    function setTotalPooledEther(uint256 _amount) external {
        totalPooledEther = _amount;
        // Do NOT update totalShares - this creates a variable rate!
    }

    /**
     * @notice Simulate a rebalance that increases total pooled ether
     * @dev This is what happens when a vault rebalances - adds ETH without changing shares
     */
    function simulateRebalanceRateIncrease(uint256 _ethToAdd) external {
        totalPooledEther += _ethToAdd;
        // totalShares stays the same - rate increases!
    }

    /**
     * @notice Set a specific share rate (multiplied by 100 for precision)
     * @param _rateBP Rate in basis points where 10000 = 1.0x, 15000 = 1.5x, 20000 = 2.0x
     * @dev Example: _rateBP = 12000 means 1 share = 1.2 ETH
     */
    function setShareRateBP(uint256 _rateBP) external {
        require(_rateBP >= 10000 && _rateBP <= 20000, "Rate must be between 1.0x and 2.0x");
        // If we have 1000 shares and want rate 1.2x, we need 1200 ETH
        totalPooledEther = (totalShares * _rateBP) / 10000;
    }

    /**
     * @notice Set initial total shares (for setup only)
     */
    function setInitialShares(uint256 _shares) external {
        require(totalShares == 1 ether, "Can only set initial shares once");
        totalShares = _shares;
        totalPooledEther = _shares; // Start at 1:1, then adjust with setShareRateBP
    }

    function getSharesByPooledEth(uint256 _ethAmount) public view returns (uint256) {
        if (totalPooledEther == 0) return 0;
        return (_ethAmount * totalShares) / totalPooledEther;
    }

    function getPooledEthByShares(uint256 _sharesAmount) public view returns (uint256) {
        return (_sharesAmount * totalPooledEther) / totalShares;
    }

    function getPooledEthBySharesRoundUp(uint256 _sharesAmount) public view returns (uint256) {
        return (_sharesAmount * totalPooledEther + totalShares - 1) / totalShares;
    }

    function getTotalShares() external view returns (uint256) {
        return totalShares;
    }

    function sharesOf(address account) external view returns (uint256) {
        return shares[account];
    }

    function balanceOf(address account) external view returns (uint256) {
        return getPooledEthByShares(shares[account]);
    }

    function mintExternalShares(address _recipient, uint256 _sharesAmount) external {
        shares[_recipient] += _sharesAmount;
        totalShares += _sharesAmount;
    }

    function burnExternalShares(uint256 _sharesAmount) external {
        shares[msg.sender] -= _sharesAmount;
        totalShares -= _sharesAmount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowances[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 sharesToTransfer = getSharesByPooledEth(amount);
        require(shares[msg.sender] >= sharesToTransfer, "Insufficient shares");
        shares[msg.sender] -= sharesToTransfer;
        shares[to] += sharesToTransfer;
        return true;
    }

    function transferSharesFrom(address from, address to, uint256 _sharesAmount) external returns (uint256) {
        require(shares[from] >= _sharesAmount, "Insufficient shares");

        // Check and update allowance if not infinite
        uint256 currentAllowance = allowances[from][msg.sender];
        if (currentAllowance != type(uint256).max) {
            require(currentAllowance >= getPooledEthByShares(_sharesAmount), "Insufficient allowance");
            allowances[from][msg.sender] = currentAllowance - getPooledEthByShares(_sharesAmount);
        }

        shares[from] -= _sharesAmount;
        shares[to] += _sharesAmount;
        return _sharesAmount;
    }

    function rebalanceExternalEtherToInternal(uint256) external payable {
        totalPooledEther += msg.value;
    }
}

contract MockLidoLocator is ILidoLocator {
    address public override lido;
    address public override predepositGuarantee;
    address public override lazyOracle;
    address public override operatorGrid;
    address public override treasury;
    address public override accounting;
    address public override vaultHub;
    address public override vaultFactory;

    constructor(
        address _lido,
        address _pdg,
        address _lazyOracle,
        address _operatorGrid,
        address _treasury,
        address _accounting
    ) {
        lido = _lido;
        predepositGuarantee = _pdg;
        lazyOracle = _lazyOracle;
        operatorGrid = _operatorGrid;
        treasury = _treasury;
        accounting = _accounting;
    }

    function setOperatorGrid(address _operatorGrid) external {
        operatorGrid = _operatorGrid;
    }

    function setLazyOracle(address _lazyOracle) external {
        lazyOracle = _lazyOracle;
    }

    function accountingOracle() external pure returns (address) {
        return address(0);
    }
    function depositSecurityModule() external pure returns (address) {
        return address(0);
    }
    function elRewardsVault() external pure returns (address) {
        return address(0);
    }
    function oracleReportSanityChecker() external pure returns (address) {
        return address(0);
    }
    function burner() external pure returns (address) {
        return address(0);
    }
    function stakingRouter() external pure returns (address) {
        return address(0);
    }
    function validatorsExitBusOracle() external pure returns (address) {
        return address(0);
    }
    function withdrawalQueue() external pure returns (address) {
        return address(0);
    }
    function withdrawalVault() external pure returns (address) {
        return address(0);
    }
    function postTokenRebaseReceiver() external pure returns (address) {
        return address(0);
    }
    function oracleDaemonConfig() external pure returns (address) {
        return address(0);
    }
    function wstETH() external pure returns (address) {
        return address(0);
    }

    function coreComponents() external pure returns (address, address, address, address, address, address) {
        return (address(0), address(0), address(0), address(0), address(0), address(0));
    }

    function oracleReportComponents()
        external
        pure
        returns (address, address, address, address, address, address, address)
    {
        return (address(0), address(0), address(0), address(0), address(0), address(0), address(0));
    }

    function setVaultHub(address _vaultHub) external {
        vaultHub = _vaultHub;
    }

    function setVaultFactory(address _vaultFactory) external {
        vaultFactory = _vaultFactory;
    }
}

contract MockHashConsensus is IHashConsensus {
    uint256 private currentRefSlot = 1000;

    function getIsMember(address) external pure returns (bool) {
        return true;
    }

    function getCurrentFrame() external view returns (uint256, uint256) {
        return (currentRefSlot, currentRefSlot + 100);
    }

    function getChainConfig()
        external
        pure
        returns (uint256 slotsPerEpoch, uint256 secondsPerSlot, uint256 genesisTime)
    {
        return (32, 12, 1606824000);
    }

    function getFrameConfig() external pure returns (uint256 initialEpoch, uint256 epochsPerFrame) {
        return (0, 225);
    }

    function getInitialRefSlot() external pure returns (uint256) {
        return 0;
    }

    function incrementRefSlot() external {
        currentRefSlot += 100;
    }
}

contract MockLazyOracle {
    uint256 private reportTimestamp;

    constructor() {
        reportTimestamp = block.timestamp;
    }

    function refreshReportTimestamp() external {
        reportTimestamp = block.timestamp;
    }

    function latestReportTimestamp() external view returns (uint256) {
        return reportTimestamp;
    }

    function removeVaultQuarantine(address) external {}
}

contract MockVaultFactory {
    mapping(address => bool) private deployedVaultsMap;

    function registerVault(address vault) external {
        deployedVaultsMap[vault] = true;
    }

    function deployedVaults(address vault) external view returns (bool) {
        return deployedVaultsMap[vault];
    }
}

contract MockPredepositGuarantee {
    function pendingActivations(IStakingVault) external pure returns (uint256) {
        return 0;
    }
}

contract MockDepositContract {
    function get_deposit_root() external pure returns (bytes32) {
        return bytes32(0);
    }
}

contract MockProxy {
    address private immutable _implementation;

    constructor(address implementation_) {
        _implementation = implementation_;
    }

    fallback() external payable {
        address impl = _implementation;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }

    receive() external payable {}
}
