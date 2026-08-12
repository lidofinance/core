// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: UNLICENSED

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

import {GlobalConfig, CoreUpgradeConfig, CuratedModuleConfig, CSMUpgradeConfig} from "../UpgradeTypes.sol";

interface IUpgradeConfig {
    function LOCATOR() external view returns (address);
    function AGENT() external view returns (address);
    function VOTING() external view returns (address);
    function DUAL_GOVERNANCE() external view returns (address);

    function getGlobalConfig() external view returns (GlobalConfig memory);
    function getCoreUpgradeConfig() external view returns (CoreUpgradeConfig memory);
    function getCSMUpgradeConfig() external view returns (CSMUpgradeConfig memory);
    function getCuratedModuleConfig() external view returns (CuratedModuleConfig memory);
}
