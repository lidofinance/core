// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {
    IUpgradeConfig,
    GeneralConfig,
    CoreUpgradeConfig,
    IEasyTrack,
    IStakingRouter,
    IConsolidationMigrator
} from "../UpgradeTypes.sol";

import {OmnibusBase} from "../utils/OmnibusBase.sol";
import {VoteScriptHelpers} from "../utils/VoteScriptHelpers.sol";

/// @title New EasyTrack Factories items
/// @notice Adding new EasyTrack Factories items executed by the Voting contract (DG not required).
library EasyTrackFactoryItems {
    uint256 internal constant COUNT = 2;

    function getItems(IUpgradeConfig template) external view returns (OmnibusBase.VoteItem[] memory items) {
        GeneralConfig memory g = template.getGeneralConfig();
        CoreUpgradeConfig memory c = template.getCoreUpgradeConfig();

        address easyTrack = g.easyTrack;
        items = new OmnibusBase.VoteItem[](COUNT);

        uint256 i = 0;

        items[i++] = _etfItem(
            "Add UpdateStakingModuleShareLimits factory to Easy Track",
            easyTrack,
            c.etfUpdateStakingModuleShareLimits,
            bytes.concat(bytes20(g.stakingRouter), bytes4(IStakingRouter.updateModuleShares.selector))
        );

        items[i++] = _etfItem(
            "Add AllowConsolidationPair factory to Easy Track",
            easyTrack,
            c.etfAllowConsolidationPair,
            bytes.concat(bytes20(c.consolidationMigrator), bytes4(IConsolidationMigrator.allowPair.selector))
        );

        assert(i == COUNT);
    }

    function _etfItem(string memory description, address easyTrack, address factory, bytes memory permissions)
        private
        pure
        returns (OmnibusBase.VoteItem memory)
    {
        return VoteScriptHelpers.item({
            description: description,
            to: easyTrack,
            data: abi.encodeCall(IEasyTrack.addEVMScriptFactory, (factory, permissions))
        });
    }
}
