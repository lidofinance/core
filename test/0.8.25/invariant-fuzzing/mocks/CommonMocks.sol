// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IHashConsensus} from "contracts/0.8.25/vaults/interfaces/IHashConsensus.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {OperatorGrid} from "contracts/0.8.25/vaults/OperatorGrid.sol";
import {SafeCast} from "@openzeppelin/contracts-v5.2/utils/math/SafeCast.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {ILido} from "contracts/0.8.25/interfaces/ILido.sol";

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

    constructor(
        address _lido,
        address _predepositGuarantee,
        address _accounting,
        address _treasury,
        address _operatorGrid,
        address _lazyOracle,
        address _vaultHub,
        address _consensusContract
    ) {
        lido_ = _lido;
        predepositGuarantee_ = _predepositGuarantee;
        accounting_ = _accounting;
        treasury_ = _treasury;
        operatorGrid_ = _operatorGrid;
        lazyOracle_ = _lazyOracle;
        vaultHub_ = _vaultHub;
        consensusContract_ = _consensusContract;
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

    function accounting() external view returns (address) {
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
}

contract LazyOracleMock {
    struct Storage {
        /// @notice root of the vaults data tree
        bytes32 vaultsDataTreeRoot;
        /// @notice CID of the vaults data tree
        string vaultsDataReportCid;
        /// @notice timestamp of the vaults data
        uint64 vaultsDataTimestamp;
        /// @notice total value increase quarantine period
        uint64 quarantinePeriod;
        /// @notice max reward ratio for refSlot-observed total value, basis points
        uint16 maxRewardRatioBP;
        /// @notice deposit quarantines for each vault
        mapping(address vault => Quarantine) vaultQuarantines;
    }

    struct Quarantine {
        uint128 pendingTotalValueIncrease;
        uint64 startTimestamp;
    }

    struct VaultInfo {
        address vault;
        uint96 vaultIndex;
        uint256 balance;
        bytes32 withdrawalCredentials;
        uint256 liabilityShares;
        uint256 mintableStETH;
        uint96 shareLimit;
        uint16 reserveRatioBP;
        uint16 forcedRebalanceThresholdBP;
        uint16 infraFeeBP;
        uint16 liquidityFeeBP;
        uint16 reservationFeeBP;
        bool pendingDisconnect;
    }

    struct QuarantineInfo {
        bool isActive;
        uint256 pendingTotalValueIncrease;
        uint256 startTimestamp;
        uint256 endTimestamp;
    }

    // keccak256(abi.encode(uint256(keccak256("LazyOracle")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LAZY_ORACLE_STORAGE_LOCATION =
        0xe5459f2b48ec5df2407caac4ec464a5cb0f7f31a1f22f649728a9579b25c1d00;

    bytes32 public constant UPDATE_SANITY_PARAMS_ROLE = keccak256("UPDATE_SANITY_PARAMS_ROLE");

    // total basis points = 100%
    uint256 internal constant TOTAL_BP = 100_00;

    ILidoLocator public immutable LIDO_LOCATOR;
    IHashConsensus public immutable HASH_CONSENSUS;

    /// @dev basis points base
    uint256 private constant TOTAL_BASIS_POINTS = 100_00;

    constructor(address _lidoLocator, address _hashConsensus, uint64 _quarantinePeriod, uint16 _maxRewardRatioBP) {
        LIDO_LOCATOR = ILidoLocator(payable(_lidoLocator));
        HASH_CONSENSUS = IHashConsensus(_hashConsensus);
        _updateSanityParams(_quarantinePeriod, _maxRewardRatioBP);
    }

    /// @notice returns the latest report timestamp
    function latestReportTimestamp() external view returns (uint64) {
        return _storage().vaultsDataTimestamp;
    }

    /// @notice returns the quarantine period
    function quarantinePeriod() external view returns (uint64) {
        return _storage().quarantinePeriod;
    }

    /// @notice returns the max reward ratio for refSlot total value, basis points
    function maxRewardRatioBP() external view returns (uint16) {
        return _storage().maxRewardRatioBP;
    }

    /// @notice returns the quarantine info for the vault
    /// @param _vault the address of the vault
    // @dev returns zeroed structure if there is no active quarantine
    function vaultQuarantine(address _vault) external view returns (QuarantineInfo memory) {
        Quarantine storage q = _storage().vaultQuarantines[_vault];
        if (q.pendingTotalValueIncrease == 0) {
            return QuarantineInfo(false, 0, 0, 0);
        }

        return
            QuarantineInfo(
                true,
                q.pendingTotalValueIncrease,
                q.startTimestamp,
                q.startTimestamp + _storage().quarantinePeriod
            );
    }

    /// @notice update the sanity parameters
    /// @param _quarantinePeriod the quarantine period
    /// @param _maxRewardRatioBP the max EL CL rewards
    function updateSanityParams(uint64 _quarantinePeriod, uint16 _maxRewardRatioBP) external {
        _updateSanityParams(_quarantinePeriod, _maxRewardRatioBP);
    }

    function setVaultDataTimestamp(uint64 _vaultsDataTimestamp) external {
        Storage storage $ = _storage();
        $.vaultsDataTimestamp = uint64(_vaultsDataTimestamp);
    }

    /// @notice Permissionless update of the vault data
    /// @param _vault the address of the vault
    /// @param _totalValue the total value of the vault
    /// @param _cumulativeLidoFees the cumulative Lido fees accrued on the vault (nominated in ether)
    /// @param _liabilityShares the liabilityShares of the vault
    function updateVaultData(
        address _vault,
        uint256 _totalValue,
        uint256 _cumulativeLidoFees,
        uint256 _liabilityShares,
        uint64 _vaultsDataTimestamp
    ) external {
        // bytes32 leaf = keccak256(
        //     bytes.concat(keccak256(abi.encode(_vault, _totalValue, _cumulativeLidoFees, _liabilityShares)))
        // );
        //if (!MerkleProof.verify(_proof, _storage().vaultsDataTreeRoot, leaf)) revert InvalidProof();

        int256 inOutDelta;
        (_totalValue, inOutDelta) = _handleSanityChecks(_vault, _totalValue);

        _vaultHub().applyVaultReport(
            _vault,
            _vaultsDataTimestamp,
            _totalValue,
            inOutDelta,
            _cumulativeLidoFees,
            _liabilityShares
        );
    }

    /// @notice handle sanity checks for the vault lazy report data
    /// @param _vault the address of the vault
    /// @param _totalValue the total value of the vault in refSlot
    /// @return totalValue the smoothed total value of the vault after sanity checks
    /// @return inOutDelta the inOutDelta in the refSlot
    function _handleSanityChecks(
        address _vault,
        uint256 _totalValue
    ) public returns (uint256 totalValue, int256 inOutDelta) {
        VaultHub vaultHub = _vaultHub();
        VaultHub.VaultRecord memory record = vaultHub.vaultRecord(_vault);

        // 1. Calculate inOutDelta in the refSlot
        int256 curInOutDelta = record.inOutDelta.value;
        (uint256 refSlot, ) = HASH_CONSENSUS.getCurrentFrame();
        if (record.inOutDelta.refSlot == refSlot) {
            inOutDelta = record.inOutDelta.refSlotValue;
        } else {
            inOutDelta = curInOutDelta;
        }

        // 2. Sanity check for total value increase
        totalValue = _processTotalValue(_vault, _totalValue, inOutDelta, record);

        // 3. Sanity check for dynamic total value underflow
        if (int256(totalValue) + curInOutDelta - inOutDelta < 0) revert UnderflowInTotalValueCalculation();

        return (totalValue, inOutDelta);
    }

    function _processTotalValue(
        address _vault,
        uint256 _totalValue,
        int256 _inOutDelta,
        VaultHub.VaultRecord memory record
    ) internal returns (uint256) {
        Storage storage $ = _storage();

        uint256 refSlotTotalValue = uint256(
            int256(uint256(record.report.totalValue)) + _inOutDelta - record.report.inOutDelta
        );
        // some percentage of funds hasn't passed through the vault's balance is allowed for the EL and CL rewards handling
        uint256 limit = (refSlotTotalValue * (TOTAL_BP + $.maxRewardRatioBP)) / TOTAL_BP;

        if (_totalValue > limit) {
            Quarantine storage q = $.vaultQuarantines[_vault];
            uint64 reportTs = $.vaultsDataTimestamp;
            uint128 quarDelta = q.pendingTotalValueIncrease;
            uint128 delta = SafeCast.toUint128(_totalValue - refSlotTotalValue);

            if (quarDelta == 0) {
                // first overlimit report
                _totalValue = refSlotTotalValue;
                q.pendingTotalValueIncrease = delta;
                q.startTimestamp = reportTs;
                emit QuarantinedDeposit(_vault, delta);
            } else if (reportTs - q.startTimestamp < $.quarantinePeriod) {
                // quarantine not expired
                _totalValue = refSlotTotalValue;
            } else if (delta <= quarDelta + (refSlotTotalValue * $.maxRewardRatioBP) / TOTAL_BP) {
                // quarantine expired
                q.pendingTotalValueIncrease = 0;
                emit QuarantineExpired(_vault, delta);
            } else {
                // start new quarantine
                _totalValue = refSlotTotalValue + quarDelta;
                q.pendingTotalValueIncrease = delta - quarDelta;
                q.startTimestamp = reportTs;
                emit QuarantinedDeposit(_vault, delta - quarDelta);
            }
        }

        return _totalValue;
    }

    function _updateSanityParams(uint64 _quarantinePeriod, uint16 _maxRewardRatioBP) internal {
        Storage storage $ = _storage();
        $.quarantinePeriod = _quarantinePeriod;
        $.maxRewardRatioBP = _maxRewardRatioBP;
        emit SanityParamsUpdated(_quarantinePeriod, _maxRewardRatioBP);
    }

    function _mintableStETH(address _vault) internal view returns (uint256) {
        VaultHub vaultHub = _vaultHub();
        uint256 maxLockableValue = vaultHub.maxLockableValue(_vault);
        uint256 reserveRatioBP = vaultHub.vaultConnection(_vault).reserveRatioBP;
        uint256 mintableStETHByRR = (maxLockableValue * (TOTAL_BASIS_POINTS - reserveRatioBP)) / TOTAL_BASIS_POINTS;

        uint256 effectiveShareLimit = _operatorGrid().effectiveShareLimit(_vault);
        uint256 mintableStEthByShareLimit = ILido(LIDO_LOCATOR.lido()).getPooledEthBySharesRoundUp(effectiveShareLimit);

        return Math256.min(mintableStETHByRR, mintableStEthByShareLimit);
    }

    function _storage() internal pure returns (Storage storage $) {
        assembly {
            $.slot := LAZY_ORACLE_STORAGE_LOCATION
        }
    }

    function _vaultHub() internal view returns (VaultHub) {
        return VaultHub(payable(LIDO_LOCATOR.vaultHub()));
    }

    function _operatorGrid() internal view returns (OperatorGrid) {
        return OperatorGrid(LIDO_LOCATOR.operatorGrid());
    }

    event VaultsReportDataUpdated(uint256 indexed timestamp, bytes32 indexed root, string cid);
    event QuarantinedDeposit(address indexed vault, uint128 delta);
    event SanityParamsUpdated(uint64 quarantinePeriod, uint16 maxRewardRatioBP);
    event QuarantineExpired(address indexed vault, uint128 delta);
    error AdminCannotBeZero();
    error NotAuthorized();
    error InvalidProof();
    error UnderflowInTotalValueCalculation();
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
