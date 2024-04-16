// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {ECDSA} from "../common/lib/ECDSA.sol";

interface ILido {
    function deposit(uint256 _maxDepositsCount, uint256 _stakingModuleId, bytes calldata _depositCalldata) external;
    function canDeposit() external view returns (bool);
}

interface IDepositContract {
    function get_deposit_root() external view returns (bytes32 rootHash);
}

interface IStakingRouter {
    function getStakingModuleMinDepositBlockDistance(uint256 _stakingModuleId) external view returns (uint256);
    function getStakingModuleMaxDepositsPerBlock(uint256 _stakingModuleId) external view returns (uint256);
    function getStakingModuleIsDepositsPaused(uint256 _stakingModuleId) external view returns (bool);
    function getStakingModuleIsActive(uint256 _stakingModuleId) external view returns (bool);
    function getStakingModuleNonce(uint256 _stakingModuleId) external view returns (uint256);
    function getStakingModuleLastDepositBlock(uint256 _stakingModuleId) external view returns (uint256);
    function hasStakingModule(uint256 _stakingModuleId) external view returns (bool);
    function decreaseStakingModuleVettedKeysCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _vettedSigningKeysCounts
    ) external;
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
    event UnvetIntentValidityPeriodBlocksChanged(uint256 newValue);
    event MaxOperatorsPerUnvettingChanged(uint256 newValue);
    event GuardianQuorumChanged(uint256 newValue);
    event GuardianAdded(address guardian);
    event GuardianRemoved(address guardian);
    event DepositsPaused(address indexed guardian);
    event DepositsUnpaused();
    event LastDepositBlockChanged(uint256 newValue);

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
    error DepositsNotPaused();
    error ModuleNonceChanged();
    error PauseIntentExpired();
    error UnvetIntentExpired();
    error UnvetPayloadInvalid();
    error UnvetUnexpectedBlockHash();
    error NotAGuardian(address addr);
    error ZeroParameter(string parameter);

    bytes32 public immutable ATTEST_MESSAGE_PREFIX;
    bytes32 public immutable PAUSE_MESSAGE_PREFIX;
    bytes32 public immutable UNVET_MESSAGE_PREFIX;

    ILido public immutable LIDO;
    IStakingRouter public immutable STAKING_ROUTER;
    IDepositContract public immutable DEPOSIT_CONTRACT;

    bool public isDepositsPaused;

    uint256 internal lastDepositBlock;

    uint256 internal pauseIntentValidityPeriodBlocks;
    uint256 internal unvetIntentValidityPeriodBlocks;
    uint256 internal maxOperatorsPerUnvetting;

    address internal owner;

    uint256 internal quorum;
    address[] internal guardians;
    mapping(address => uint256) internal guardianIndicesOneBased; // 1-based

    constructor(
        address _lido,
        address _depositContract,
        address _stakingRouter,
        uint256 _pauseIntentValidityPeriodBlocks,
        uint256 _unvetIntentValidityPeriodBlocks,
        uint256 _maxOperatorsPerUnvetting
    ) {
        if (_lido == address(0)) revert ZeroAddress("_lido");
        if (_depositContract == address(0)) revert ZeroAddress("_depositContract");
        if (_stakingRouter == address(0)) revert ZeroAddress("_stakingRouter");

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

        UNVET_MESSAGE_PREFIX = keccak256(
            abi.encodePacked(
                // keccak256("lido.DepositSecurityModule.UNVET_MESSAGE")
                bytes32(0x2dd9727393562ed11c29080a884630e2d3a7078e71b313e713a8a1ef68948f6a),
                block.chainid,
                address(this)
            )
        );

        _setOwner(msg.sender);
        _setLastDepositBlock(block.number);
        _setPauseIntentValidityPeriodBlocks(_pauseIntentValidityPeriodBlocks);
        _setUnvetIntentValidityPeriodBlocks(_unvetIntentValidityPeriodBlocks);
        _setMaxOperatorsPerUnvetting(_maxOperatorsPerUnvetting);
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
     * Returns current `unvetIntentValidityPeriodBlocks` contract parameter (see `unvetSigningKeys`).
     */
    function getUnvetIntentValidityPeriodBlocks() external view returns (uint256) {
        return unvetIntentValidityPeriodBlocks;
    }

    /**
     * Sets `unvetIntentValidityPeriodBlocks`. Only callable by the owner.
     */
    function setUnvetIntentValidityPeriodBlocks(uint256 newValue) external onlyOwner {
        _setUnvetIntentValidityPeriodBlocks(newValue);
    }

    function _setUnvetIntentValidityPeriodBlocks(uint256 newValue) internal {
        if (newValue == 0) revert ZeroParameter("unvetIntentValidityPeriodBlocks");
        unvetIntentValidityPeriodBlocks = newValue;
        emit UnvetIntentValidityPeriodBlocksChanged(newValue);
    }


    /**
     * Returns current `maxOperatorsPerUnvetting` contract parameter (see `unvetSigningKeys`).
     */
    function getMaxOperatorsPerUnvetting() external view returns (uint256) {
        return maxOperatorsPerUnvetting;
    }

    /**
     * Sets `maxOperatorsPerUnvetting`. Only callable by the owner.
     */
    function setMaxOperatorsPerUnvetting(uint256 newValue) external onlyOwner {
        _setMaxOperatorsPerUnvetting(newValue);
    }

    function _setMaxOperatorsPerUnvetting(uint256 newValue) internal {
        if (newValue == 0) revert ZeroParameter("maxOperatorsPerUnvetting");
        maxOperatorsPerUnvetting = newValue;
        emit MaxOperatorsPerUnvettingChanged(newValue);
    }

    /**
     * Returns number of valid guardian signatures required to attest (depositRoot, nonce) pair.
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
     * Pauses deposits if both conditions are satisfied (reverts otherwise):
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
     * | PAUSE_MESSAGE_PREFIX | blockNumber |
     */
    function pauseDeposits(uint256 blockNumber, Signature memory sig) external {
        // In case of an emergency function `pauseDeposits` is supposed to be called
        // by all guardians. Thus only the first call will do the actual change. But
        // the other calls would be OK operations from the point of view of protocol’s logic.
        // Thus we prefer not to use “error” semantics which is implied by `require`.

        if (isDepositsPaused) return;

        address guardianAddr = msg.sender;
        int256 guardianIndex = _getGuardianIndex(msg.sender);

        if (guardianIndex == -1) {
            bytes32 msgHash = keccak256(abi.encodePacked(PAUSE_MESSAGE_PREFIX, blockNumber));
            guardianAddr = ECDSA.recover(msgHash, sig.r, sig.vs);
            guardianIndex = _getGuardianIndex(guardianAddr);
            if (guardianIndex == -1) revert InvalidSignature();
        }

        if (block.number - blockNumber > pauseIntentValidityPeriodBlocks) revert PauseIntentExpired();

        isDepositsPaused = true;
        emit DepositsPaused(guardianAddr);
    }

    /**
     * Unpauses deposits
     *
     * Only callable by the owner.
     */
    function unpauseDeposits() external onlyOwner {
        if (!isDepositsPaused) revert DepositsNotPaused();
        isDepositsPaused = false;
        emit DepositsUnpaused();
    }

    /**
     * Returns whether LIDO.deposit() can be called, given that the caller will provide
     * guardian attestations of non-stale deposit root and `nonce`, and the number of
     * such attestations will be enough to reach quorum.
     */
    function canDeposit(uint256 stakingModuleId) external view returns (bool) {
        if (!STAKING_ROUTER.hasStakingModule(stakingModuleId)) return false;

        bool isModuleActive = STAKING_ROUTER.getStakingModuleIsActive(stakingModuleId);
        bool isDepositDistancePassed = _isMinDepositDistancePassed(stakingModuleId);
        bool isLidoCanDeposit = LIDO.canDeposit();

        return (
            !isDepositsPaused
            && isModuleActive
            && quorum > 0
            && isDepositDistancePassed
            && isLidoCanDeposit
        );
    }

    /**
     * Returns the last block number when a deposit was made.
     */
    function getLastDepositBlock() external view returns (uint256) {
        return lastDepositBlock;
    }

    function _setLastDepositBlock(uint256 newValue) internal {
        lastDepositBlock = newValue;
        emit LastDepositBlockChanged(newValue);
    }

    /**
     * Returns whether the deposit distance is greater than the minimum required.
     */
    function isMinDepositDistancePassed(uint256 stakingModuleId) external view returns (bool) {
        return _isMinDepositDistancePassed(stakingModuleId);
    }

    function _isMinDepositDistancePassed(uint256 stakingModuleId) internal view returns (bool) {
        uint256 lastDepositToModuleBlock = STAKING_ROUTER.getStakingModuleLastDepositBlock(stakingModuleId);
        uint256 minDepositBlockDistance = STAKING_ROUTER.getStakingModuleMinDepositBlockDistance(stakingModuleId);
        uint256 maxLastDepositBlock = lastDepositToModuleBlock >= lastDepositBlock ? lastDepositToModuleBlock : lastDepositBlock;
        return block.number - maxLastDepositBlock >= minDepositBlockDistance;
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

        uint256 maxDepositsPerBlock = STAKING_ROUTER.getStakingModuleMaxDepositsPerBlock(stakingModuleId);

        if (!_isMinDepositDistancePassed(stakingModuleId)) revert DepositTooFrequent();
        if (blockHash == bytes32(0) || blockhash(blockNumber) != blockHash) revert DepositUnexpectedBlockHash();

        uint256 onchainNonce = STAKING_ROUTER.getStakingModuleNonce(stakingModuleId);
        if (nonce != onchainNonce) revert ModuleNonceChanged();

        _verifySignatures(depositRoot, blockNumber, blockHash, stakingModuleId, nonce, sortedGuardianSignatures);

        LIDO.deposit(maxDepositsPerBlock, stakingModuleId, depositCalldata);
        _setLastDepositBlock(block.number);
    }

    /**
     * Unvetting signing keys for the given node operators.
     *
     * Reverts if any of the following is true:
     *   1. nodeOperatorIds is not packed with 8 bytes per id.
     *   2. vettedSigningKeysCounts is not packed with 16 bytes per count.
     *   3. The number of node operators is greater than maxOperatorsPerUnvetting.
     *   4. The nonce is not equal to the on-chain nonce of the staking module.
     *   5. The signature is invalid or the signer is not a guardian.
     *   6. block.number - blockNumber > unvetIntentValidityPeriodBlocks.
     *
     * The signature, if present, must be produced for keccak256 hash of the following message:
     *
     * | UNVET_MESSAGE_PREFIX | blockNumber | blockHash | stakingModuleId | nonce | nodeOperatorIds | vettedSigningKeysCounts |
     */
    function unvetSigningKeys(
        uint256 blockNumber,
        bytes32 blockHash,
        uint256 stakingModuleId,
        uint256 nonce,
        bytes calldata nodeOperatorIds,
        bytes calldata vettedSigningKeysCounts,
        Signature calldata sig
    ) external {
        uint256 onchainNonce = STAKING_ROUTER.getStakingModuleNonce(stakingModuleId);
        if (nonce != onchainNonce) revert ModuleNonceChanged();

        uint256 nodeOperatorsCount = nodeOperatorIds.length / 8;

        if (
            nodeOperatorIds.length % 8 != 0 ||
            vettedSigningKeysCounts.length % 16 != 0 ||
            vettedSigningKeysCounts.length / 16 != nodeOperatorsCount ||
            nodeOperatorsCount > maxOperatorsPerUnvetting
        ) {
            revert UnvetPayloadInvalid();
        }

        address guardianAddr = msg.sender;
        int256 guardianIndex = _getGuardianIndex(msg.sender);

        if (guardianIndex == -1) {
            bytes32 msgHash = keccak256(abi.encodePacked(
                UNVET_MESSAGE_PREFIX,
                blockNumber,
                blockHash,
                stakingModuleId,
                nonce,
                nodeOperatorIds,
                vettedSigningKeysCounts
            ));
            guardianAddr = ECDSA.recover(msgHash, sig.r, sig.vs);
            guardianIndex = _getGuardianIndex(guardianAddr);
            if (guardianIndex == -1) revert InvalidSignature();
        }

        if (blockHash == bytes32(0) || blockhash(blockNumber) != blockHash) revert UnvetUnexpectedBlockHash();
        if (block.number - blockNumber > unvetIntentValidityPeriodBlocks) revert UnvetIntentExpired();

        STAKING_ROUTER.decreaseStakingModuleVettedKeysCountByNodeOperator(
            stakingModuleId, nodeOperatorIds, vettedSigningKeysCounts
        );
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
