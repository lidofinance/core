import { IHashConsensus } from "contracts/common/interfaces/IHashConsensus.sol";

contract IHashConsensusMock is IHashConsensus {
    function getIsMember(address addr) external view returns (bool) {
        return true;
    }

    function getCurrentFrame() external view returns (
        uint256 refSlot,
        uint256 reportProcessingDeadlineSlot
    ) {
        refSlot = 0;
        reportProcessingDeadlineSlot = 0;
    }

    function getChainConfig() external view returns (
        uint256 slotsPerEpoch,
        uint256 secondsPerSlot,
        uint256 genesisTime
    ) {
        slotsPerEpoch = 0;
        secondsPerSlot = 0;
        genesisTime = 0;
    }

    function getFrameConfig() external view returns (uint256 initialEpoch, uint256 epochsPerFrame) {
        initialEpoch = 0;
        epochsPerFrame = 0;
    }

    function getInitialRefSlot() external view returns (uint256) {
        return 0;
    }
}