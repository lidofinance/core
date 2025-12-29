import { ethers } from "hardhat";

import { SSZBLSHelpers, SSZValidatorsAndBalancesMerkleTree } from "typechain-types";

import { generateValidator } from "lib";

const DEFAULT_GI_VALIDATOR_0 = "0x0000000000000000000000000000000000000000000000000096000000000028";
const DEFAULT_GI_BALANCE_0 = "0x0000000000000000000000000000000000000000000000000098000000000028";
// pending_deposits[0]: GI = 202 * 2^27 = 27111981056 = 0x650000000, depth = 34 (0x22)
// 202 = (2^6 + 37) * 2, where 37 is pending_deposits field index in BeaconState
// depth = 6 (container) + 1 (list) + 27 (PENDING_DEPOSITS_LIMIT = 2^27) = 34
const DEFAULT_GI_PENDING_DEPOSITS_0 = "0x0000000000000000000000000000000000000000000000000000065000000022";

export const prepareLocalMerkleTree = async (
  giValidator0: string = DEFAULT_GI_VALIDATOR_0,
  giBalance0: string = DEFAULT_GI_BALANCE_0,
  giPendingDeposit0: string = DEFAULT_GI_PENDING_DEPOSITS_0,
) => {
  // deploy helper tree validators+balances
  const stateTree: SSZValidatorsAndBalancesMerkleTree = await ethers.deployContract(
    "SSZValidatorsAndBalancesMerkleTree",
    [giValidator0, giBalance0, giPendingDeposit0],
    {},
  );

  // generate first validator
  const firstValidator = generateValidator();

  await stateTree.addValidatorsLeaf(firstValidator.container);
  await stateTree.addBalancesLeaf(firstValidator.container.effectiveBalance);

  // Index of first validator leafCount-1
  const validatorsLeafCount = await stateTree.validatorsLeafCount();
  const balancesLeafCount = await stateTree.balancesLeafCount();

  const firstValidatorLeafIndex = validatorsLeafCount - 1n;
  const firstBalanceLeafIndex = balancesLeafCount - 1n;

  // generalized index для validators[firstValidatorLeafIndex] и balances[firstBalanceLeafIndex]
  const gIFirstValidator = await stateTree.getValidatorGeneralizedIndex(firstValidatorLeafIndex);
  const gIFirstBalance = await stateTree.getBalanceGeneralizedIndex(firstBalanceLeafIndex);

  if (BigInt(gIFirstValidator) >> 8n === 0n) throw new Error("Broken GIndex setup");

  const PENDING_SLOT = 1234n; // < uint32
  const PENDING_AMOUNT = 320_000000000n; // fits in uint64
  const PENDING_SIGNATURE = "0x" + "11".repeat(96); // 96 bytes

  const firstPendingDeposit = {
    pubkey: firstValidator.container.pubkey,
    withdrawalCredentials: firstValidator.container.withdrawalCredentials,
    amount: PENDING_AMOUNT,
    signature: PENDING_SIGNATURE,
    slot: Number(PENDING_SLOT), // SSZValidatorsAndBalancesMerkleTree.PendingDeposit.slot is uint32
  };

  await stateTree.addPendingDepositLeaf(firstPendingDeposit);

  // Now compute "first pending leaf index" exactly like validators/balances
  const pendingDepositsLeafCount = await stateTree.pendingDepositsLeafCount();
  const firstPendingDepositLeafIndex = pendingDepositsLeafCount - 1n;

  const gIFirstPendingDeposit = await stateTree.getPendingDepositGeneralizedIndex(firstPendingDepositLeafIndex);

  const addValidatorWithBalance = async (validator: SSZBLSHelpers.ValidatorStruct, balanceGwei: bigint) => {
    await stateTree.addValidatorsLeaf(validator);
    await stateTree.addBalancesLeaf(balanceGwei);

    const newValidatorsLeafCount = await stateTree.validatorsLeafCount();
    const validatorIndex = Number(newValidatorsLeafCount - 1n - firstValidatorLeafIndex);

    return {
      validatorIndex,
    };
  };

  return {
    stateTree,
    gIFirstValidator,
    gIFirstBalance,
    firstValidatorLeafIndex,
    firstBalanceLeafIndex,
    firstValidator,
    addValidatorWithBalance,
    gIFirstPendingDeposit,
    firstPendingDepositLeafIndex,
  };
};
