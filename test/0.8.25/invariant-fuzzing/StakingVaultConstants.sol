// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.0;

library Constants {
    //OperatorGrid params
    //retrieved from default settings in deploy scripts
    uint256 public constant SHARE_LIMIT = 1000;
    uint256 public constant RESERVE_RATIO_BP = 2000;
    uint256 public constant FORCED_REBALANCE_THRESHOLD_BP = 1800;
    uint256 public constant INFRA_FEE_BP = 500;
    uint256 public constant LIQUIDITY_FEE_BP = 400;
    uint256 public constant RESERVATION_FEE_BP = 100;

    //VaultHub params
    uint256 public constant RELATIVE_SHARE_LIMIT = 1000;
    uint256 public constant UNSETTLED_THRESHOLD = 1 ether;
    uint256 public constant TOTAL_BASIS_POINTS = 10000;

    //LidoMock params
    uint256 public constant TOTAL_SHARES_MAINNET = 7810237 ether;
    uint256 public constant TOTAL_POOLED_ETHER_MAINNET = 9365361 ether;
    uint256 public constant EXTERNAL_SHARES_MAINNET = 0;

    uint256 public constant CONNECT_DEPOSIT = 1 ether;

    //LazyOracle params
    uint64 public constant QUARANTINE_PERIOD = 3 days;
    uint16 public constant MAX_REWARD_RATIO_BP = 350; //3.5%
}
