pragma solidity 0.4.24;


/**
  * @title Liquid staking pool
  *
  * For the high-level description of the pool operation please refer to the paper.
  * Pool manages signing and withdrawal keys. It receives ether submitted by users on the ETH 1 side
  * and stakes it via the validator_registration.vy contract. It doesn't hold ether on it's balance,
  * only a small portion (buffer) of it.
  * It also mints new tokens for rewards generated at the ETH 2.0 side.
  */
interface IDePool {
    /**
      * @notice Stop pool routine operations
      */
    function stop() external;

    /**
      * @notice Resume pool routine operations
      */
    function resume() external;

    event Stopped();
    event Resumed();


    /**
      * @notice Set fee rate to `_feeBasisPoints` basis points. The fees are accrued when oracles report staking results
      * @param _feeBasisPoints Fee rate, in basis points
      */
    function setFee(uint16 _feeBasisPoints) external;

    /**
      * @notice Set fee distribution: `_treasuryFeeBasisPoints` basis points go to the treasury, `_insuranceFeeBasisPoints` basis points go to the insurance fund, `_SPFeeBasisPoints` basis points go to staking providers. The sum has to be 10 000.
      */
    function setFeeDistribution(uint16 _treasuryFeeBasisPoints, uint16 _insuranceFeeBasisPoints,
                                uint16 _SPFeeBasisPoints) external;

    /**
      * @notice Returns staking rewards fee rate
      */
    function getFee() external view returns (uint16 feeBasisPoints);

    /**
      * @notice Returns fee distribution proportion
      */
    function getFeeDistribution() external view returns (uint16 treasuryFeeBasisPoints, uint16 insuranceFeeBasisPoints,
                                                         uint16 SPFeeBasisPoints);

    event FeeSet(uint16 feeBasisPoints);

    event FeeDistributionSet(uint16 treasuryFeeBasisPoints, uint16 insuranceFeeBasisPoints, uint16 SPFeeBasisPoints);


    /**
      * @notice Set credentials to withdraw ETH on ETH 2.0 side after the phase 2 is launched to `_withdrawalCredentials`
      * @dev Note that setWithdrawalCredentials discards all unused signing keys as the signatures are invalidated.
      * @param _withdrawalCredentials hash of withdrawal multisignature key as accepted by
      *        the validator_registration.deposit function
      */
    function setWithdrawalCredentials(bytes _withdrawalCredentials) external;

    /**
      * @notice Returns current credentials to withdraw ETH on ETH 2.0 side after the phase 2 is launched
      */
    function getWithdrawalCredentials() external view returns (bytes);

    /**
      * @notice Add `_quantity` validator signing keys to the set of usable keys. Concatenated keys are: `_pubkeys`
      * @dev Along with each key the DAO has to provide a signatures for the
      *      (pubkey, withdrawal_credentials, 32000000000) message.
      *      Given that information, the contract'll be able to call
      *      validator_registration.deposit on-chain.
      * @param _quantity Number of signing keys provided
      * @param _pubkeys Several concatenated validator signing keys
      * @param _signatures Several concatenated signatures for (pubkey, withdrawal_credentials, 32000000000) messages
      */
    function addSigningKeys(uint256 _quantity, bytes _pubkeys, bytes _signatures) external;

    /**
      * @notice Removes a validator signing key #`_index` from the set of usable keys
      * @param _index Index of the key, starting with 0
      */
    function removeSigningKey(uint256 _index) external;

    /**
      * @notice Returns total number of signing keys
      */
    function getTotalSigningKeyCount() external view returns (uint256);

    /**
      * @notice Returns number of usable signing keys
      */
    function getUnusedSigningKeyCount() external view returns (uint256);

    /**
      * @notice Returns n-th signing key
      * @param _index Index of the key, starting with 0
      * @return key Key
      * @return used Flag indication if the key was used in the staking
      */
    function getSigningKey(uint256 _index) external view returns (bytes key, bool used);

    event WithdrawalCredentialsSet(bytes withdrawalCredentials);
    event SigningKeyAdded(bytes pubkey);
    event SigningKeyRemoved(bytes pubkey);


    /**
      * @notice Ether on the ETH 2.0 side reported by the oracle
      * @param _epoch Epoch id
      * @param _eth2balance Balance in wei on the ETH 2.0 side
      */
    function reportEther2(uint256 _epoch, uint256 _eth2balance) external;


    // User functions

    /**
      * @notice Adds eth to the pool
      * @return StETH Amount of StETH generated
      */
    function submit(address _referral) external payable returns (uint256 StETH);

    // Records a deposit made by a user
    event Submitted(address indexed sender, uint256 amount, address referral);

    // The `_amount` of ether was sent to the validator_registration.deposit function.
    event Unbuffered(uint256 amount);

    /**
      * @notice Issues withdrawal request. Large withdrawals will be processed only after the phase 2 launch.
      * @param _amount Amount of StETH to burn
      * @param _pubkeyHash Receiving address
      */
    function withdraw(uint256 _amount, bytes32 _pubkeyHash) external;

    // Requested withdrawal of `etherAmount` to `pubkeyHash` on the ETH 2.0 side, `tokenAmount` burned by `sender`,
    // `sentFromBuffer` was sent on the current Ethereum side.
    event Withdrawal(address indexed sender, uint256 tokenAmount, uint256 sentFromBuffer,
                     bytes32 indexed pubkeyHash, uint256 etherAmount);


    // Info functions

    /**
      * @notice Gets the amount of Ether controlled by the system
      */
    function getTotalControlledEther() external view returns (uint256);

    /**
      * @notice Gets the amount of Ether temporary buffered on this contract balance
      */
    function getBufferedEther() external view returns (uint256);

    /**
      * @notice Gets the stat of the system's Ether on the Ethereum 2 side
      * @return deposited Amount of Ether deposited from the current Ethereum
      * @return remote Amount of Ether currently present on the Ethereum 2 side (can be 0 if the Ethereum 2 is yet to be launched)
      */
    function getEther2Stat() external view returns (uint256 deposited, uint256 remote);
}
