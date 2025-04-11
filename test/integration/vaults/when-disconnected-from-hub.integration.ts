import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { deployBLSPrecompileStubs } from "lib";
import { createVaultWithDelegation, getProtocolContext, ProtocolContext, setupLido, VaultRoles } from "lib/protocol";

import { Snapshot, Tracing } from "test/suite";

import { Delegation, StakingVault } from "typechain-types";
import { ether } from "../../../lib/units";

describe("Scenario: Actions with vault disconnected from hub", () => {
  let ctx: ProtocolContext;

  let delegation: Delegation;
  let stakingVault: StakingVault;
  let roles: VaultRoles;

  let owner: HardhatEthersSigner;
  let nodeOperatorManager: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let snapshot: string;
  let originalSnapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLido(ctx);

    // TODO: remove stubs when hardhat fork supports BLS precompiles
    await deployBLSPrecompileStubs();

    [owner, nodeOperatorManager, stranger] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, delegation, roles } = await createVaultWithDelegation(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperatorManager,
    ));
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Funding", () => {
    it("Allows to fund amount less or equal then funder's balance + gas price", async () => {
      const amount = 1n;

      await expect(delegation.connect(roles.funder).fund({ value: amount }))
        .to.emit(stakingVault, "Funded")
        .withArgs(delegation, amount);

      expect(await delegation.withdrawableEther()).to.equal(amount);
    });

    it.only("Does not allow to fun amount bigger that funder's balance + gas price ", async () => {
      Tracing.enable();

      console.log(await ethers.provider.getFeeData());
      await setBalance(roles.funder.address, 3n);
      const funderBalance = await ethers.provider.getBalance(roles.funder.address);

      console.log(funderBalance);
      const amount = funderBalance;

      delegation.connect(roles.funder).fund({ value: 1n });
      await expect(delegation.connect(roles.funder).fund({ value: amount })).to.be.revertedWith(
        "not enough funds smth",
      );

      expect(await delegation.withdrawableEther()).to.equal(amount);
    });
  });

  describe("Withdrawal", () => {
    it("Allows to fund and withdraw ", async () => {
      await expect(delegation.connect(roles.funder).fund({ value: 2n }))
        .to.emit(stakingVault, "Funded")
        .withArgs(delegation, 2n);

      expect(await delegation.withdrawableEther()).to.equal(2n);

      await expect(await delegation.connect(roles.withdrawer).withdraw(stranger, 2n))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(delegation, stranger, 2n);

      expect(await delegation.withdrawableEther()).to.equal(0);
    });
  });
});
