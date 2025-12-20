// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {OperatorGrid} from "contracts/0.8.25/vaults/OperatorGrid.sol";
import {SafeCast} from "@openzeppelin/contracts-v5.2/utils/math/SafeCast.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Proxy.sol";
import {IPinnedBeaconProxy} from "contracts/0.8.25/vaults/interfaces/IPinnedBeaconProxy.sol";
import {RefSlotCache, DoubleRefSlotCache, DOUBLE_CACHE_LENGTH} from "contracts/0.8.25/vaults/lib/RefSlotCache.sol";
import {MerkleProof} from "@openzeppelin/contracts-v5.2/utils/cryptography/MerkleProof.sol";
import {LazyOracle} from "contracts/0.8.25/vaults/LazyOracle.sol";
import {ILazyOracle} from "contracts/common/interfaces/ILazyOracle.sol";
import {
    AccessControlEnumerableUpgradeable
} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {IPredepositGuarantee} from "contracts/0.8.25/vaults/interfaces/IPredepositGuarantee.sol";

contract ConsensusContractMock is IHashConsensus {
    uint256 public refSlot;
    uint256 public reportProcessingDeadlineSlot;

    constructor(uint256 _refSlot, uint256 _reportProcessingDeadlineSlot) {
        refSlot = _refSlot;
        reportProcessingDeadlineSlot = _reportProcessingDeadlineSlot;
    }

    function getCurrentFrame() external view returns (uint256, uint256) {
        return (refSlot, reportProcessingDeadlineSlot);
    }

    function setCurrentFrame(uint256 newRefSlot) external {
        refSlot = newRefSlot;
    }

    function getIsMember(address) external view returns (bool) {
        return true;
    }

    function getChainConfig()
        external
        view
        returns (uint256 slotsPerEpoch, uint256 secondsPerSlot, uint256 genesisTime)
    {
        return (0, 0, 0);
    }

    function getFrameConfig() external view returns (uint256 initialEpoch, uint256 epochsPerFrame) {
        return (0, 0);
    }

    function getInitialRefSlot() external view returns (uint256) {
        return 0;
    }
}

contract LidoLocatorMock {
    address public lido_;
    address public predepositGuarantee_;
    address public accounting_;
    address public treasury_;
    address public operatorGrid_;
    address public lazyOracle_;
    address public vaultHub_;
    address public consensusContract_;
    address public vaultFactory_;

    constructor(
        address _lido,
        address _predepositGuarantee,
        address _accounting,
        address _treasury,
        address _operatorGrid,
        address _lazyOracle,
        address _vaultHub,
        address _consensusContract,
        address _vaultFactory
    ) {
        lido_ = _lido;
        predepositGuarantee_ = _predepositGuarantee;
        accounting_ = _accounting;
        treasury_ = _treasury;
        operatorGrid_ = _operatorGrid;
        lazyOracle_ = _lazyOracle;
        vaultHub_ = _vaultHub;
        consensusContract_ = _consensusContract;
        vaultFactory_ = _vaultFactory;
    }

    function lido() external view returns (address) {
        return lido_;
    }
    function operatorGrid() external view returns (address) {
        return operatorGrid_;
    }

    function predepositGuarantee() external view returns (address) {
        return predepositGuarantee_;
    }

    function accountingOracle() external view returns (address) {
        return accounting_;
    }

    function treasury() external view returns (address) {
        return treasury_;
    }

    function lazyOracle() external view returns (address) {
        return lazyOracle_;
    }

    function vaultHub() external view returns (address) {
        return vaultHub_;
    }

    function consensusContract() external view returns (address) {
        return consensusContract_;
    }

    function vaultFactory() external view returns (address) {
        return vaultFactory_;
    }
}

contract LidoMock {
    uint256 public totalShares;
    uint256 public externalShares;
    uint256 public totalPooledEther;
    uint256 public bufferedEther;

    constructor(uint256 _totalShares, uint256 _totalPooledEther, uint256 _externalShares) {
        if (_totalShares == 0) revert("totalShares cannot be 0");
        if (_totalPooledEther == 0) revert("totalPooledEther cannot be 0");

        totalShares = _totalShares;
        totalPooledEther = _totalPooledEther;
        externalShares = _externalShares;
    }

    function getSharesByPooledEth(uint256 _ethAmount) public view returns (uint256) {
        return (_ethAmount * totalShares) / totalPooledEther;
    }

    function getPooledEthByShares(uint256 _sharesAmount) public view returns (uint256) {
        return (_sharesAmount * totalPooledEther) / totalShares;
    }

    function getTotalShares() external view returns (uint256) {
        return totalShares;
    }

    function getExternalShares() external view returns (uint256) {
        return externalShares;
    }

    function mintExternalShares(address, uint256 _amountOfShares) external {
        totalShares += _amountOfShares;
        externalShares += _amountOfShares;
    }

    function burnExternalShares(uint256 _amountOfShares) external {
        totalShares -= _amountOfShares;
        externalShares -= _amountOfShares;
    }

    function stake() external payable {
        uint256 sharesAmount = getSharesByPooledEth(msg.value);
        totalShares += sharesAmount;
        totalPooledEther += msg.value;
    }

    function receiveRewards(uint256 _rewards) external {
        totalPooledEther += _rewards;
    }

    function getExternalEther() external view returns (uint256) {
        return _getExternalEther(totalPooledEther);
    }

    function _getExternalEther(uint256 _internalEther) internal view returns (uint256) {
        return (externalShares * _internalEther) / (totalShares - externalShares);
    }

    function rebalanceExternalEtherToInternal() external payable {
        uint256 shares = getSharesByPooledEth(msg.value);
        if (shares > externalShares) revert("not enough external shares");
        externalShares -= shares;
        totalPooledEther += msg.value;
    }

    function getPooledEthBySharesRoundUp(uint256 _sharesAmount) external view returns (uint256) {
        uint256 etherAmount = (_sharesAmount * totalPooledEther) / totalShares;
        if (_sharesAmount * totalPooledEther != etherAmount * totalShares) {
            ++etherAmount;
        }
        return etherAmount;
    }

    function transferSharesFrom(address, address, uint256) external pure returns (uint256) {
        return 0;
    }

    function getTotalPooledEther() external view returns (uint256) {
        return totalPooledEther;
    }

    function mintShares(address, uint256 _sharesAmount) external {
        totalShares += _sharesAmount;
    }

    function burnShares(uint256 _amountOfShares) external {
        totalShares -= _amountOfShares;
    }
}

contract VaultFactoryMock {
    function deployedVaults(address _vault) external view returns (bool) {
        return true;
    }
}

contract PredepositGuaranteeMock {
    function pendingPredeposits(address _vault) external view returns (uint256) {
        return 0;
    }

    function pendingActivations(address _vault) external view returns (uint256) {
        return 0;
    }
}

contract PinnedBeaconProxyMock is ERC1967Proxy, IPinnedBeaconProxy {
    constructor(address _impl, bytes memory _data) ERC1967Proxy(_impl, _data) {}

    function isOssified() external view returns (bool) {
        return false;
    }
}
