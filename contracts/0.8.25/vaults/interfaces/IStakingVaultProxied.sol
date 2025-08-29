// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.0;

import {IBeaconProxyOssifiable} from "./IBeaconProxyOssifiable.sol";
import {IOwnable2Step} from "./IOwnable2Step.sol";
import {IStakingVault} from "./IStakingVault.sol";

/**
 * @title IStakingVaultProxied
 * @author Lido
 * @notice Unified interface for the `StakingVault` and `BeaconProxyOssifiable` contracts
 */
interface IStakingVaultProxied is IOwnable2Step, IBeaconProxyOssifiable, IStakingVault {}
