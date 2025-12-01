import { IHashConsensus } from "contracts/common/interfaces/IHashConsensus.sol";

contract IHashConsensusMock is IHashConsensus {
    function getIsMember(address addr) external view returns (bool) {
        return true;
    }

    function getCurrentFrame() external view returns (
        uint256 refSlot,
        uint256 reportProcessingDeadlineSlot
    ) {
        refSlot = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000001,refSlot)}
        reportProcessingDeadlineSlot = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000002,reportProcessingDeadlineSlot)}
    }

    function getChainConfig() external view returns (
        uint256 slotsPerEpoch,
        uint256 secondsPerSlot,
        uint256 genesisTime
    ) {
        slotsPerEpoch = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000003,slotsPerEpoch)}
        secondsPerSlot = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000004,secondsPerSlot)}
        genesisTime = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000005,genesisTime)}
    }

    function getFrameConfig() external view returns (uint256 initialEpoch, uint256 epochsPerFrame) {
        initialEpoch = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000006,initialEpoch)}
        epochsPerFrame = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000007,epochsPerFrame)}
    }

    function getInitialRefSlot() external view returns (uint256) {
        return 0;
    }
}