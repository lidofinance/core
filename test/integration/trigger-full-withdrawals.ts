// ToDo: write test for triggerFullWithdrawals
import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { NodeOperatorsRegistry, StakingRouter, TriggerableWithdrawalsGateway, WithdrawalVault } from "typechain-types";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";

// TODO: update upon TW integrations arrive
describe.skip("TriggerFullWithdrawals Integration", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let triggerableWithdrawalsGateway: TriggerableWithdrawalsGateway;
  let withdrawalVault: WithdrawalVault;
  let stakingRouter: StakingRouter;
  let nor: NodeOperatorsRegistry;
  let authorizedEntity: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let admin: HardhatEthersSigner;

  // Test validator pubkeys (48 bytes each)
  const PUBKEYS = [
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  ];

  // Validator data for triggering full withdrawals
  const validatorData = [
    { stakingModuleId: 1, nodeOperatorId: 0, pubkey: PUBKEYS[0] },
    { stakingModuleId: 1, nodeOperatorId: 1, pubkey: PUBKEYS[1] },
    // { stakingModuleId: 2, nodeOperatorId: 0, pubkey: PUBKEYS[2] },
  ];

  before(async () => {
    ctx = await getProtocolContext();

    [authorizedEntity, stranger, admin] = await ethers.getSigners();

    // Get contract instances from the context
    withdrawalVault = ctx.contracts.withdrawalVault as WithdrawalVault;
    stakingRouter = ctx.contracts.stakingRouter as StakingRouter;
    triggerableWithdrawalsGateway = ctx.contracts.triggerableWithdrawalsGateway as TriggerableWithdrawalsGateway;
    nor = ctx.contracts.nor as NodeOperatorsRegistry;

    // Take a snapshot to restore state after tests
    snapshot = await Snapshot.take();
  });

  beforeEach(bailOnFailure);

  after(async () => await Snapshot.restore(snapshot));

  it("Should properly setup TriggerableWithdrawalsGateway", async () => {
    // Verify that the TriggerableWithdrawalsGateway is properly set up
    const withdrawalVaultAddress = await ctx.contracts.locator.withdrawalVault();
    expect(withdrawalVaultAddress).to.equal(await withdrawalVault.getAddress());

    const stakingRouterAddress = await ctx.contracts.locator.stakingRouter();
    expect(stakingRouterAddress).to.equal(await stakingRouter.getAddress());
  });

  it("Should revert when non-authorized entity tries to trigger full withdrawals", async () => {
    const ADD_FULL_WITHDRAWAL_REQUEST_ROLE = await triggerableWithdrawalsGateway.ADD_FULL_WITHDRAWAL_REQUEST_ROLE();

    // Check if stranger doesn't have permission
    const hasRole = await triggerableWithdrawalsGateway.hasRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE, stranger.address);
    expect(hasRole).to.be.false;

    // Attempt to trigger full withdrawals with unauthorized account
    const withdrawalFee = await withdrawalVault.getWithdrawalRequestFee();
    const totalFee = BigInt(validatorData.length) * withdrawalFee;

    await expect(
      triggerableWithdrawalsGateway
        .connect(stranger)
        .triggerFullWithdrawals(validatorData, ZeroAddress, 0, { value: totalFee }),
    ).to.be.revertedWithCustomError;
  });

  it("Should revert when insufficient fee is provided", async () => {
    // Grant role to authorizedEntity
    const ADD_FULL_WITHDRAWAL_REQUEST_ROLE = await triggerableWithdrawalsGateway.ADD_FULL_WITHDRAWAL_REQUEST_ROLE();
    const agentSigner = await ctx.getSigner("agent");
    await triggerableWithdrawalsGateway
      .connect(agentSigner)
      .grantRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE, authorizedEntity);

    // Ensure authorizedEntity has the role
    const hasRole = await triggerableWithdrawalsGateway.hasRole(
      ADD_FULL_WITHDRAWAL_REQUEST_ROLE,
      authorizedEntity.address,
    );
    expect(hasRole).to.be.true;

    // Get withdrawal fee
    const withdrawalFee = await withdrawalVault.getWithdrawalRequestFee();
    const totalFee = BigInt(validatorData.length) * withdrawalFee;
    const insufficientFee = totalFee - 1n;

    // Try to trigger with insufficient fee
    await expect(
      triggerableWithdrawalsGateway
        .connect(authorizedEntity)
        .triggerFullWithdrawals(validatorData, ZeroAddress, 0, { value: insufficientFee }),
    ).to.be.revertedWithCustomError(triggerableWithdrawalsGateway, "InsufficientFee");
  });

  it("Should successfully trigger full withdrawals", async () => {
    // Setup TW_EXIT_LIMIT_MANAGER_ROLE
    const TW_EXIT_LIMIT_MANAGER_ROLE = await triggerableWithdrawalsGateway.TW_EXIT_LIMIT_MANAGER_ROLE();
    const agent = await ctx.getSigner("agent", ether("1"));

    console.log("Agent address:", agent.address);

    // Grant roles if needed
    const ADD_FULL_WITHDRAWAL_REQUEST_ROLE = await triggerableWithdrawalsGateway.ADD_FULL_WITHDRAWAL_REQUEST_ROLE();
    if (!(await triggerableWithdrawalsGateway.hasRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE, authorizedEntity.address))) {
      await triggerableWithdrawalsGateway.connect(agent).grantRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE, authorizedEntity);
    }

    if (!(await triggerableWithdrawalsGateway.hasRole(TW_EXIT_LIMIT_MANAGER_ROLE, agent.address))) {
      await triggerableWithdrawalsGateway.connect(agent).grantRole(TW_EXIT_LIMIT_MANAGER_ROLE, agent);
    }

    // Configure exit request limits to allow our test
    await triggerableWithdrawalsGateway.connect(agent).setExitRequestLimit(100, 10, 48);

    // Get the withdrawal fee
    const withdrawalFee = await withdrawalVault.getWithdrawalRequestFee();
    const totalFee = BigInt(validatorData.length) * withdrawalFee;

    // Send some extra ETH for refund testing
    const extraAmount = ether("0.01");
    const totalAmount = totalFee + extraAmount;

    // Create a refund recipient
    const refundRecipient = stranger;
    const balanceBefore = await ethers.provider.getBalance(refundRecipient.address);

    // Trigger full withdrawals
    const tx = await triggerableWithdrawalsGateway
      .connect(authorizedEntity)
      .triggerFullWithdrawals(validatorData, refundRecipient.address, 0, { value: totalAmount });
    await expect(tx).to.emit(withdrawalVault, "WithdrawalRequestAdded");
    // check notification of 1 module
    await expect(tx).to.emit(nor, "ValidatorExitTriggered");

    // Check refund was processed
    const balanceAfter = await ethers.provider.getBalance(refundRecipient.address);
    expect(balanceAfter).to.equal(balanceBefore + extraAmount);

    // Verify exit limits were consumed
    const exitLimitInfo = await triggerableWithdrawalsGateway.getExitRequestLimitFullInfo();
    const currentExitRequestsLimit = exitLimitInfo[4]; // currentExitRequestsLimit
    expect(currentExitRequestsLimit).to.equal(100n - BigInt(validatorData.length));
  });

  it("Should successfully trigger full withdrawals with fee refund to sender", async () => {
    // Get the withdrawal fee
    const withdrawalFee = await withdrawalVault.getWithdrawalRequestFee();
    const totalFee = BigInt(validatorData.length) * withdrawalFee;

    // Send some extra ETH for refund testing
    const extraAmount = ether("0.01");
    const totalAmount = totalFee + extraAmount;

    // Get sender balance before transaction
    const balanceBefore = await ethers.provider.getBalance(authorizedEntity.address);

    // Trigger full withdrawals with refund to sender (ZeroAddress means refund to sender)
    const tx = await triggerableWithdrawalsGateway
      .connect(authorizedEntity)
      .triggerFullWithdrawals(validatorData, ZeroAddress, 0, { value: totalAmount });
    await expect(tx).to.emit(withdrawalVault, "WithdrawalRequestAdded");
    // check notification of 1 module
    await expect(tx).to.emit(nor, "ValidatorExitTriggered");

    // Get gas costs
    const receipt = await tx.wait();
    const gasCost = BigInt(receipt!.gasUsed * receipt!.gasPrice);

    // Check balance after (should be: initial - gas - totalFee)
    const balanceAfter = await ethers.provider.getBalance(authorizedEntity.address);
    expect(balanceAfter).to.be.approximately(balanceBefore - gasCost - totalFee, 10n ** 10n);
  });

  it("Should reject new withdrawal requests when gateway is paused", async () => {
    // Setup PAUSE_ROLE and RESUME_ROLE
    const PAUSE_ROLE = await triggerableWithdrawalsGateway.PAUSE_ROLE();
    const RESUME_ROLE = await triggerableWithdrawalsGateway.RESUME_ROLE();

    const agentSigner = await ctx.getSigner("agent");

    // Grant roles to admin if not already granted
    if (!(await triggerableWithdrawalsGateway.hasRole(PAUSE_ROLE, admin.address))) {
      await triggerableWithdrawalsGateway.connect(agentSigner).grantRole(PAUSE_ROLE, admin);
    }

    if (!(await triggerableWithdrawalsGateway.hasRole(RESUME_ROLE, admin.address))) {
      await triggerableWithdrawalsGateway.connect(agentSigner).grantRole(RESUME_ROLE, admin);
    }

    // Pause the contract
    await triggerableWithdrawalsGateway.connect(admin).pauseFor(1000);

    // Verify contract is paused
    expect(await triggerableWithdrawalsGateway.isPaused()).to.be.true;

    // Try to trigger withdrawals when paused
    const withdrawalFee = await withdrawalVault.getWithdrawalRequestFee();
    const totalFee = BigInt(validatorData.length) * withdrawalFee;

    await expect(
      triggerableWithdrawalsGateway
        .connect(authorizedEntity)
        .triggerFullWithdrawals(validatorData, ZeroAddress, 0, { value: totalFee }),
    ).to.be.revertedWithCustomError(triggerableWithdrawalsGateway, "ResumedExpected");

    // Resume the contract
    await triggerableWithdrawalsGateway.connect(admin).resume();

    // Verify contract is no longer paused
    expect(await triggerableWithdrawalsGateway.isPaused()).to.be.false;

    // Trigger withdrawals should now work
    const tx = await triggerableWithdrawalsGateway
      .connect(authorizedEntity)
      .triggerFullWithdrawals(validatorData, ZeroAddress, 0, { value: totalFee });

    await expect(tx).to.emit(withdrawalVault, "WithdrawalRequestAdded");

    // check notification of 1 module
    await expect(tx).to.emit(nor, "ValidatorExitTriggered");
  });
});
