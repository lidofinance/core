import { expect } from "chai";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, DepositContract, StakingVault } from "typechain-types";

import { ether, generateValidator, PDGPolicy, toGwei, toLittleEndian64 } from "lib";
import {
  createVaultWithDashboard,
  generatePredepositData,
  getProtocolContext,
  mockProof,
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
  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let agent: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    [owner, nodeOperator, stranger] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, dashboard } = await createVaultWithDashboard(
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

    const witness = await mockProof(ctx, validator);

    await expect(
      predepositGuarantee.connect(nodeOperator).proveWCActivateAndTopUpValidators([witness], [0]),
    ).to.be.revertedWithCustomError(pdg, "ResumedExpected");

    await expect(pdg.connect(stranger).resume()).to.emit(pdg, "Resumed");
    expect(await pdg.isPaused()).to.equal(false);
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

    await reportVaultDataWithProof(ctx, stakingVault);
    await dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);

    // 4. The stVault's owner deposits 1 ETH from the vault balance directly to the validator, bypassing the PDG.
    //    Method called: Dashboard.unguaranteedDepositToBeaconChain(deposits).
    //    4.1. As a result, the stVault's total value is temporarily reduced by 1 ETH until the next oracle report delivered containing the appeared validator's balance.
    // todo: this step fails, BUT this is the point of the test!
    await expect(dashboard.connect(nodeOperator).unguaranteedDepositToBeaconChain([predepositData.deposit]))
      .to.emit(dashboard, "UnguaranteedDeposits")
      .withArgs(stakingVault, 1, predepositData.deposit.amount);
    // check that emit the event from deposit contract

    const witness = await mockProof(ctx, validator);

    // 5. The stVault's owner submits a Merkle proof of the validator's appearing on the Consensus Layer to the Dashboard contract.
    await expect(dashboard.connect(nodeOperator).proveUnknownValidatorsToPDG([witness]))
      .to.emit(predepositGuarantee, "ValidatorProven")
      .withArgs(witness.pubkey, nodeOperator, stakingVault, withdrawalCredentials);

    // 6. The Oracle report confirms the validator's balance (1 ETH). The stVault's total value is then increased by 1 ETH accordingly.
    // (This is handled by the protocol, no actual code needed)

    // 7. The Node Operator deposits the remaining 99 ETH from the vault balance to the validator through the PDG.
    await expect(
      predepositGuarantee
        .connect(nodeOperator)
        .topUpExistingValidators([{ pubkey: witness.pubkey, amount: ether("99") }]),
    )
      .to.emit(depositContract, "DepositEvent")
      .withArgs(
        witness.pubkey,
        await stakingVault.withdrawalCredentials(),
        toLittleEndian64(toGwei(ether("99"))),
        anyValue, // todo: check if this is correct
        anyValue,
      );
  });
});
