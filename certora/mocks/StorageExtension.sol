import "contracts/0.8.25/vaults/predeposit_guarantee/PredepositGuarantee.sol";
import "contracts/0.8.25/vaults/LazyOracle.sol";
import "contracts/0.8.25/vaults/OperatorGrid.sol";
import "contracts/0.8.25/vaults/StakingVault.sol";
import "contracts/0.8.25/vaults/VaultHub.sol";

contract StorageExtension {
    /**
     * @custom:certoralink 0x73a2a247d4b1b6fe056fe90935e9bd3694e896bafdd08f046c2afe6ec2db2100
     */
    LazyOracle.Storage lo_storage;
    /**
     * @custom:certoralink 0x6b64617c951381e2c1eff2be939fe368ab6d76b7d335df2e47ba2309eba1c700
     */
    OperatorGrid.ERC7201Storage og_storage;
    /**
     * @custom:certoralink 0xf66b5a365356c5798cc70e3ea6a236b181a826a69f730fc07cc548244bee5200
     */
    PredepositGuarantee.ERC7201Storage pg_storage;
    /**
     * @custom:certoralink 0x2ec50241a851d8d3fea472e7057288d4603f7a7f78e6d18a9c12cad84552b100
     */
    StakingVault.Storage sv_storage;
    /**
     * @custom:certoralink 0x9eb73ffa4c77d08d5d1746cf5a5e50a47018b610ea5d728ea9bd9e399b76e200
     */
    VaultHub.Storage vh_storage;
}
