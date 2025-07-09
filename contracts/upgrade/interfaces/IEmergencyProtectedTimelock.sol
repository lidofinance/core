// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity >=0.4.24 <0.9.0;

type Duration is uint32;

interface IEmergencyProtectedTimelock {
    function getAfterSubmitDelay() external view returns (Duration);

    function getAfterScheduleDelay() external view returns (Duration);

    function execute(uint256 proposalId) external;
}
