import { expect } from "chai";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, ValidatorsExitBus__Harness, WithdrawalVault__MockForVebo } from "typechain-types";

import { deployVEBO, initVEBO } from "test/deploy";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
];

describe("ValidatorsExitBusOracle.sol:emitExitEvents", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;
  let withdrawalVault: WithdrawalVault__MockForVebo;

  let authorizedEntity: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let validatorExitData: ValidatorExitData;

  const LAST_PROCESSING_REF_SLOT = 1;

  interface ValidatorExitData {
    stakingModuleId: number;
    nodeOperatorId: number;
    validatorIndex: number;
    validatorPubkey: string;
  }

  const deploy = async () => {
    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;
    withdrawalVault = deployed.withdrawalVault;

    await initVEBO({
      admin: admin.address,
      oracle,
      consensus,
      withdrawalVault,
      resumeAfterDeploy: true,
      lastProcessingRefSlot: LAST_PROCESSING_REF_SLOT,
    });
  };

  before(async () => {
    [admin, authorizedEntity, stranger] = await ethers.getSigners();

    await deploy();
  });

  it("Should revert without DIRECT_EXIT_HASH_ROLE role", async () => {
    validatorExitData = {
      stakingModuleId: 1,
      nodeOperatorId: 0,
      validatorIndex: 0,
      validatorPubkey: PUBKEYS[0],
    };

    await expect(
      oracle.connect(stranger).triggerExitsDirectly(validatorExitData, {
        value: 2,
      }),
    ).to.be.revertedWithOZAccessControlError(await stranger.getAddress(), await oracle.DIRECT_EXIT_HASH_ROLE());
  });

  it("Not enough fee", async () => {
    const role = await oracle.DIRECT_EXIT_HASH_ROLE();

    await oracle.grantRole(role, authorizedEntity);

    await expect(
      oracle.connect(authorizedEntity).triggerExitsDirectly(validatorExitData, {
        value: 0,
      }),
    )
      .to.be.revertedWithCustomError(oracle, "InsufficientPayment")
      .withArgs(1, 1, 0);
  });

  it("Emit ValidatorExit event and should trigger withdrawals", async () => {
    const tx = await oracle.connect(authorizedEntity).triggerExitsDirectly(validatorExitData, {
      value: 2,
    });
    const timestamp = await oracle.getTime();
    await expect(tx).to.emit(withdrawalVault, "AddFullWithdrawalRequestsCalled").withArgs(PUBKEYS[0]);
    await expect(tx).to.emit(oracle, "MadeRefund").withArgs(anyValue, 1);

    await expect(tx)
      .to.emit(oracle, "ValidatorExitRequest")
      .withArgs(
        validatorExitData.stakingModuleId,
        validatorExitData.nodeOperatorId,
        validatorExitData.validatorIndex,
        validatorExitData.validatorPubkey,
        timestamp,
      );
  });
});
