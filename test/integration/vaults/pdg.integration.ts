import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StakingVault } from "typechain-types";

import { generateValidator } from "lib";
import { createVaultWithDashboard, getProtocolContext, ProtocolContext, setupLido } from "lib/protocol";
import { getProofAndDepositData } from "lib/protocol/helpers/vaults";

import { Snapshot } from "test/suite";

describe("Integration: Predeposit Guarantee core functionality", () => {
  let ctx: ProtocolContext;

  let stakingVault: StakingVault;

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
    ({ stakingVault } = await createVaultWithDashboard(
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
      predepositGuarantee.connect(nodeOperator).proveAndDeposit(witnesses, [postdeposit], stakingVault),
    ).to.be.revertedWithCustomError(pdg, "ResumedExpected");

    await expect(pdg.connect(stranger).resume()).to.emit(pdg, "Resumed");
    expect(await pdg.isPaused()).to.equal(false);
  });

  // https://docs.lido.fi/guides/stvaults/pdg#full-cycle-trustless-path-through-pdg
  // 1. The stVault's owner supplies 100 ETH to the vault.
  //    Method called: Dashboard.fund() with ETH transfer (payable).
  // 2. The Node Operator optionally assigns a guarantor address that will further provide a 1 ETH guarantee. (This guarantor can be the Node Operator, Vault Owner, or a third party.)
  //    Method called: PredepositGuarantee.setNodeOperatorGuarantor(newGuarantor).
  // 3. The Node Operator’s guarantor tops up 1 ETH to the PDG contract, specifying the Node Operator’s address. This serves as the predeposit guarantee collateral.
  //    Method called: PredepositGuarantee.topUpNodeOperatorBalance(nodeOperator) with ETH transfer.
  // 4. The Node Operator generates validator keys and predeposit data.
  // 5. The Node Operator predeposits 1 ETH from the vault balance to the validator via the PDG contract.
  //    Method called: PredepositGuarantee.predeposit(stakingVault, deposits, depositsY), same time the PDG locks 1 ETH from the Node Operator’s guarantee collateral in the PDG.
  // 6. Anyone (permissionless) submits a Merkle proof of the validator’s appearing on the Consensus Layer to the PDG contract with the withdrawal credentials corresponding to the stVault's address.
  //    Method called: PredepositGuarantee.proveValidatorWC(witness).
  //    6.1. Upon successful verification, 1 ETH of the Node Operator’s guarantee collateral is unlocked from the PDG balance — making it available for withdrawal or reuse for the next validator predeposit.
  // 7. The Node Operator’s guarantor withdraws the 1 ETH from the PDG contract or retains it for reuse with future validators.
  //    Method called: PredepositGuarantee.withdrawNodeOperatorBalance(nodeOperator, amount, recipient).
  // 8. The Node Operator makes a top-up deposit of the remaining 99 ETH from the vault balance to the validator through the PDG.
  //    Method called: PredepositGuarantee.depositToBeaconChain(stakingVault, deposits).

  // https://docs.lido.fi/guides/stvaults/pdg#pdg-shortcut
  // 1. The stVault's owner supplies 100 ETH to the vault.
  //    Method called: Dashboard.fund() with ETH transfer (payable).
  // 2. The Node Operator generates validator keys and deposit data.
  // 3. The Node Operator shares the deposit data with the stVault's owner.
  // 4. The stVault's owner deposits 1 ETH from the vault balance directly to the validator, bypassing the PDG.
  //    Method called: Dashboard.unguaranteedDepositToBeaconChain(deposits).
  //    4.1. As a result, the stVault’s total value is temporarily reduced by 1 ETH until the next oracle report delivered containing the appeared validator's balance.
  // 5. The stVault's owner submits a Merkle proof of the validator’s appearing on the Consensus Layer to the Dashboard contract.
  //    Method called: Dashboard.proveUnknownValidatorsToPDG(witness).
  // 6. The Oracle report confirms the validator’s balance (1 ETH). The stVault’s total value is then increased by 1 ETH accordingly.
  // 7. The Node Operator deposits the remaining 99 ETH from the vault balance to the validator through the PDG.
  //    Method called: PredepositGuarantee.depositToBeaconChain(stakingVault, deposits).

  // Works with vaults deposit pauses
  // Steps 1-7 are the same as in the full cycle trustless path
  // 8. The stVault's owner pauses the vault's deposits.
  //    Method called: Dashboard.pauseBeaconChainDeposits().
  // 9. The Node Operator tries to deposit the remaining 99 ETH from the vault balance to the validator through the PDG.
  //    Method called: PredepositGuarantee.depositToBeaconChain(stakingVault, deposits).
  //    This reverts with the "BeaconChainDepositsPaused" error.
  // 10. The stVault's owner resumes the vault's deposits.
  //    Method called: Dashboard.resumeBeaconChainDeposits().
  // 11. The Node Operator deposits the remaining 99 ETH from the vault balance to the validator through the PDG.
  //    Method called: PredepositGuarantee.depositToBeaconChain(stakingVault, deposits).
});
