import { expect } from "chai";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  HashConsensus__Harness,
  StakingRouter__MockForVebo,
  ValidatorsExitBus__Harness,
  WithdrawalVault__MockForVebo,
} from "typechain-types";

import { deployVEBO, initVEBO } from "test/deploy";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
];

describe("ValidatorsExitBusOracle.sol:triggerExitsDirectly", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;
  let withdrawalVault: WithdrawalVault__MockForVebo;
  let stakingRouter: StakingRouter__MockForVebo;

  let authorizedEntity: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let exitData: DirectExitData;

  const LAST_PROCESSING_REF_SLOT = 1;
  const pubkeys = [PUBKEYS[0], PUBKEYS[1], PUBKEYS[3]];

  interface DirectExitData {
    stakingModuleId: number;
    nodeOperatorId: number;
    validatorsPubkeys: string;
  }

  const deploy = async () => {
    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;
    withdrawalVault = deployed.withdrawalVault;
    stakingRouter = deployed.stakingRouter;

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

  it("Should revert without DIRECT_EXIT_ROLE role", async () => {
    const concatenatedPubKeys = pubkeys.map((pk) => pk.replace(/^0x/, "")).join("");

    exitData = {
      stakingModuleId: 1,
      nodeOperatorId: 0,
      validatorsPubkeys: "0x" + concatenatedPubKeys,
    };

    await expect(
      oracle.connect(stranger).triggerExitsDirectly(exitData, {
        value: 4,
      }),
    ).to.be.revertedWithOZAccessControlError(await stranger.getAddress(), await oracle.DIRECT_EXIT_ROLE());
  });

  it("Not enough fee", async () => {
    const role = await oracle.DIRECT_EXIT_ROLE();

    await oracle.grantRole(role, authorizedEntity);

    await expect(
      oracle.connect(authorizedEntity).triggerExitsDirectly(exitData, {
        value: 2,
      }),
    )
      .to.be.revertedWithCustomError(oracle, "InsufficientPayment")
      .withArgs(1, 3, 2);
  });

  it("Emit ValidatorExit event and should trigger withdrawals", async () => {
    const tx = await oracle.connect(authorizedEntity).triggerExitsDirectly(exitData, {
      value: 4,
    });
    const timestamp = await oracle.getTime();
    await expect(tx).to.emit(withdrawalVault, "AddFullWithdrawalRequestsCalled").withArgs(exitData.validatorsPubkeys);
    await expect(tx).to.emit(oracle, "MadeRefund").withArgs(anyValue, 1);

    await expect(tx)
      .to.emit(oracle, "DirectExitRequest")
      .withArgs(exitData.stakingModuleId, exitData.nodeOperatorId, pubkeys[0], timestamp);
    await expect(tx)
      .to.emit(oracle, "DirectExitRequest")
      .withArgs(exitData.stakingModuleId, exitData.nodeOperatorId, pubkeys[1], timestamp);
    await expect(tx)
      .to.emit(oracle, "DirectExitRequest")
      .withArgs(exitData.stakingModuleId, exitData.nodeOperatorId, pubkeys[2], timestamp);

    await expect(tx)
      .to.emit(stakingRouter, "Mock__onValidatorExitTriggered")
      .withArgs(exitData.stakingModuleId, exitData.nodeOperatorId, pubkeys[0], 1, 0);

    await expect(tx)
      .to.emit(stakingRouter, "Mock__onValidatorExitTriggered")
      .withArgs(exitData.stakingModuleId, exitData.nodeOperatorId, pubkeys[1], 1, 0);

    await expect(tx)
      .to.emit(stakingRouter, "Mock__onValidatorExitTriggered")
      .withArgs(exitData.stakingModuleId, exitData.nodeOperatorId, pubkeys[2], 1, 0);
  });
});
