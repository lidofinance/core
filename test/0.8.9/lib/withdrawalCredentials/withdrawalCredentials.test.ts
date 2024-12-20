import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { WithdrawalCredentials_Harness, WithdrawalsPredeployed_Mock } from "typechain-types";

import { Snapshot } from "test/suite";

import {
  deployWithdrawalsPredeployedMock,
  testFullWithdrawalRequestBehavior,
  testPartialWithdrawalRequestBehavior,
} from "./withdrawalRequests.behavior";

describe("WithdrawalCredentials.sol", () => {
  let actor: HardhatEthersSigner;

  let withdrawalsPredeployed: WithdrawalsPredeployed_Mock;
  let withdrawalCredentials: WithdrawalCredentials_Harness;

  let originalState: string;

  before(async () => {
    [actor] = await ethers.getSigners();

    withdrawalsPredeployed = await deployWithdrawalsPredeployedMock();
    withdrawalCredentials = await ethers.deployContract("WithdrawalCredentials_Harness");
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  testFullWithdrawalRequestBehavior(
    () => withdrawalCredentials.connect(actor),
    () => withdrawalsPredeployed.connect(actor),
  );

  testPartialWithdrawalRequestBehavior(
    () => withdrawalCredentials.connect(actor),
    () => withdrawalsPredeployed.connect(actor),
  );
});
