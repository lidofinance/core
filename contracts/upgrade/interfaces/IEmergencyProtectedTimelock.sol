// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: UNLICENSED

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

type Duration is uint32;

interface IEmergencyProtectedTimelock {
    function getAfterSubmitDelay() external view returns (Duration);

    function getAfterScheduleDelay() external view returns (Duration);

    function execute(uint256 proposalId) external;

    function getProposalsCount() external view returns (uint256);

    function getGovernance() external view returns (address);

    function isEmergencyModeActive() external view returns (bool);
}
