import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, PinnedBeaconProxy, StakingVault } from "typechain-types";

import { ether, generateValidator } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLido,
  VaultRoles,
} from "lib/protocol";
import { generatePredepositData, getProofAndDepositData } from "lib/protocol/helpers/vaults";

import { Snapshot } from "test/suite";

describe("Integration: Predeposit Guarantee core functionality", () => {
  let ctx: ProtocolContext;

  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let roles: VaultRoles;
  let proxy: PinnedBeaconProxy;
  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let agent: HardhatEthersSigner;

  let snapshot: string;
  let originalSnapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLido(ctx);

    [owner, nodeOperator, stranger] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, dashboard, roles, proxy } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
    ));

    agent = await ctx.getSigner("agent");
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  beforeEach(async () => {
    expect(await ctx.contracts.vaultHub.isVaultHealthyAsOfLatestReport(stakingVault)).to.equal(true);
  });

  it("PredepositGuarantee is pausable and resumable", async () => {
    const { predepositGuarantee } = ctx.contracts;

    const pdg = predepositGuarantee.connect(agent);

    await pdg.grantRole(await pdg.PAUSE_ROLE(), stranger);
    await pdg.grantRole(await pdg.RESUME_ROLE(), stranger);

    expect(await pdg.isPaused()).to.equal(false);

    await expect(pdg.connect(stranger).pauseFor(1000n)).to.emit(pdg, "Paused");
    expect(await pdg.isPaused()).to.equal(true);

    // Check that the pause is effective e.g. on proveAndDeposit
    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const validator = generateValidator(withdrawalCredentials);

    const { witnesses, postdeposit } = await getProofAndDepositData(
      predepositGuarantee,
      validator,
      withdrawalCredentials,
    );

    await expect(
      predepositGuarantee.connect(nodeOperator).proveAndDeposit(witnesses, [postdeposit], stakingVault),
    ).to.be.revertedWithCustomError(pdg, "ResumedExpected");

    await expect(pdg.connect(stranger).resume()).to.emit(pdg, "Resumed");
    expect(await pdg.isPaused()).to.equal(false);
  });

  describe("Full cycle trustless path through PDG", () => {
    async function commonSteps() {
      const { predepositGuarantee } = ctx.contracts;

      // 1. The stVault's owner supplies 100 ETH to the vault
      await expect(dashboard.connect(roles.funder).fund({ value: ether("100") }))
        .to.emit(stakingVault, "Funded")
        .withArgs(dashboard, ether("100"));

      // 2. Making sure node operator is the guarantor
      expect(await predepositGuarantee.nodeOperatorGuarantor(nodeOperator)).to.equal(await nodeOperator.getAddress());

      // 3. The Node Operator's guarantor tops up 1 ETH to the PDG contract, specifying the Node Operator's address. This serves as the predeposit guarantee collateral.
      //  Method called: PredepositGuarantee.topUpNodeOperatorBalance(nodeOperator) with ETH transfer.
      await expect(
        predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, { value: ether("1") }),
      )
        .to.emit(predepositGuarantee, "BalanceToppedUp")
        .withArgs(nodeOperator, nodeOperator, ether("1"));

      // 4. The Node Operator generates validator keys and predeposit data
      const withdrawalCredentials = await stakingVault.withdrawalCredentials();
      const validator = generateValidator(withdrawalCredentials);

      const predepositData = await generatePredepositData(
        predepositGuarantee,
        dashboard,
        roles,
        nodeOperator,
        validator,
      );

      // 5. The Node Operator predeposits 1 ETH from the vault balance to the validator via the PDG contract.
      //    same time the PDG locks 1 ETH from the Node Operator's guarantee collateral in the PDG.
      await expect(
        predepositGuarantee
          .connect(nodeOperator)
          .predeposit(stakingVault, [predepositData.deposit], [predepositData.depositY]),
      )
        .to.emit(stakingVault, "DepositedToBeaconChain")
        .withArgs(predepositGuarantee, 1, ether("1"))
        .to.emit(predepositGuarantee, "BalanceLocked")
        .withArgs(nodeOperator, ether("2"), ether("1"));

      const { witnesses, postdeposit } = await getProofAndDepositData(
        predepositGuarantee,
        validator,
        withdrawalCredentials,
      );

      // 6. Anyone (permissionless) submits a Merkle proof of the validator's appearing on the Consensus Layer to the PDG contract with the withdrawal credentials corresponding to the stVault's address.
      //    6.1. Upon successful verification, 1 ETH of the Node Operator's guarantee collateral is unlocked from the PDG balance
      //    — making it available for withdrawal or reuse for the next validator predeposit.
      await expect(predepositGuarantee.connect(stranger).proveValidatorWC(witnesses[0]))
        .to.emit(predepositGuarantee, "ValidatorProven")
        .withArgs(witnesses[0].pubkey, nodeOperator, await stakingVault.getAddress(), withdrawalCredentials)
        .to.emit(predepositGuarantee, "BalanceUnlocked")
        .withArgs(nodeOperator, ether("2"), ether("0"));

      // 7. The Node Operator's guarantor withdraws the 1 ETH from the PDG contract or retains it for reuse with future validators.
      const balanceBefore = await ethers.provider.getBalance(nodeOperator);
      await expect(
        predepositGuarantee.connect(nodeOperator).withdrawNodeOperatorBalance(nodeOperator, ether("1"), nodeOperator),
      )
        .to.emit(predepositGuarantee, "BalanceWithdrawn")
        .withArgs(nodeOperator, nodeOperator, ether("1"));
      return { balanceBefore, postdeposit };
    }

    // https://docs.lido.fi/guides/stvaults/pdg#full-cycle-trustless-path-through-pdg
    it("Happy path", async () => {
      const { balanceBefore, postdeposit } = await commonSteps();
      const { predepositGuarantee } = ctx.contracts;

      const balanceAfter = await ethers.provider.getBalance(nodeOperator);
      expect(balanceAfter).to.be.gt(balanceBefore); // Account for gas costs

      // 8. The Node Operator makes a top-up deposit of the remaining 99 ETH from the vault balance to the validator through the PDG.
      //    Method called: PredepositGuarantee.depositToBeaconChain(stakingVault, deposits).
      await expect(predepositGuarantee.connect(nodeOperator).depositToBeaconChain(stakingVault, [postdeposit]))
        .to.emit(stakingVault, "DepositedToBeaconChain")
        .withArgs(predepositGuarantee, 1, ether("31"));
    });

    it("Works with vaults deposit pauses", async () => {
      const { postdeposit } = await commonSteps();
      const { predepositGuarantee } = ctx.contracts;

      // 8. The stVault's owner pauses the vault's deposits.
      await expect(dashboard.connect(roles.depositPauser).pauseBeaconChainDeposits()).to.emit(
        stakingVault,
        "BeaconChainDepositsPaused",
      );

      // 9. The Node Operator tries to deposit the remaining 99 ETH from the vault balance to the validator through the PDG.
      //    This reverts with the "BeaconChainDepositsPaused" error.
      await expect(
        predepositGuarantee.connect(nodeOperator).depositToBeaconChain(stakingVault, [postdeposit]),
      ).to.be.revertedWithCustomError(stakingVault, "BeaconChainDepositsArePaused");

      // 10. The stVault's owner resumes the vault's deposits.
      await expect(dashboard.connect(roles.depositResumer).resumeBeaconChainDeposits()).to.emit(
        stakingVault,
        "BeaconChainDepositsResumed",
      );

      // 11. The Node Operator deposits the remaining 99 ETH from the vault balance to the validator through the PDG.
      await expect(predepositGuarantee.connect(nodeOperator).depositToBeaconChain(stakingVault, [postdeposit]))
        .to.emit(stakingVault, "DepositedToBeaconChain")
        .withArgs(predepositGuarantee, 1, ether("31"));
    });
  });

  // https://docs.lido.fi/guides/stvaults/pdg#pdg-shortcut
  it.skip("PDG shortcut", async () => {
    const { predepositGuarantee } = ctx.contracts;

    // 1. The stVault's owner supplies 100 ETH to the vault.
    await expect(dashboard.connect(roles.funder).fund({ value: ether("100") }))
      .to.emit(stakingVault, "Funded")
      .withArgs(dashboard, ether("100"));

    // 2. The Node Operator generates validator keys and deposit data.
    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const validator = generateValidator(withdrawalCredentials);

    // 3. The Node Operator shares the deposit data with the stVault's owner.
    // (This is a conceptual step, no actual code needed)

    const predepositData = await generatePredepositData(predepositGuarantee, dashboard, roles, nodeOperator, validator);

    //Tracing.enable();

    await dashboard.connect(owner).grantRole(await dashboard.FUND_ROLE(), proxy);

    // todo: I suspect that this report is issued with some data that causes failure in thext method
    await reportVaultDataWithProof(stakingVault);

    // 4. The stVault's owner deposits 1 ETH from the vault balance directly to the validator, bypassing the PDG.
    //    Method called: Dashboard.unguaranteedDepositToBeaconChain(deposits).
    //    4.1. As a result, the stVault's total value is temporarily reduced by 1 ETH until the next oracle report delivered containing the appeared validator's balance.
    // todo: this step fails, BUT this is the point of the test!
    await expect(
      dashboard
        .connect(roles.unguaranteedBeaconChainDepositor)
        .unguaranteedDepositToBeaconChain([predepositData.deposit]),
    )
      .to.emit(stakingVault, "DepositedToBeaconChain")
      .withArgs(dashboard, 1, ether("100"))
      .to.emit(dashboard, "UnguaranteedDeposit");

    const { witnesses, postdeposit } = await getProofAndDepositData(
      predepositGuarantee,
      validator,
      withdrawalCredentials,
    );
    // 5. The stVault's owner submits a Merkle proof of the validator's appearing on the Consensus Layer to the Dashboard contract.
    await expect(dashboard.connect(roles.unknownValidatorProver).proveUnknownValidatorsToPDG([witnesses[0]]))
      .to.emit(predepositGuarantee, "ValidatorProven")
      .withArgs(witnesses[0].pubkey, nodeOperator, await stakingVault.getAddress(), withdrawalCredentials);

    // 6. The Oracle report confirms the validator's balance (1 ETH). The stVault's total value is then increased by 1 ETH accordingly.
    // (This is handled by the protocol, no actual code needed)

    // 7. The Node Operator deposits the remaining 99 ETH from the vault balance to the validator through the PDG.
    await expect(predepositGuarantee.connect(nodeOperator).depositToBeaconChain(stakingVault, [postdeposit]))
      .to.emit(stakingVault, "DepositedToBeaconChain")
      .withArgs(predepositGuarantee, 1, ether("31"));
  });
});
