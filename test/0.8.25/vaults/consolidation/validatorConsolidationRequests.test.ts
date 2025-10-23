import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Dashboard__Mock,
  EIP7251MaxEffectiveBalanceRequest__Mock,
  LidoLocator,
  ValidatorConsolidationRequests,
  VaultHub__MockForDashboard,
} from "typechain-types";

import { deployEIP7251MaxEffectiveBalanceRequestContract, DISCONNECT_NOT_INITIATED, EIP7251_ADDRESS, ether } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

import { generateConsolidationRequestPayload } from "./consolidationHelper";

const PUBKEY = "0x800276cfb86f1c08a1e7238c76a9ca45d5528d2072e51500b343266203d5d7794e6fc848ce7948e9c81960f71f821b42";
const KEY_LENGTH = 48;

describe("ValidatorConsolidationRequests.sol", () => {
  let actor: HardhatEthersSigner;
  let consolidationRequestPredeployed: EIP7251MaxEffectiveBalanceRequest__Mock;
  let validatorConsolidationRequests: ValidatorConsolidationRequests;
  let dashboard: Dashboard__Mock;
  let dashboardAddress: string;
  let originalState: string;
  let locator: LidoLocator;
  let vaultHub: VaultHub__MockForDashboard;
  let stakingVault: HardhatEthersSigner;

  before(async () => {
    [actor, stakingVault] = await ethers.getSigners();

    // Set a high balance for the actor account
    await setBalance(actor.address, ether("1000000"));

    dashboard = await ethers.deployContract("Dashboard__Mock");
    dashboardAddress = await dashboard.getAddress();

    consolidationRequestPredeployed = await deployEIP7251MaxEffectiveBalanceRequestContract(1n);
    vaultHub = await ethers.deployContract("VaultHub__MockForDashboard", [ethers.ZeroAddress, ethers.ZeroAddress]);

    await dashboard.mock__setStakingVault(stakingVault);
    await vaultHub.mock__setVaultConnection(stakingVault, {
      owner: dashboardAddress,
      shareLimit: 0,
      vaultIndex: 1,
      disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
      reserveRatioBP: 0,
      forcedRebalanceThresholdBP: 0,
      infraFeeBP: 0,
      liquidityFeeBP: 0,
      reservationFeeBP: 0,
      beaconChainDepositsPauseIntent: false,
    });
    await vaultHub.mock__setPendingDisconnect(false);

    locator = await deployLidoLocator({
      vaultHub: vaultHub,
    });
    validatorConsolidationRequests = await ethers.deployContract("ValidatorConsolidationRequests", [locator]);

    expect(await consolidationRequestPredeployed.getAddress()).to.equal(EIP7251_ADDRESS);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("eip 7251 max effective balance request contract", () => {
    it("Should return the address of the EIP 7251 max effective balance request contract", async function () {
      expect(await validatorConsolidationRequests.CONSOLIDATION_REQUEST_PREDEPLOY_ADDRESS()).to.equal(EIP7251_ADDRESS);
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
      it(`Should revert if unexpected fee value ${unexpectedFee} is returned`, async function () {
        await consolidationRequestPredeployed.mock__setFeeRaw(unexpectedFee);

        await expect(validatorConsolidationRequests.getConsolidationRequestFee()).to.be.revertedWithCustomError(
          validatorConsolidationRequests,
          "ConsolidationFeeInvalidData",
        );
      });
    });
  });

  context("get consolidation requests and adjustment increase encoded calls", () => {
    it("Should revert if empty parameters are provided", async function () {
      await expect(
        validatorConsolidationRequests.getConsolidationRequestsAndFeeExemptionEncodedCalls([], [], dashboardAddress, 0),
      )
        .to.be.revertedWithCustomError(validatorConsolidationRequests, "ZeroArgument")
        .withArgs("sourcePubkeys");

      await expect(
        validatorConsolidationRequests.getConsolidationRequestsAndFeeExemptionEncodedCalls(
          [PUBKEY],
          [],
          dashboardAddress,
          0,
        ),
      )
        .to.be.revertedWithCustomError(validatorConsolidationRequests, "ZeroArgument")
        .withArgs("targetPubkeys");

      await expect(
        validatorConsolidationRequests.getConsolidationRequestsAndFeeExemptionEncodedCalls(
          [PUBKEY],
          [PUBKEY],
          ethers.ZeroAddress,
          0,
        ),
      )
        .to.be.revertedWithCustomError(validatorConsolidationRequests, "ZeroArgument")
        .withArgs("dashboard");
    });
  });

  it("getConsolidationRequestsAndFeeExemptionEncodedCalls should revert if vault is not connected", async function () {
    // index is 0
    await vaultHub.mock__setVaultConnection(stakingVault, {
      owner: dashboardAddress,
      shareLimit: 0,
      vaultIndex: 0,
      disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
      reserveRatioBP: 0,
      forcedRebalanceThresholdBP: 0,
      infraFeeBP: 0,
      liquidityFeeBP: 0,
      reservationFeeBP: 0,
      beaconChainDepositsPauseIntent: false,
    });
    await vaultHub.mock__setPendingDisconnect(false);

    await expect(
      validatorConsolidationRequests.getConsolidationRequestsAndFeeExemptionEncodedCalls(
        [PUBKEY],
        [PUBKEY],
        dashboardAddress,
        1n,
      ),
    ).to.be.revertedWithCustomError(validatorConsolidationRequests, "VaultNotConnected");

    // pending disconnect is true
    await vaultHub.mock__setVaultConnection(stakingVault, {
      owner: dashboardAddress,
      shareLimit: 0,
      vaultIndex: 1,
      disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
      reserveRatioBP: 0,
      forcedRebalanceThresholdBP: 0,
      infraFeeBP: 0,
      liquidityFeeBP: 0,
      reservationFeeBP: 0,
      beaconChainDepositsPauseIntent: false,
    });
    await vaultHub.mock__setPendingDisconnect(true);

    await expect(
      validatorConsolidationRequests.getConsolidationRequestsAndFeeExemptionEncodedCalls(
        [PUBKEY],
        [PUBKEY],
        dashboardAddress,
        1n,
      ),
    ).to.be.revertedWithCustomError(validatorConsolidationRequests, "VaultNotConnected");

    // owner is not the dashboard
    await vaultHub.mock__setVaultConnection(stakingVault, {
      owner: actor.address,
      shareLimit: 0,
      vaultIndex: 1,
      disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
      reserveRatioBP: 0,
      forcedRebalanceThresholdBP: 0,
      infraFeeBP: 0,
      liquidityFeeBP: 0,
      reservationFeeBP: 0,
      beaconChainDepositsPauseIntent: false,
    });
    await vaultHub.mock__setPendingDisconnect(false);

    await expect(
      validatorConsolidationRequests.getConsolidationRequestsAndFeeExemptionEncodedCalls(
        [PUBKEY],
        [PUBKEY],
        dashboardAddress,
        1n,
      ),
    ).to.be.revertedWithCustomError(validatorConsolidationRequests, "DashboardNotOwnerOfStakingVault");
  });

  it("getConsolidationRequestsAndFeeExemptionEncodedCalls should revert if array lengths do not match", async function () {
    await expect(
      validatorConsolidationRequests.getConsolidationRequestsAndFeeExemptionEncodedCalls(
        [PUBKEY],
        [PUBKEY, PUBKEY],
        dashboardAddress,
        1n,
      ),
    )
      .to.be.revertedWithCustomError(validatorConsolidationRequests, "MismatchingSourceAndTargetPubkeysCount")
      .withArgs(1, 2);
  });

  it("getConsolidationRequestsAndFeeExemptionEncodedCalls should revert if the adjustment increase is less than the minimum validator balance", async function () {
    const requestCount = 2;
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount } = generateConsolidationRequestPayload(requestCount);

    await expect(
      validatorConsolidationRequests.getConsolidationRequestsAndFeeExemptionEncodedCalls(
        sourcePubkeys,
        targetPubkeys,
        dashboardAddress,
        BigInt(totalSourcePubkeysCount) * ether("16") - 1n,
      ),
    ).to.be.revertedWithCustomError(validatorConsolidationRequests, "InvalidAllSourceValidatorBalancesWei");
  });

  it("Should get correct encoded calls for consolidation requests and fee exemption", async function () {
    const { sourcePubkeys, targetPubkeys, adjustmentIncrease } = generateConsolidationRequestPayload(1);
    const { feeExemptionEncodedCall, consolidationRequestEncodedCalls } =
      await validatorConsolidationRequests.getConsolidationRequestsAndFeeExemptionEncodedCalls(
        sourcePubkeys,
        targetPubkeys,
        dashboardAddress,
        adjustmentIncrease,
      );
    let k = 0;
    for (let i = 0; i < targetPubkeys.length; i++) {
      const sourcePubkeysCount = sourcePubkeys[i].length / KEY_LENGTH;
      for (let j = 0; j < sourcePubkeysCount; j++) {
        const targetPubkey = targetPubkeys[i];
        const sourcePubkey = sourcePubkeys[i].slice(j * KEY_LENGTH, (j + 1) * KEY_LENGTH);
        const concatenatedKeys = ethers.hexlify(sourcePubkey) + ethers.hexlify(targetPubkey).slice(2);
        expect(consolidationRequestEncodedCalls[k]).to.equal(concatenatedKeys);
        expect(consolidationRequestEncodedCalls[k].length).to.equal(2 + KEY_LENGTH * 2 + KEY_LENGTH * 2);
        k++;
      }
    }
    const iface = new ethers.Interface(["function addFeeExemption(uint256)"]);
    const calldata = iface.encodeFunctionData("addFeeExemption", [adjustmentIncrease]);
    expect(feeExemptionEncodedCall).to.equal(calldata);
  });
});
