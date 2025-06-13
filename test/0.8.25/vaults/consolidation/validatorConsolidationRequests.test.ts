import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Dashboard__Mock,
  DelegateCaller,
  EIP7251MaxEffectiveBalanceRequest__Mock,
  LidoLocator,
  ValidatorConsolidationRequests,
  VaultHub__MockForDashboard,
} from "typechain-types";

import { ether } from "lib";
import { deployEIP7251MaxEffectiveBalanceRequestContract, EIP7251_ADDRESS } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

import { generateConsolidationRequestPayload } from "./consolidation_utils";
import { findDashboardMockEvents, findEIP7251MockEvents, testEIP7251Mock } from "./eip7251Mock";

const EMPTY_PUBKEYS = "0x";
const KEY_LENGTH = 48;

describe("ValidatorConsolidationRequests.sol", () => {
  let actor: HardhatEthersSigner;
  let receiver: HardhatEthersSigner;
  let stakingVault: HardhatEthersSigner;

  let consolidationRequestPredeployed: EIP7251MaxEffectiveBalanceRequest__Mock;
  let validatorConsolidationRequestsAddress: string;
  let validatorConsolidationRequests: ValidatorConsolidationRequests;
  let dashboard: Dashboard__Mock;
  let dashboardAddress: string;
  let originalState: string;
  let locator: LidoLocator;
  let vaultHub: VaultHub__MockForDashboard;
  let delegateCaller: DelegateCaller;

  async function getConsolidationRequestPredeployedContractBalance(): Promise<bigint> {
    const contractAddress = await consolidationRequestPredeployed.getAddress();
    return await ethers.provider.getBalance(contractAddress);
  }

  before(async () => {
    [actor, receiver, stakingVault] = await ethers.getSigners();

    // Set a high balance for the actor account
    await setBalance(actor.address, ether("1000000"));

    delegateCaller = await ethers.deployContract("DelegateCaller", [], { from: actor });
    consolidationRequestPredeployed = await deployEIP7251MaxEffectiveBalanceRequestContract(1n);
    vaultHub = await ethers.deployContract("VaultHub__MockForDashboard", [ethers.ZeroAddress, ethers.ZeroAddress]);
    await vaultHub.mock__setVaultConnection(stakingVault.address, {
      owner: actor.address,
      shareLimit: 0,
      vaultIndex: 1,
      pendingDisconnect: false,
      reserveRatioBP: 0,
      forcedRebalanceThresholdBP: 0,
      infraFeeBP: 0,
      liquidityFeeBP: 0,
      reservationFeeBP: 0,
    });

    locator = await deployLidoLocator({
      vaultHub: vaultHub,
    });
    validatorConsolidationRequests = await ethers.deployContract("ValidatorConsolidationRequests", [locator]);
    validatorConsolidationRequestsAddress = await validatorConsolidationRequests.getAddress();
    dashboard = await ethers.deployContract("Dashboard__Mock");
    dashboardAddress = await dashboard.getAddress();
    await dashboard.mock__setStakingVault(stakingVault.address);
    expect(await consolidationRequestPredeployed.getAddress()).to.equal(EIP7251_ADDRESS);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  async function getFee(): Promise<bigint> {
    return await validatorConsolidationRequests.getConsolidationRequestFee();
  }

  context("eip 7251 max effective balance request contract", () => {
    it("Should return the address of the EIP 7251 max effective balance request contract", async function () {
      expect(await validatorConsolidationRequests.CONSOLIDATION_REQUEST_PREDEPLOY_ADDRESS()).to.equal(EIP7251_ADDRESS);
    });
    it("Should THIS point to contract address", async function () {
      expect(await validatorConsolidationRequests.THIS()).to.equal(validatorConsolidationRequestsAddress);
    });
  });

  context("get consolidation request fee", () => {
    it("Should get fee from the EIP 7251 max effective balance request contract", async function () {
      await consolidationRequestPredeployed.mock__setFee(333n);
      expect(await validatorConsolidationRequests.getConsolidationRequestFee()).to.equal(333n);
    });

    it("Should revert if fee read fails", async function () {
      await consolidationRequestPredeployed.mock__setFailOnGetFee(true);
      await expect(validatorConsolidationRequests.getConsolidationRequestFee()).to.be.revertedWithCustomError(
        validatorConsolidationRequests,
        "ConsolidationFeeReadFailed",
      );
    });

    ["0x", "0x01", "0x" + "0".repeat(61) + "1", "0x" + "0".repeat(65) + "1"].forEach((unexpectedFee) => {
      it(`Shoud revert if unexpected fee value ${unexpectedFee} is returned`, async function () {
        await consolidationRequestPredeployed.mock__setFeeRaw(unexpectedFee);

        await expect(validatorConsolidationRequests.getConsolidationRequestFee()).to.be.revertedWithCustomError(
          validatorConsolidationRequests,
          "ConsolidationFeeInvalidData",
        );
      });
    });
  });

  context("add consolidation requests", () => {
    it("Should revert if empty parameters are provided", async function () {
      await expect(
        delegateCaller.callDelegate(
          validatorConsolidationRequestsAddress,
          validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
            [],
            [],
            receiver.address,
            dashboardAddress,
            0,
          ]),
        ),
      )
        .to.be.revertedWithCustomError(validatorConsolidationRequests, "ZeroArgument")
        .withArgs("msg.value");

      await expect(
        delegateCaller.callDelegate(
          validatorConsolidationRequestsAddress,
          validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
            [],
            [],
            receiver.address,
            dashboardAddress,
            0,
          ]),
          { value: 1n },
        ),
      )
        .to.be.revertedWithCustomError(validatorConsolidationRequests, "ZeroArgument")
        .withArgs("sourcePubkeys");

      await expect(
        delegateCaller.callDelegate(
          validatorConsolidationRequestsAddress,
          validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
            [EMPTY_PUBKEYS],
            [],
            receiver.address,
            dashboardAddress,
            0,
          ]),
          { value: 1n },
        ),
      )
        .to.be.revertedWithCustomError(validatorConsolidationRequests, "ZeroArgument")
        .withArgs("targetPubkeys");

      await expect(
        delegateCaller.callDelegate(
          validatorConsolidationRequestsAddress,
          validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
            [EMPTY_PUBKEYS],
            [EMPTY_PUBKEYS],
            receiver.address,
            ethers.ZeroAddress,
            0,
          ]),
          { value: 1n },
        ),
      )
        .to.be.revertedWithCustomError(validatorConsolidationRequests, "ZeroArgument")
        .withArgs("dashboard");
    });
  });

  it("Should revert if called from non-delegatecall", async function () {
    await expect(
      validatorConsolidationRequests.addConsolidationRequests(
        [EMPTY_PUBKEYS],
        [EMPTY_PUBKEYS],
        receiver.address,
        dashboard,
        1n,
        { value: 1n },
      ),
    ).to.be.revertedWithCustomError(validatorConsolidationRequests, "NotDelegateCall");
  });

  it("Should revert if vault is not connected", async function () {
    await vaultHub.mock__setVaultConnection(stakingVault.address, {
      owner: actor.address,
      shareLimit: 0,
      vaultIndex: 0,
      pendingDisconnect: false,
      reserveRatioBP: 0,
      forcedRebalanceThresholdBP: 0,
      infraFeeBP: 0,
      liquidityFeeBP: 0,
      reservationFeeBP: 0,
    });

    await expect(
      delegateCaller.callDelegate(
        validatorConsolidationRequestsAddress,
        validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
          [EMPTY_PUBKEYS],
          [EMPTY_PUBKEYS],
          receiver.address,
          dashboardAddress,
          1n,
        ]),
        { value: 1n },
      ),
    ).to.be.revertedWithCustomError(validatorConsolidationRequests, "VaultNotConnected");

    await vaultHub.mock__setVaultConnection(stakingVault.address, {
      owner: actor.address,
      shareLimit: 0,
      vaultIndex: 1,
      pendingDisconnect: true,
      reserveRatioBP: 0,
      forcedRebalanceThresholdBP: 0,
      infraFeeBP: 0,
      liquidityFeeBP: 0,
      reservationFeeBP: 0,
    });

    await expect(
      delegateCaller.callDelegate(
        validatorConsolidationRequestsAddress,
        validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
          [EMPTY_PUBKEYS],
          [EMPTY_PUBKEYS],
          receiver.address,
          await dashboard.getAddress(),
          1n,
        ]),
        { value: 1n },
      ),
    ).to.be.revertedWithCustomError(validatorConsolidationRequests, "VaultNotConnected");
  });

  it("Should revert if array lengths do not match", async function () {
    await expect(
      delegateCaller.callDelegate(
        validatorConsolidationRequestsAddress,
        validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
          [EMPTY_PUBKEYS],
          [EMPTY_PUBKEYS, EMPTY_PUBKEYS],
          receiver.address,
          dashboardAddress,
          1n,
        ]),
        { value: 1n },
      ),
    )
      .to.be.revertedWithCustomError(validatorConsolidationRequests, "MismatchingSourceAndTargetPubkeysCount")
      .withArgs(1, 2);
  });

  it("Should revert if not enough fee is sent", async function () {
    const { sourcePubkeys, targetPubkeys, adjustmentIncrease } = generateConsolidationRequestPayload(1);

    await consolidationRequestPredeployed.mock__setFee(3n); // Set fee to 3 gwei

    const insufficientFee = 2n;
    await expect(
      delegateCaller.callDelegate(
        validatorConsolidationRequestsAddress,
        validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
          sourcePubkeys,
          targetPubkeys,
          receiver.address,
          dashboardAddress,
          adjustmentIncrease,
        ]),
        { value: insufficientFee },
      ),
    ).to.be.revertedWithCustomError(validatorConsolidationRequests, "InsufficientValidatorConsolidationFee");
  });

  it("Should revert if pubkey is not 48 bytes", async function () {
    // Invalid pubkey (only 2 bytes)
    const invalidPubkeyHexString = "0x1234";
    const { sourcePubkeys, targetPubkeys, adjustmentIncrease } = generateConsolidationRequestPayload(1);

    const fee = await getFee();

    await expect(
      delegateCaller.callDelegate(
        validatorConsolidationRequestsAddress,
        validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
          [invalidPubkeyHexString],
          targetPubkeys,
          receiver.address,
          dashboardAddress,
          adjustmentIncrease,
        ]),
        { value: fee },
      ),
    ).to.be.revertedWithCustomError(validatorConsolidationRequests, "MalformedPubkeysArray");

    await expect(
      delegateCaller.callDelegate(
        validatorConsolidationRequestsAddress,
        validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
          sourcePubkeys,
          [invalidPubkeyHexString],
          receiver.address,
          dashboardAddress,
          adjustmentIncrease,
        ]),
        { value: fee },
      ),
    ).to.be.revertedWithCustomError(validatorConsolidationRequests, "MalformedTargetPubkey");
  });

  it("Should revert if last pubkey not 48 bytes", async function () {
    const validPubey =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f";
    const invalidPubkey = "1234";
    const sourcePubkeys = [`0x${validPubey}${invalidPubkey}`];
    const { targetPubkeys, adjustmentIncrease } = generateConsolidationRequestPayload(1);

    const fee = await getFee();

    await expect(
      delegateCaller.callDelegate(
        validatorConsolidationRequestsAddress,
        validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
          sourcePubkeys,
          targetPubkeys,
          receiver.address,
          dashboardAddress,
          adjustmentIncrease,
        ]),
        { value: fee },
      ),
    ).to.be.revertedWithCustomError(validatorConsolidationRequests, "MalformedPubkeysArray");
  });

  it("Should revert if addition fails at the consolidation request contract", async function () {
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount, adjustmentIncrease } =
      generateConsolidationRequestPayload(1);

    const fee = (await getFee()) * BigInt(totalSourcePubkeysCount);

    // Set mock to fail on add
    await consolidationRequestPredeployed.mock__setFailOnAddRequest(true);

    await expect(
      delegateCaller.callDelegate(
        validatorConsolidationRequestsAddress,
        validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
          sourcePubkeys,
          targetPubkeys,
          receiver.address,
          dashboardAddress,
          adjustmentIncrease,
        ]),
        { value: fee },
      ),
    ).to.be.revertedWithCustomError(validatorConsolidationRequests, "ConsolidationRequestAdditionFailed");
  });

  it("Should revert when balance is less than total consolidation fee", async function () {
    const keysCount = 2;
    const fee = 10n;
    const balance = 19n;

    const { sourcePubkeys, targetPubkeys, adjustmentIncrease } = generateConsolidationRequestPayload(keysCount);

    await consolidationRequestPredeployed.mock__setFee(fee);
    await setBalance(await validatorConsolidationRequests.getAddress(), balance);

    await expect(
      delegateCaller.callDelegate(
        validatorConsolidationRequestsAddress,
        validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
          sourcePubkeys,
          targetPubkeys,
          receiver.address,
          dashboardAddress,
          adjustmentIncrease,
        ]),
        { value: fee },
      ),
    ).to.be.revertedWithCustomError(validatorConsolidationRequests, "InsufficientValidatorConsolidationFee");
  });

  it("Should accept consolidation requests when the provided fee matches the exact required amount", async function () {
    const requestCount = 1;
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount, adjustmentIncrease } =
      generateConsolidationRequestPayload(requestCount);

    const fee = 3n;
    await consolidationRequestPredeployed.mock__setFee(fee);

    await testEIP7251Mock(
      () =>
        delegateCaller.callDelegate(
          validatorConsolidationRequestsAddress,
          validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
            sourcePubkeys,
            targetPubkeys,
            receiver.address,
            dashboardAddress,
            adjustmentIncrease,
          ]),
          { value: fee * BigInt(totalSourcePubkeysCount) },
        ),
      await delegateCaller.getAddress(),
      sourcePubkeys,
      targetPubkeys,
      fee,
    );

    // Check extremely high fee
    const highFee = ether("10");
    await consolidationRequestPredeployed.mock__setFee(highFee);

    await testEIP7251Mock(
      () =>
        delegateCaller.callDelegate(
          validatorConsolidationRequestsAddress,
          validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
            sourcePubkeys,
            targetPubkeys,
            receiver.address,
            dashboardAddress,
            adjustmentIncrease,
          ]),
          { value: highFee * BigInt(totalSourcePubkeysCount) },
        ),
      await delegateCaller.getAddress(),
      sourcePubkeys,
      targetPubkeys,
      highFee,
    );
  });

  it("Should accept consolidation requests when the provided fee exceeds the required amount", async function () {
    const requestCount = 1;
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount, adjustmentIncrease } =
      generateConsolidationRequestPayload(requestCount);

    await consolidationRequestPredeployed.mock__setFee(3n);
    const excessFee = 4n;

    await testEIP7251Mock(
      () =>
        delegateCaller.callDelegate(
          validatorConsolidationRequestsAddress,
          validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
            sourcePubkeys,
            targetPubkeys,
            receiver.address,
            dashboardAddress,
            adjustmentIncrease,
          ]),
          { value: excessFee * BigInt(totalSourcePubkeysCount) },
        ),
      await delegateCaller.getAddress(),
      sourcePubkeys,
      targetPubkeys,
      3n,
    );

    // Check when the provided fee extremely exceeds the required amount
    const extremelyHighFee = ether("10");
    await setBalance(
      await validatorConsolidationRequests.getAddress(),
      extremelyHighFee * BigInt(totalSourcePubkeysCount),
    );

    await testEIP7251Mock(
      () =>
        delegateCaller.callDelegate(
          validatorConsolidationRequestsAddress,
          validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
            sourcePubkeys,
            targetPubkeys,
            receiver.address,
            dashboardAddress,
            adjustmentIncrease,
          ]),
          { value: extremelyHighFee * BigInt(totalSourcePubkeysCount) },
        ),
      await delegateCaller.getAddress(),
      sourcePubkeys,
      targetPubkeys,
      3n,
    );
  });

  it("Should correctly deduct the exact fee amount from the contract balance", async function () {
    const requestCount = 3;
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount, adjustmentIncrease } =
      generateConsolidationRequestPayload(requestCount);

    const fee = 4n;
    await consolidationRequestPredeployed.mock__setFee(fee);

    const expectedTotalConsolidationFee = fee * BigInt(totalSourcePubkeysCount);
    const initialBalance = await ethers.provider.getBalance(actor.address);
    const tx = await delegateCaller.callDelegate(
      validatorConsolidationRequestsAddress,
      validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
        sourcePubkeys,
        targetPubkeys,
        receiver.address,
        dashboardAddress,
        adjustmentIncrease,
      ]),
      { value: expectedTotalConsolidationFee },
    );
    const receipt = await tx.wait();

    if (!receipt) {
      expect(false).to.equal(true);
    }

    const gasUsed = receipt!.gasUsed;
    const gasPrice = receipt!.gasPrice;
    const totalCost = BigInt(gasUsed) * gasPrice + expectedTotalConsolidationFee;

    expect(await ethers.provider.getBalance(actor.address)).to.equal(initialBalance - totalCost);
  });

  it("Should transfer the total calculated fee to the EIP-7251 consolidation request contract", async function () {
    const requestCount = 3;
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount, adjustmentIncrease } =
      generateConsolidationRequestPayload(requestCount);

    const fee = 3n;
    await consolidationRequestPredeployed.mock__setFee(fee);
    const expectedTotalConsolidationFee = fee * BigInt(totalSourcePubkeysCount);
    const initialBalance = await getConsolidationRequestPredeployedContractBalance();
    await delegateCaller.callDelegate(
      validatorConsolidationRequestsAddress,
      validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
        sourcePubkeys,
        targetPubkeys,
        receiver.address,
        dashboardAddress,
        adjustmentIncrease,
      ]),
      { value: expectedTotalConsolidationFee },
    );
    expect(await getConsolidationRequestPredeployedContractBalance()).to.equal(
      initialBalance + expectedTotalConsolidationFee,
    );
  });

  it("Should ensure consolidation requests are encoded as expected with two 48-byte pubkeys", async function () {
    const requestCount = 16;
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount, adjustmentIncrease } =
      generateConsolidationRequestPayload(requestCount);

    const fee = 3n;
    await consolidationRequestPredeployed.mock__setFee(fee);
    const expectedTotalConsolidationFee = fee * BigInt(totalSourcePubkeysCount);

    const tx = await delegateCaller.callDelegate(
      validatorConsolidationRequestsAddress,
      validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
        sourcePubkeys,
        targetPubkeys,
        receiver.address,
        dashboardAddress,
        adjustmentIncrease,
      ]),
      { value: expectedTotalConsolidationFee },
    );
    const receipt = await tx.wait();

    const events = findEIP7251MockEvents(receipt!);
    expect(events.length).to.equal(totalSourcePubkeysCount);

    for (let i = 0; i < requestCount; i++) {
      const pubkeysCount = Math.floor(sourcePubkeys[i].length / KEY_LENGTH);
      for (let j = 0; j < pubkeysCount; j++) {
        const expectedSourcePubkey = sourcePubkeys[i].slice(j * KEY_LENGTH, (j + 1) * KEY_LENGTH);
        const encodedRequest = events[i * pubkeysCount + j].args[0];

        expect(encodedRequest.length).to.equal(2 + KEY_LENGTH * 2 + KEY_LENGTH * 2);

        expect(encodedRequest.slice(0, 2)).to.equal("0x");
        const sourcePubkeyFromEvent = "0x" + encodedRequest.slice(2, KEY_LENGTH * 2 + 2);
        expect(sourcePubkeyFromEvent).to.equal(ethers.hexlify(expectedSourcePubkey));

        const targetPubkeyFromEvent = "0x" + encodedRequest.slice(KEY_LENGTH * 2 + 2, KEY_LENGTH * 4 + 2);
        expect(targetPubkeyFromEvent).to.equal(ethers.hexlify(targetPubkeys[i]));
      }
    }
  });

  it("Should ensure the dashboard is called with the correct adjustment increases", async function () {
    const requestCount = 3;
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount, adjustmentIncrease } =
      generateConsolidationRequestPayload(requestCount);

    const fee = 3n;
    await consolidationRequestPredeployed.mock__setFee(fee);

    const tx = await delegateCaller.callDelegate(
      validatorConsolidationRequestsAddress,
      validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
        sourcePubkeys,
        targetPubkeys,
        receiver.address,
        dashboardAddress,
        adjustmentIncrease,
      ]),
      { value: fee * BigInt(totalSourcePubkeysCount) },
    );
    const receipt = await tx.wait();

    const events = findDashboardMockEvents(receipt!);
    expect(events.length).to.equal(1);
    expect(events[0].args._amount).to.equal(adjustmentIncrease);
  });
});
