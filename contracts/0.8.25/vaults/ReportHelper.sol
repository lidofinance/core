// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultHub} from "./VaultHub.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {MerkleProof} from "@openzeppelin/contracts-v5.2/utils/cryptography/MerkleProof.sol";

contract ReportHelper {
    VaultHub public immutable vaultHub;

    struct VaultInfo {
        address vault;
        uint256 balance;
        int256 inOutDelta;
        bytes32 withdrawalCredentials;
        uint256 liabilityShares;
    }

    constructor(address _vaultHub) {
        vaultHub = VaultHub(payable(_vaultHub));
    }

    /// @notice returns batch of vaults info
    /// @param _offset offset of the vault in the batch (indexes start from 0)
    /// @param _limit limit of the batch
    /// @return batch of vaults info
    function batchVaultsInfo(uint256 _offset, uint256 _limit) external view returns (VaultInfo[] memory) {
        uint256 vaultCount = vaultHub.vaultsCount();
        uint256 limit = _offset + _limit > vaultCount - 1 ? vaultCount - 1 - _offset : _limit;
        VaultInfo[] memory batch = new VaultInfo[](limit);
        for (uint256 i = 0; i < limit; i++) {
            VaultHub.VaultSocket memory socket = vaultHub.vaultSocket(i + 1 + _offset);
            IStakingVault currentVault = IStakingVault(socket.vault);
            batch[i] = VaultInfo(
                address(currentVault),
                address(currentVault).balance,
                socket.inOutDelta,
                currentVault.withdrawalCredentials(),
                socket.liabilityShares
            );
        }
        return batch;
    }

    function isValidProof(
        address _vault,
        bytes32[] calldata _proof,
        bytes32 _root,
        uint256 _totalValue,
        int256 _inOutDelta,
        uint256 _feeSharesCharged,
        uint256 _liabilityShares
    ) external pure returns (bool) {
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(_vault, _totalValue, _inOutDelta, _feeSharesCharged, _liabilityShares)))
        );
        
        return MerkleProof.verify(_proof, _root, leaf);
    }
}
