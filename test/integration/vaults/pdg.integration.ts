import { expect } from "chai";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, DepositContract, PinnedBeaconProxy, StakingVault } from "typechain-types";

import {
  addressToWC,
  ether,
  generatePredeposit,
  generateValidator,
  ONE_ETHER,
  PDGPolicy,
  toGwei,
  toLittleEndian64,
} from "lib";
import {
  createVaultWithDashboard,
  generatePredepositData,
  getProofAndDepositData,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: Predeposit Guarantee core functionality", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let stakingVault: StakingVault;
  let depositContract: DepositContract;
  let dashboard: Dashboard;
  let proxy: PinnedBeaconProxy;
  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let guarantor: HardhatEthersSigner;
  let agent: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    [owner, nodeOperator, stranger, guarantor] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, dashboard, proxy } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
    ));

    agent = await ctx.getSigner("agent");

    depositContract = await ethers.getContractAt("DepositContract", await stakingVault.DEPOSIT_CONTRACT());
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  beforeEach(async () => {
    expect(await ctx.contracts.vaultHub.isVaultHealthy(stakingVault)).to.equal(true);
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

    const { witnesses, postdeposit } = await getProofAndDepositData(ctx, validator, withdrawalCredentials);

    await expect(
      predepositGuarantee.connect(nodeOperator).proveWCActivateAndTopUpValidators(witnesses, [postdeposit.amount]),
    ).to.be.revertedWithCustomError(pdg, "ResumedExpected");

    await expect(pdg.connect(stranger).resume()).to.emit(pdg, "Resumed");
    expect(await pdg.isPaused()).to.equal(false);
  });

  describe("Full cycle trustless path through PDG", () => {
    async function commonSteps() {
      const { predepositGuarantee } = ctx.contracts;

      // 1. The stVault's owner supplies 100 ETH to the vault
      await expect(dashboard.connect(owner).fund({ value: ether("100") }))
        .to.emit(stakingVault, "EtherFunded")
        .withArgs(ether("100"));

      // 2. Setting stranger as a guarantor
      await expect(predepositGuarantee.connect(nodeOperator).setNodeOperatorGuarantor(guarantor))
        .to.emit(predepositGuarantee, "GuarantorSet")
        .withArgs(nodeOperator, await guarantor.getAddress(), nodeOperator);

      expect(await predepositGuarantee.nodeOperatorGuarantor(nodeOperator)).to.equal(guarantor);

      // 3. The Node Operator's guarantor tops up 1 ETH to the PDG contract, specifying the Node Operator's address. This serves as the predeposit guarantee collateral.
      //  Method called: PredepositGuarantee.topUpNodeOperatorBalance(nodeOperator) with ETH transfer.
      await expect(predepositGuarantee.connect(guarantor).topUpNodeOperatorBalance(nodeOperator, { value: ether("1") }))
        .to.emit(predepositGuarantee, "BalanceToppedUp")
        .withArgs(nodeOperator, guarantor, ether("1"));

      // 4. The Node Operator generates validator keys and predeposit data
      const withdrawalCredentials = await stakingVault.withdrawalCredentials();
      const validator = generateValidator(withdrawalCredentials);

      // Pre-requisite: fund the vault to have enough balance to start a validator
      await dashboard.connect(owner).fund({ value: ether("32") });

      const predepositData = await generatePredeposit(validator, {
        depositDomain: await predepositGuarantee.DEPOSIT_DOMAIN(),
      });

      // 5. The Node Operator predeposits 1 ETH from the vault balance to the validator via the PDG contract.
      //    same time the PDG locks 1 ETH from the Node Operator's guarantee collateral in the PDG.
      await expect(
        predepositGuarantee
          .connect(nodeOperator)
          .predeposit(stakingVault, [predepositData.deposit], [predepositData.depositY]),
      )
        .to.emit(predepositGuarantee, "BalanceLocked")
        .withArgs(nodeOperator, ether("1"), ether("1"))
        .to.emit(depositContract, "DepositEvent")
        .withArgs(
          predepositData.deposit.pubkey,
          withdrawalCredentials,
          toLittleEndian64(toGwei(predepositData.deposit.amount)),
          predepositData.deposit.signature,
          anyValue,
        );

      const { witnesses, postdeposit } = await getProofAndDepositData(
        ctx,
        validator,
        withdrawalCredentials,
        ether("99"),
      );

      // 6. Anyone (permissionless) submits a Merkle proof of the validator's appearing on the Consensus Layer to the PDG contract with the withdrawal credentials corresponding to the stVault's address.
      //    6.1. Upon successful verification, 1 ETH of the Node Operator's guarantee collateral is unlocked from the PDG balance
      //    — making it available for withdrawal or reuse for the next validator predeposit.
      await expect(predepositGuarantee.connect(stranger).proveWCActivateAndTopUpValidators(witnesses, [0]))
        .to.emit(predepositGuarantee, "ValidatorProven")
        .withArgs(witnesses[0].pubkey, nodeOperator, await stakingVault.getAddress(), withdrawalCredentials)
        .to.emit(predepositGuarantee, "BalanceUnlocked")
        .withArgs(nodeOperator, ether("1"), ether("0"))
        .to.emit(depositContract, "DepositEvent")
        .withArgs(
          postdeposit.pubkey,
          withdrawalCredentials,
          toLittleEndian64(toGwei(await predepositGuarantee.ACTIVATION_DEPOSIT_AMOUNT())),
          anyValue,
          anyValue,
        );

      // 7. The Node Operator's guarantor withdraws the 1 ETH from the PDG contract or retains it for reuse with future validators.
      const balanceBefore = await ethers.provider.getBalance(guarantor);
      await expect(
        predepositGuarantee.connect(guarantor).withdrawNodeOperatorBalance(nodeOperator, ether("1"), guarantor),
      )
        .to.emit(predepositGuarantee, "BalanceWithdrawn")
        .withArgs(nodeOperator, guarantor, ether("1"));

      const balanceAfter = await ethers.provider.getBalance(guarantor);
      expect(balanceAfter).to.be.gt(balanceBefore); // Account for gas costs

      return { postdeposit };
    }

    // https://docs.lido.fi/guides/stvaults/pdg#full-cycle-trustless-path-through-pdg
    it("Happy path", async () => {
      const { postdeposit } = await commonSteps();
      const { predepositGuarantee } = ctx.contracts;

      // 8. The Node Operator makes a top-up deposit of the remaining 99 ETH from the vault balance to the validator through the PDG.
      //    Method called: PredepositGuarantee.depositToBeaconChain(stakingVault, deposits).
      await expect(predepositGuarantee.connect(nodeOperator).topUpExistingValidators([postdeposit]))
        .to.emit(depositContract, "DepositEvent")
        .withArgs(
          postdeposit.pubkey,
          await stakingVault.withdrawalCredentials(),
          toLittleEndian64(toGwei(postdeposit.amount)),
          anyValue, // todo: check if this is correct
          anyValue,
        );
    });

    it("Works with vaults deposit pauses", async () => {
      const { postdeposit } = await commonSteps();
      const { predepositGuarantee } = ctx.contracts;

      // 8. The stVault's owner pauses the vault's deposits.
      await expect(dashboard.connect(owner).pauseBeaconChainDeposits()).to.emit(
        stakingVault,
        "BeaconChainDepositsPaused",
      );

      // 9. The Node Operator tries to deposit the remaining 99 ETH from the vault balance to the validator through the PDG.
      //    This reverts with the "BeaconChainDepositsOnPause" error.
      await expect(
        predepositGuarantee.connect(nodeOperator).topUpExistingValidators([postdeposit]),
      ).to.be.revertedWithCustomError(stakingVault, "BeaconChainDepositsOnPause");

      // 10. The stVault's owner resumes the vault's deposits.
      await expect(dashboard.connect(owner).resumeBeaconChainDeposits()).to.emit(
        stakingVault,
        "BeaconChainDepositsResumed",
      );

      // 11. The Node Operator deposits the remaining 99 ETH from the vault balance to the validator through the PDG.
      await expect(predepositGuarantee.connect(nodeOperator).topUpExistingValidators([postdeposit]))
        .to.emit(depositContract, "DepositEvent")
        .withArgs(
          postdeposit.pubkey,
          await stakingVault.withdrawalCredentials(),
          toLittleEndian64(toGwei(postdeposit.amount)),
          anyValue, // todo: check if this is correct
          anyValue,
        );
    });
  });

  // https://docs.lido.fi/guides/stvaults/pdg#pdg-shortcut
  it("PDG shortcut", async () => {
    const { predepositGuarantee } = ctx.contracts;

    // 1. The stVault's owner supplies 100 ETH to the vault.
    await expect(dashboard.connect(owner).fund({ value: ether("100") }))
      .to.emit(stakingVault, "EtherFunded")
      .withArgs(ether("100"));

    // 2. The Node Operator generates validator keys and deposit data.
    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const validator = generateValidator(withdrawalCredentials);

    // 3. The Node Operator shares the deposit data with the stVault's owner.
    // (This is a conceptual step, no actual code needed)

    const predepositData = await generatePredepositData(predepositGuarantee, dashboard, owner, nodeOperator, validator);

    await dashboard.connect(owner).grantRole(await dashboard.FUND_ROLE(), proxy);

    await reportVaultDataWithProof(ctx, stakingVault);
    await dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);

    // 4. The stVault's owner deposits 1 ETH from the vault balance directly to the validator, bypassing the PDG.
    //    Method called: Dashboard.unguaranteedDepositToBeaconChain(deposits).
    //    4.1. As a result, the stVault's total value is temporarily reduced by 1 ETH until the next oracle report delivered containing the appeared validator's balance.
    // todo: this step fails, BUT this is the point of the test!
    await expect(dashboard.connect(nodeOperator).unguaranteedDepositToBeaconChain([predepositData.deposit]))
      .to.emit(dashboard, "UnguaranteedDeposits")
      .withArgs(await stakingVault.getAddress(), 1, predepositData.deposit.amount);
    // check that emit the event from deposit contract

    const { witnesses, postdeposit } = await getProofAndDepositData(ctx, validator, withdrawalCredentials, ether("99"));

    // 5. The stVault's owner submits a Merkle proof of the validator's appearing on the Consensus Layer to the Dashboard contract.
    await expect(dashboard.connect(nodeOperator).proveUnknownValidatorsToPDG([witnesses[0]]))
      .to.emit(predepositGuarantee, "ValidatorProven")
      .withArgs(witnesses[0].pubkey, nodeOperator, await stakingVault.getAddress(), withdrawalCredentials);

    // 6. The Oracle report confirms the validator's balance (1 ETH). The stVault's total value is then increased by 1 ETH accordingly.
    // (This is handled by the protocol, no actual code needed)

    // 7. The Node Operator deposits the remaining 99 ETH from the vault balance to the validator through the PDG.
    await expect(predepositGuarantee.connect(nodeOperator).topUpExistingValidators([postdeposit]))
      .to.emit(depositContract, "DepositEvent")
      .withArgs(
        postdeposit.pubkey,
        await stakingVault.withdrawalCredentials(),
        toLittleEndian64(toGwei(postdeposit.amount)),
        anyValue, // todo: check if this is correct
        anyValue,
      );
  });

  describe("Disproven pubkey compensation", () => {
    it("compensates disproven deposit", async () => {
      const { predepositGuarantee } = ctx.contracts;

      // 1. The stVault's owner supplies 100 ETH to the vault
      await expect(dashboard.connect(owner).fund({ value: ether("100") }))
        .to.emit(stakingVault, "EtherFunded")
        .withArgs(ether("100"));

      // 3. The Node Operator's guarantor tops up 1 ETH to the PDG contract, specifying the Node Operator's address. This serves as the predeposit guarantee collateral.
      //  Method called: PredepositGuarantee.topUpNodeOperatorBalance(nodeOperator) with ETH transfer.
      await expect(
        predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, { value: ether("1") }),
      )
        .to.emit(predepositGuarantee, "BalanceToppedUp")
        .withArgs(nodeOperator, nodeOperator, ether("1"));

      // 4. The Node Operator generates a validator data with correct withdrawal creds
      const invalidWithdrawalCredentials = addressToWC(await nodeOperator.getAddress());
      const validator = generateValidator(invalidWithdrawalCredentials);

      const invalidValidatorHackedWC = {
        ...validator,
        container: { ...validator.container, withdrawalCredentials: await stakingVault.withdrawalCredentials() },
      };

      const invalidPredeposit = await generatePredeposit(invalidValidatorHackedWC, {
        depositDomain: await predepositGuarantee.DEPOSIT_DOMAIN(),
      });

      // 5. The Node Operator predeposits 1 ETH from the vault balance to the validator via the PDG contract.
      //    same time the PDG locks 1 ETH from the Node Operator's guarantee collateral in the PDG.
      await expect(
        predepositGuarantee
          .connect(nodeOperator)
          .predeposit(stakingVault, [invalidPredeposit.deposit], [invalidPredeposit.depositY]),
      )
        .to.emit(depositContract, "DepositEvent")
        .withArgs(
          invalidPredeposit.deposit.pubkey,
          await stakingVault.withdrawalCredentials(),
          toLittleEndian64(toGwei(invalidPredeposit.deposit.amount)),
          invalidPredeposit.deposit.signature,
          anyValue,
        )
        .to.emit(predepositGuarantee, "BalanceLocked")
        .withArgs(nodeOperator, ether("1"), ether("1"));

      const { witnesses } = await getProofAndDepositData(ctx, validator, invalidWithdrawalCredentials, ether("99"));

      const balance = await predepositGuarantee.nodeOperatorBalance(nodeOperator);

      // 6. Anyone (permissionless) submits a Merkle proof of the validator's appearing on the Consensus Layer to the PDG contract with the withdrawal credentials corresponding to the stVault's address.
      //    6.1. Upon successful verification, 1 ETH of the Node Operator's guarantee collateral is unlocked from the PDG balance
      //    — making it available for withdrawal or reuse for the next validator predeposit.
      await expect(
        predepositGuarantee.connect(stranger).proveInvalidValidatorWC(witnesses[0], invalidWithdrawalCredentials),
      )
        .to.emit(predepositGuarantee, "ValidatorCompensated")
        .withArgs(
          await stakingVault.getAddress(),
          nodeOperator,
          witnesses[0].pubkey,
          balance.total - ONE_ETHER,
          balance.locked - ONE_ETHER,
        );
    });
  });
});
