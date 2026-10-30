/* Spec for `Accounting` contract summarizing `OracleReportSanityChecker.smoothenTokenRebase` */

import "./Accounting.spec";

methods {
    // `OracleReportSanityChecker`
    function _.smoothenTokenRebase(
        uint256 _preTotalPooledEther,
        uint256 _preTotalShares,
        uint256 _preCLBalance,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        uint256 _etherToLockForWithdrawals,
        uint256 _newSharesToBurnForWithdrawals
    ) external => CVLSimplifiedsmoothenTokenRebase(
        _preTotalPooledEther,               
        _preTotalShares,
        _preCLBalance,
        _postCLBalance,
        _withdrawalVaultBalance,
        _elRewardsVaultBalance,
        _sharesRequestedToBurn,
        _etherToLockForWithdrawals,
        _newSharesToBurnForWithdrawals
    ) expect (uint256, uint256, uint256, uint256);
}


use rule feesMintShares;
use rule reportNotRevertsByDeposit;
use rule reportNotRevertsBySubmit;
use rule simulationnIsCorrect;
use rule handleOracleReportRevertConditions;
