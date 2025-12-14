import { expect } from "chai";
import { BytesLike } from "ethers";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, DepositContract, PredepositGuarantee, StakingVault } from "typechain-types";

import {
  addressToWC,
  ether,
  generatePredeposit,
  generateValidator,
  toGwei,
  toLittleEndian64,
  Validator,
  ValidatorStage,
} from "lib";
import {
  createVaultWithDashboard,
  ensurePredepositGuaranteeUnpaused,
  getProtocolContext,
  mockProof,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";

describe("Scenario: Predeposit Guarantee happy path and frontrunning", () => {
  let ctx: ProtocolContext;
  let originalSnapshot: string;

  let stakingVault: StakingVault;
  let depositContract: DepositContract;
  let dashboard: Dashboard;
  let predepositGuarantee: PredepositGuarantee;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let guarantor: HardhatEthersSigner;
  let depositor: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await ensurePredepositGuaranteeUnpaused(ctx);
    await setupLidoForVaults(ctx);

    [owner, nodeOperator, guarantor, depositor, stranger] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
    ));

    depositContract = await ethers.getContractAt("DepositContract", await stakingVault.DEPOSIT_CONTRACT());
    predepositGuarantee = ctx.contracts.predepositGuarantee;
    await dashboard.connect(owner).fund({ value: ether("100") });
  });

  beforeEach(bailOnFailure);
  after(async () => await Snapshot.restore(originalSnapshot));

  async function expectPendingPredeposits(pubkeys: BytesLike[], noBalance: bigint) {
    for (const pubkey of pubkeys) {
      const status = await predepositGuarantee.validatorStatus(pubkey);
      expect(status.stakingVault).to.equal(stakingVault);
      expect(status.nodeOperator).to.equal(nodeOperator);
      expect(status.stage).to.equal(ValidatorStage.PREDEPOSITED);
    }

    expect(await predepositGuarantee.pendingActivations(stakingVault)).to.equal(pubkeys.length);
    expect(await predepositGuarantee.nodeOperatorBalance(nodeOperator)).to.deep.equal([
      noBalance,
      ether("1") * BigInt(pubkeys.length),
    ]);

    expect(await stakingVault.stagedBalance()).to.equal(ether("31") * BigInt(pubkeys.length));
    expect(await predepositGuarantee.unlockedBalance(nodeOperator)).to.equal(
      noBalance - ether("1") * BigInt(pubkeys.length),
    );
  }

  it("Node Operator assigns a guarantor", async () => {
    await expect(predepositGuarantee.connect(nodeOperator).setNodeOperatorGuarantor(guarantor))
      .to.emit(predepositGuarantee, "GuarantorSet")
      .withArgs(nodeOperator, guarantor, nodeOperator);

    expect(await predepositGuarantee.nodeOperatorGuarantor(nodeOperator)).to.equal(guarantor);
  });

  it("Guarantor tops up 2 ETH to the Node Operator's balance", async () => {
    await expect(predepositGuarantee.connect(guarantor).topUpNodeOperatorBalance(nodeOperator, { value: ether("2") }))
      .to.emit(predepositGuarantee, "BalanceToppedUp")
      .withArgs(nodeOperator, guarantor, ether("2"));

    expect(await predepositGuarantee.nodeOperatorBalance(nodeOperator)).to.deep.equal([ether("2"), 0n]);
    expect(await predepositGuarantee.claimableRefund(guarantor)).to.equal(0n);
  });

  it("Node Operator assigns a depositor", async () => {
    await expect(predepositGuarantee.connect(nodeOperator).setNodeOperatorDepositor(depositor))
      .to.emit(predepositGuarantee, "DepositorSet")
      .withArgs(nodeOperator, depositor, nodeOperator);

    expect(await predepositGuarantee.nodeOperatorDepositor(nodeOperator)).to.equal(depositor);
  });

  let validatorHappyPath: Validator;
  let validatorFrontrunned: Validator;

  it("Depositor predeposits two validators one valid and frontrunned", async () => {
    const { vaultHub } = ctx.contracts;
    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    validatorHappyPath = generateValidator(withdrawalCredentials);
    const predepositDataHappyPath = await generatePredeposit(validatorHappyPath, {
      depositDomain: await predepositGuarantee.DEPOSIT_DOMAIN(),
    });

    const invalidWithdrawalCredentials = addressToWC(nodeOperator.address);
    validatorFrontrunned = generateValidator(invalidWithdrawalCredentials);

    const invalidValidatorHackedWC = {
      ...validatorFrontrunned,
      container: {
        ...validatorFrontrunned.container,
        withdrawalCredentials: await stakingVault.withdrawalCredentials(),
      },
    };

    const predepositDataFrontrunned = await generatePredeposit(invalidValidatorHackedWC, {
      depositDomain: await predepositGuarantee.DEPOSIT_DOMAIN(),
    });

    const totalValueBefore = await vaultHub.totalValue(stakingVault);

    await expect(
      predepositGuarantee
        .connect(stranger)
        .verifyDepositMessage(predepositDataHappyPath.deposit, predepositDataHappyPath.depositY, withdrawalCredentials),
    ).to.not.be.reverted;

    const tx = predepositGuarantee
      .connect(depositor)
      .predeposit(
        stakingVault,
        [predepositDataHappyPath.deposit, predepositDataFrontrunned.deposit],
        [predepositDataHappyPath.depositY, predepositDataFrontrunned.depositY],
      );

    await expect(tx)
      .to.emit(predepositGuarantee, "BalanceLocked")
      .withArgs(nodeOperator, ether("2"), ether("2"))
      .to.emit(stakingVault, "EtherStaged")
      .withArgs(ether("62"))
      .to.emit(depositContract, "DepositEvent")
      .withArgs(
        predepositDataHappyPath.deposit.pubkey,
        withdrawalCredentials,
        toLittleEndian64(toGwei(predepositDataHappyPath.deposit.amount)),
        predepositDataHappyPath.deposit.signature,
        anyValue,
      )
      .to.emit(depositContract, "DepositEvent")
      .withArgs(
        predepositDataFrontrunned.deposit.pubkey,
        withdrawalCredentials,
        toLittleEndian64(toGwei(predepositDataFrontrunned.deposit.amount)),
        predepositDataFrontrunned.deposit.signature,
        anyValue,
      );

    await expect(tx).changeEtherBalance(stakingVault, -ether("2"));

    await expectPendingPredeposits(
      [predepositDataHappyPath.deposit.pubkey, predepositDataFrontrunned.deposit.pubkey],
      ether("2"),
    );
    expect(await vaultHub.totalValue(stakingVault)).to.equal(totalValueBefore);
  });

  it("Depositor brings a CL proof and tops up the validator", async () => {
    const { vaultHub } = ctx.contracts;
    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const witness = await mockProof(ctx, validatorHappyPath);

    const totalValueBefore = await vaultHub.totalValue(stakingVault);

    const tx = predepositGuarantee.connect(depositor).proveWCAndActivate(witness);

    await expect(tx)
      .to.emit(predepositGuarantee, "ValidatorProven")
      .withArgs(witness.pubkey, nodeOperator, stakingVault, withdrawalCredentials)
      .to.emit(predepositGuarantee, "ValidatorActivated")
      .withArgs(witness.pubkey, nodeOperator, stakingVault, withdrawalCredentials)
      .to.emit(predepositGuarantee, "BalanceUnlocked")
      .withArgs(nodeOperator, ether("2"), ether("1"))
      .to.emit(stakingVault, "EtherUnstaged")
      .withArgs(ether("31"))
      .to.emit(depositContract, "DepositEvent")
      .withArgs(
        witness.pubkey,
        withdrawalCredentials,
        toLittleEndian64(toGwei(await predepositGuarantee.ACTIVATION_DEPOSIT_AMOUNT())),
        anyValue,
        anyValue,
      );

    await expect(tx).changeEtherBalance(stakingVault, -ether("31"));
    expect(await predepositGuarantee.pendingActivations(stakingVault)).to.equal(1);
    expect((await predepositGuarantee.validatorStatus(witness.pubkey)).stage).to.equal(ValidatorStage.ACTIVATED);

    await expectPendingPredeposits([validatorFrontrunned.container.pubkey], ether("2"));

    expect(await vaultHub.totalValue(stakingVault)).to.equal(totalValueBefore);
  });

  it("Depositor can top up the validator", async () => {
    const { vaultHub } = ctx.contracts;
    const withdrawalCredentials = await stakingVault.withdrawalCredentials();

    const totalValueBefore = await vaultHub.totalValue(stakingVault);

    const tx = predepositGuarantee
      .connect(depositor)
      .topUpExistingValidators([{ pubkey: validatorHappyPath.container.pubkey, amount: ether("1") }]);

    await expect(tx)
      .to.emit(depositContract, "DepositEvent")
      .withArgs(
        validatorHappyPath.container.pubkey,
        withdrawalCredentials,
        toLittleEndian64(toGwei(ether("1"))),
        anyValue,
        anyValue,
      );

    await expect(tx).changeEtherBalance(stakingVault, -ether("1"));
    await expectPendingPredeposits([validatorFrontrunned.container.pubkey], ether("2"));
    expect(await vaultHub.totalValue(stakingVault)).to.equal(totalValueBefore);
  });

  it("Anyone can prove validator being frontrunned and vault will be compensated even if it is disconnected", async () => {
    await dashboard.connect(owner).voluntaryDisconnect();
    await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

    const witness = await mockProof(ctx, validatorFrontrunned);

    const tx = predepositGuarantee
      .connect(stranger)
      .proveInvalidValidatorWC(witness, addressToWC(nodeOperator.address));
    await expect(tx)
      .to.emit(predepositGuarantee, "ValidatorCompensated")
      .withArgs(stakingVault, nodeOperator, witness.pubkey, ether("1"), ether("0"))
      .to.emit(stakingVault, "EtherUnstaged")
      .withArgs(ether("31"));

    await expect(tx).changeEtherBalance(stakingVault, ether("1"));

    expect(await predepositGuarantee.nodeOperatorBalance(nodeOperator)).to.deep.equal([ether("1"), ether("0")]);
    expect(await stakingVault.stagedBalance()).to.equal(0n);
    expect(await predepositGuarantee.pendingActivations(stakingVault)).to.equal(0);
    expect((await predepositGuarantee.validatorStatus(witness.pubkey)).stage).to.equal(ValidatorStage.COMPENSATED);
  });

  it("Node Operator can change the guarantor back", async () => {
    await expect(predepositGuarantee.connect(nodeOperator).setNodeOperatorGuarantor(nodeOperator))
      .to.emit(predepositGuarantee, "GuarantorSet")
      .withArgs(nodeOperator, nodeOperator, guarantor);

    expect(await predepositGuarantee.nodeOperatorGuarantor(nodeOperator)).to.equal(nodeOperator);
    expect(await predepositGuarantee.claimableRefund(guarantor)).to.equal(ether("1"));
    expect(await predepositGuarantee.nodeOperatorBalance(nodeOperator)).to.deep.equal([ether("0"), ether("0")]);

    const tx = predepositGuarantee.connect(guarantor).claimGuarantorRefund(guarantor);
    await expect(tx).to.emit(predepositGuarantee, "GuarantorRefundClaimed").withArgs(guarantor, guarantor, ether("1"));
    await expect(tx).changeEtherBalance(guarantor, ether("1"));

    expect(await predepositGuarantee.claimableRefund(guarantor)).to.equal(0n);
  });

  it("Node Operator can change the depositor", async () => {
    await expect(predepositGuarantee.connect(nodeOperator).setNodeOperatorDepositor(nodeOperator))
      .to.emit(predepositGuarantee, "DepositorSet")
      .withArgs(nodeOperator, nodeOperator, depositor);

    expect(await predepositGuarantee.nodeOperatorDepositor(nodeOperator)).to.equal(nodeOperator);
  });
});
