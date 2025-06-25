// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.5.0;


interface IHashConsensus {
    function getIsMember(address addr) external view returns (bool);

    function getCurrentFrame() external view returns (
        uint256 refSlot,
        uint256 reportProcessingDeadlineSlot
    );

    function getChainConfig() external view returns (
        uint256 slotsPerEpoch,
        uint256 secondsPerSlot,
        uint256 genesisTime
    );

    function getFrameConfig() external view returns (uint256 initialEpoch, uint256 epochsPerFrame);

    function getInitialRefSlot() external view returns (uint256);
}
