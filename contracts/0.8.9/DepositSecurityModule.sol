// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {ECDSA} from "../common/lib/ECDSA.sol";

interface ILido {
    function deposit(
        uint256 _maxDepositsCount,
        uint256 _stakingModuleId,
        bytes calldata _depositCalldata
    ) external;
    function canDeposit() external view returns (bool);
}

interface IDepositContract {
    function get_deposit_root() external view returns (bytes32 rootHash);
}

interface IStakingRouter {
    function pauseStakingModule(uint256 _stakingModuleId) external;
    function resumeStakingModule(uint256 _stakingModuleId) external;
    function getStakingModuleIsDepositsPaused(uint256 _stakingModuleId) external view returns (bool);
    function getStakingModuleIsActive(uint256 _stakingModuleId) external view returns (bool);
    function getStakingModuleNonce(uint256 _stakingModuleId) external view returns (uint256);
    function getStakingModuleLastDepositBlock(uint256 _stakingModuleId) external view returns (uint256);
    function hasStakingModule(uint256 _stakingModuleId) external view returns (bool);
}



contract DepositSecurityModule {
    /**
     * Short ECDSA signature as defined in https://eips.ethereum.org/EIPS/eip-2098.
     */
    struct Signature {
        bytes32 r;
        bytes32 vs;
    }

    event OwnerChanged(address newValue);
    event PauseIntentValidityPeriodBlocksChanged(uint256 newValue);
    event MaxDepositsChanged(uint256 newValue);
    event MinDepositBlockDistanceChanged(uint256 newValue);
    event GuardianQuorumChanged(uint256 newValue);
    event GuardianAdded(address guardian);
    event GuardianRemoved(address guardian);
    event DepositsPaused(address indexed guardian, uint24 indexed stakingModuleId);
    event DepositsUnpaused(uint24 indexed stakingModuleId);

    error ZeroAddress(string field);
    error DuplicateAddress(address addr);
    error NotAnOwner(address caller);
    error InvalidSignature();
    error SignaturesNotSorted();
    error DepositNoQuorum();
    error DepositRootChanged();
    error DepositInactiveModule();
    error DepositTooFrequent();
    error DepositUnexpectedBlockHash();
    error DepositNonceChanged();
    error PauseIntentExpired();
    error NotAGuardian(address addr);
    error ZeroParameter(string parameter);

    bytes32 public immutable ATTEST_MESSAGE_PREFIX;
    bytes32 public immutable PAUSE_MESSAGE_PREFIX;

    ILido public immutable LIDO;
    IStakingRouter public immutable STAKING_ROUTER;
    IDepositContract public immutable DEPOSIT_CONTRACT;

    /**
     * NB: both `maxDepositsPerBlock` and `minDepositBlockDistance` values
     * must be harmonized with `OracleReportSanityChecker.churnValidatorsPerDayLimit`
     * (see docs for the `OracleReportSanityChecker.setChurnValidatorsPerDayLimit` function)
     */
    uint256 internal maxDepositsPerBlock;
    uint256 internal minDepositBlockDistance;
    uint256 internal pauseIntentValidityPeriodBlocks;

    address internal owner;

    uint256 internal quorum;
    address[] internal guardians;
    mapping(address => uint256) internal guardianIndicesOneBased; // 1-based

    constructor(
        address _lido,
        address _depositContract,
        address _stakingRouter,
        uint256 _maxDepositsPerBlock,
        uint256 _minDepositBlockDistance,
        uint256 _pauseIntentValidityPeriodBlocks
    ) {
        if (_lido == address(0)) revert ZeroAddress("_lido");
        if (_depositContract == address(0)) revert ZeroAddress ("_depositContract");
        if (_stakingRouter == address(0)) revert ZeroAddress ("_stakingRouter");

        LIDO = ILido(_lido);
        STAKING_ROUTER = IStakingRouter(_stakingRouter);
        DEPOSIT_CONTRACT = IDepositContract(_depositContract);

        ATTEST_MESSAGE_PREFIX = keccak256(
            abi.encodePacked(
                // keccak256("lido.DepositSecurityModule.ATTEST_MESSAGE")
                bytes32(0x1085395a994e25b1b3d0ea7937b7395495fb405b31c7d22dbc3976a6bd01f2bf),
                block.chainid,
                address(this)
            )
        );

        PAUSE_MESSAGE_PREFIX = keccak256(
            abi.encodePacked(
                // keccak256("lido.DepositSecurityModule.PAUSE_MESSAGE")
                bytes32(0x9c4c40205558f12027f21204d6218b8006985b7a6359bcab15404bcc3e3fa122),
                block.chainid,
                address(this)
            )
        );

        _setOwner(msg.sender);
        _setMaxDeposits(_maxDepositsPerBlock);
        _setMinDepositBlockDistance(_minDepositBlockDistance);
        _setPauseIntentValidityPeriodBlocks(_pauseIntentValidityPeriodBlocks);
    }

    /**
     * Returns the owner address.
     */
    function getOwner() external view returns (address) {
        return owner;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAnOwner(msg.sender);
        _;
    }

    /**
     * Sets new owner. Only callable by the current owner.
     */
    function setOwner(address newValue) external onlyOwner {
        _setOwner(newValue);
    }

    function _setOwner(address _newOwner) internal {
        if (_newOwner == address(0)) revert ZeroAddress("_newOwner");
        owner = _newOwner;
        emit OwnerChanged(_newOwner);
    }

    /**
     * Returns current `pauseIntentValidityPeriodBlocks` contract parameter (see `pauseDeposits`).
     */
    function getPauseIntentValidityPeriodBlocks() external view returns (uint256) {
        return pauseIntentValidityPeriodBlocks;
    }

    /**
     * Sets `pauseIntentValidityPeriodBlocks`. Only callable by the owner.
     */
    function setPauseIntentValidityPeriodBlocks(uint256 newValue) external onlyOwner {
        _setPauseIntentValidityPeriodBlocks(newValue);
    }

    function _setPauseIntentValidityPeriodBlocks(uint256 newValue) internal {
        if (newValue == 0) revert ZeroParameter("pauseIntentValidityPeriodBlocks");
        pauseIntentValidityPeriodBlocks = newValue;
        emit PauseIntentValidityPeriodBlocksChanged(newValue);
    }

    /**
     * Returns `maxDepositsPerBlock` (see `depositBufferedEther`).
     */
    function getMaxDeposits() external view returns (uint256) {
        return maxDepositsPerBlock;
    }

    /**
     * Sets `maxDepositsPerBlock`. Only callable by the owner.
     *
     * NB: the value must be harmonized with `OracleReportSanityChecker.churnValidatorsPerDayLimit`
     * (see docs for the `OracleReportSanityChecker.setChurnValidatorsPerDayLimit` function)
     */
    function setMaxDeposits(uint256 newValue) external onlyOwner {
        _setMaxDeposits(newValue);
    }

    function _setMaxDeposits(uint256 newValue) internal {
        maxDepositsPerBlock = newValue;
        emit MaxDepositsChanged(newValue);
    }

    /**
     * Returns `minDepositBlockDistance`  (see `depositBufferedEther`).
     */
    function getMinDepositBlockDistance() external view returns (uint256) {
        return minDepositBlockDistance;
    }

    /**
     * Sets `minDepositBlockDistance`. Only callable by the owner.
     *
     * NB: the value must be harmonized with `OracleReportSanityChecker.churnValidatorsPerDayLimit`
     * (see docs for the `OracleReportSanityChecker.setChurnValidatorsPerDayLimit` function)
     */
    function setMinDepositBlockDistance(uint256 newValue) external onlyOwner {
        _setMinDepositBlockDistance(newValue);
    }

    function _setMinDepositBlockDistance(uint256 newValue) internal {
        if (newValue == 0) revert ZeroParameter("minDepositBlockDistance");
        if (newValue != minDepositBlockDistance) {
            minDepositBlockDistance = newValue;
            emit MinDepositBlockDistanceChanged(newValue);
        }
    }

    /**
     * Returns number of valid guardian signatures required to vet (depositRoot, nonce) pair.
     */
    function getGuardianQuorum() external view returns (uint256) {
        return quorum;
    }

    function setGuardianQuorum(uint256 newValue) external onlyOwner {
        _setGuardianQuorum(newValue);
    }

    function _setGuardianQuorum(uint256 newValue) internal {
        // we're intentionally allowing setting quorum value higher than the number of guardians
        if (quorum != newValue) {
            quorum = newValue;
            emit GuardianQuorumChanged(newValue);
        }
    }

    /**
     * Returns guardian committee member list.
     */
    function getGuardians() external view returns (address[] memory) {
        return guardians;
    }

    /**
     * Checks whether the given address is a guardian.
     */
    function isGuardian(address addr) external view returns (bool) {
        return _isGuardian(addr);
    }

    function _isGuardian(address addr) internal view returns (bool) {
        return guardianIndicesOneBased[addr] > 0;
    }

    /**
     * Returns index of the guardian, or -1 if the address is not a guardian.
     */
    function getGuardianIndex(address addr) external view returns (int256) {
        return _getGuardianIndex(addr);
    }

    function _getGuardianIndex(address addr) internal view returns (int256) {
        return int256(guardianIndicesOneBased[addr]) - 1;
    }

    /**
     * Adds a guardian address and sets a new quorum value.
     * Reverts if the address is already a guardian.
     *
     * Only callable by the owner.
     */
    function addGuardian(address addr, uint256 newQuorum) external onlyOwner {
        _addGuardian(addr);
        _setGuardianQuorum(newQuorum);
    }

    /**
     * Adds a set of guardian addresses and sets a new quorum value.
     * Reverts any of them is already a guardian.
     *
     * Only callable by the owner.
     */
    function addGuardians(address[] memory addresses, uint256 newQuorum) external onlyOwner {
        for (uint256 i = 0; i < addresses.length; ++i) {
            _addGuardian(addresses[i]);
        }
        _setGuardianQuorum(newQuorum);
    }

    function _addGuardian(address _newGuardian) internal {
        if (_newGuardian == address(0)) revert ZeroAddress("_newGuardian");
        if (_isGuardian(_newGuardian)) revert DuplicateAddress(_newGuardian);
        guardians.push(_newGuardian);
        guardianIndicesOneBased[_newGuardian] = guardians.length;
        emit GuardianAdded(_newGuardian);
    }

    /**
     * Removes a guardian with the given address and sets a new quorum value.
     *
     * Only callable by the owner.
     */
    function removeGuardian(address addr, uint256 newQuorum) external onlyOwner {
        uint256 indexOneBased = guardianIndicesOneBased[addr];
        if (indexOneBased == 0) revert NotAGuardian(addr);

        uint256 totalGuardians = guardians.length;
        assert(indexOneBased <= totalGuardians);

        if (indexOneBased != totalGuardians) {
            address addrToMove = guardians[totalGuardians - 1];
            guardians[indexOneBased - 1] = addrToMove;
            guardianIndicesOneBased[addrToMove] = indexOneBased;
        }

        guardianIndicesOneBased[addr] = 0;
        guardians.pop();

        _setGuardianQuorum(newQuorum);

        emit GuardianRemoved(addr);
    }

    /**
     * Pauses deposits for staking module given that both conditions are satisfied (reverts otherwise):
     *
     *   1. The function is called by the guardian with index guardianIndex OR sig
     *      is a valid signature by the guardian with index guardianIndex of the data
     *      defined below.
     *
     *   2. block.number - blockNumber <= pauseIntentValidityPeriodBlocks
     *
     * The signature, if present, must be produced for keccak256 hash of the following
     * message (each component taking 32 bytes):
     *
     * | PAUSE_MESSAGE_PREFIX | blockNumber | stakingModuleId |
     */
    function pauseDeposits(
        uint256 blockNumber,
        uint256 stakingModuleId,
        Signature memory sig
    ) external {
        // In case of an emergency function `pauseDeposits` is supposed to be called
        // by all guardians. Thus only the first call will do the actual change. But
        // the other calls would be OK operations from the point of view of protocol’s logic.
        // Thus we prefer not to use “error” semantics which is implied by `require`.

        /// @dev pause only active modules (not already paused, nor full stopped)
        if (!STAKING_ROUTER.getStakingModuleIsActive(stakingModuleId)) {
            return;
        }

        address guardianAddr = msg.sender;
        int256 guardianIndex = _getGuardianIndex(msg.sender);

        if (guardianIndex == -1) {
            bytes32 msgHash = keccak256(abi.encodePacked(PAUSE_MESSAGE_PREFIX, blockNumber, stakingModuleId));
            guardianAddr = ECDSA.recover(msgHash, sig.r, sig.vs);
            guardianIndex = _getGuardianIndex(guardianAddr);
            if (guardianIndex == -1) revert InvalidSignature();
        }

        if (block.number - blockNumber >  pauseIntentValidityPeriodBlocks) revert PauseIntentExpired();

        STAKING_ROUTER.pauseStakingModule(stakingModuleId);
        emit DepositsPaused(guardianAddr, uint24(stakingModuleId));
    }

    /**
     * Unpauses deposits for staking module
     *
     * Only callable by the owner.
     */
    function unpauseDeposits(uint256 stakingModuleId) external onlyOwner {
         /// @dev unpause only paused modules (skip stopped)
        if (STAKING_ROUTER.getStakingModuleIsDepositsPaused(stakingModuleId)) {
            STAKING_ROUTER.resumeStakingModule(stakingModuleId);
            emit DepositsUnpaused(uint24(stakingModuleId));
        }
    }

    /**
     * Returns whether LIDO.deposit() can be called, given that the caller will provide
     * guardian attestations of non-stale deposit root and `nonce`, and the number of
     * such attestations will be enough to reach quorum.
     */
    function canDeposit(uint256 stakingModuleId) external view returns (bool) {
        if (!STAKING_ROUTER.hasStakingModule(stakingModuleId)) return false;

        bool isModuleActive = STAKING_ROUTER.getStakingModuleIsActive(stakingModuleId);
        uint256 lastDepositBlock = STAKING_ROUTER.getStakingModuleLastDepositBlock(stakingModuleId);
        bool isLidoCanDeposit = LIDO.canDeposit();
        return (
            isModuleActive
            && quorum > 0
            && block.number - lastDepositBlock >= minDepositBlockDistance
            && isLidoCanDeposit
        );
    }

    /**
     * Calls LIDO.deposit(maxDepositsPerBlock, stakingModuleId, depositCalldata).
     *
     * Reverts if any of the following is true:
     *   1. IDepositContract.get_deposit_root() != depositRoot.
     *   2. StakingModule.getNonce() != nonce.
     *   3. The number of guardian signatures is less than getGuardianQuorum().
     *   4. An invalid or non-guardian signature received.
     *   5. block.number - StakingModule.getLastDepositBlock() < minDepositBlockDistance.
     *   6. blockhash(blockNumber) != blockHash.
     *
     * Signatures must be sorted in ascending order by address of the guardian. Each signature must
     * be produced for the keccak256 hash of the following message (each component taking 32 bytes):
     *
     * | ATTEST_MESSAGE_PREFIX | blockNumber | blockHash | depositRoot | stakingModuleId | nonce |
     */
    function depositBufferedEther(
        uint256 blockNumber,
        bytes32 blockHash,
        bytes32 depositRoot,
        uint256 stakingModuleId,
        uint256 nonce,
        bytes calldata depositCalldata,
        Signature[] calldata sortedGuardianSignatures
    ) external {
        if (quorum == 0 || sortedGuardianSignatures.length < quorum) revert DepositNoQuorum();

        bytes32 onchainDepositRoot = IDepositContract(DEPOSIT_CONTRACT).get_deposit_root();
        if (depositRoot != onchainDepositRoot) revert DepositRootChanged();

        if (!STAKING_ROUTER.getStakingModuleIsActive(stakingModuleId)) revert DepositInactiveModule();

        uint256 lastDepositBlock = STAKING_ROUTER.getStakingModuleLastDepositBlock(stakingModuleId);
        if (block.number - lastDepositBlock < minDepositBlockDistance) revert DepositTooFrequent();
        if (blockHash == bytes32(0) || blockhash(blockNumber) != blockHash) revert DepositUnexpectedBlockHash();

        uint256 onchainNonce = STAKING_ROUTER.getStakingModuleNonce(stakingModuleId);
        if (nonce != onchainNonce) revert DepositNonceChanged();

        _verifySignatures(depositRoot, blockNumber, blockHash, stakingModuleId, nonce, sortedGuardianSignatures);

        LIDO.deposit(maxDepositsPerBlock, stakingModuleId, depositCalldata);
    }

    function _verifySignatures(
        bytes32 depositRoot,
        uint256 blockNumber,
        bytes32 blockHash,
        uint256 stakingModuleId,
        uint256 nonce,
        Signature[] memory sigs
    ) internal view {
        bytes32 msgHash = keccak256(
            abi.encodePacked(ATTEST_MESSAGE_PREFIX, blockNumber, blockHash, depositRoot, stakingModuleId, nonce)
        );

        address prevSignerAddr = address(0);

        for (uint256 i = 0; i < sigs.length; ++i) {
            address signerAddr = ECDSA.recover(msgHash, sigs[i].r, sigs[i].vs);
            if (!_isGuardian(signerAddr)) revert InvalidSignature();
            if (signerAddr <= prevSignerAddr) revert SignaturesNotSorted();
            prevSignerAddr = signerAddr;
        }
    }
}
