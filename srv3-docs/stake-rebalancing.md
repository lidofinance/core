## Stake Rebalancing

Current sporadic stake rebalancing between modules via new deposits and withdrawals raises several challenges which cannot be efficiently solved with current rebalancing approaches:

- Efficiently rebalance stake between modules; it took SDVT over a year and a half to reach its target share. A future possible CSM share limit increase up to 10% might require significant time
- Ensure that there is always enough ETH for initial 32 ETH deposits to 0x02 type keys in the CMv2 module to support stake migration from CMv1 to CMv2 modules via consolidation

In order to solve these challenges, it is proposed to add a deposit fast-lane mechanism to enable protocol buffered ether deposits up to a defined daily amount regardless of the withdrawal demand.

### Deposit Fast-lane

Current conditions, such as cycling arbitrage and vampire attacks via withdrawals, can result in submitted ether being withdrawn before it is ever deposited. This situation limits the ability to allocate stake to new modules and node operators.

To ensure that there is always enough ETH for stake rebalancing and initial 32 ETH deposits to 0x02 type keys in the CMv2 module during the migration process, it is proposed to enable protocol buffered ether deposits up to a defined daily amount per module regardless of the withdrawal demand.

#### Proposed solution

1. Allow the DAO or a delegated entity to set a 'fast-lane' depositable amount (`depositableFastLaneAmount`) of ether
2. Permit deposits up to the `depositableFastLaneAmount` per oracle report frame (which changes daily) regardless of the withdrawal demand represented with `withdrawalQueue.unfinalizedStETH()`
3. Revert to previous rules if the `depositableFastLaneAmount` has already been deposited OR if the oracle report for the current reference slot is still pending

The proposed change affects two functions of the Lido main contract:

1. `Lido.getDepositableEther()`
2. `Lido.deposit()`

Also, a lever setter function must be presented, governed by the DAO, to change the `depositableFastLaneAmount`.

```solidity
interface ILido {
  /// @notice Set depositable fast-lane amount.
  /// @dev Access-controlled in the implementation (role-based).
  function setDepositableFastLaneAmount(uint256 amount) external;

  /// @notice Get depositable fast-lane amount per module.
  function getDepositableFastLaneAmount() external view returns (uint256);
}
```

A simple sanity check for the maximum possible fast lane amount (1M ETH) proposed to be added to the `setDepositableFastLaneAmount` method to prevent an unreasonably high value.

The fast-lane mechanism is paused during accounting report — from the accounting report reference slot until the report is fully processed.
This pause is necessary to ensure accurate withdrawal request fulfillment calculations.

![image](https://hackmd.io/_uploads/S1FlvYmHZe.png)

Since the time between the accounting report reference slot and report processing usually takes less than half an hour, these brief periods of fast-lane inactivity are not expected to have a significant impact on the overall efficiency of the mechanism.

#### Deposit & Withdrawal Prioritization

The organic ETH distribution priority will be as follows:

1. Deposits to the modules up to the fast-lane limit
2. Cover withdrawal requests
3. Deposits to the modules (with remaining ETH)

**Example 1:** An ETH amount not exceeding the fast-lane limit is submitted. In this case, all ETH will go to deposits via the fast-lane mechanism. Withdrawal requests should be covered by validator exits via VEBO.
![image](https://hackmd.io/_uploads/rJf_Xgb1be.png)

**Example 2:** An ETH amount greater than the fast-lane limit but insufficient to cover all withdrawal requests is submitted. In this case, ETH up to the fast-lane limit will be deposited to the module, and the remaining ETH in the buffer will be used to cover withdrawal requests. Uncovered withdrawals will be satisfied via validator exits through VEBO.

![image](https://hackmd.io/_uploads/BkEY7xZyZe.png)

**Example 3:** An ETH amount exceeding both the fast-lane limit and total withdrawal requests is submitted. In this case, ETH up to the fast-lane limit will be deposited to the module, all withdrawal requests will be covered by buffered ETH, and the remaining ETH in the buffer will be deposited to modules.

![image](https://hackmd.io/_uploads/BJ89mxWy-x.png)
