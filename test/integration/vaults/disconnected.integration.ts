import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Delegation, StakingVault } from "typechain-types";

import { impersonate } from "lib";
import { createVaultWithDelegation, getProtocolContext, ProtocolContext, setupLido, VaultRoles } from "lib/protocol";

import { Snapshot } from "test/suite";

import { ether } from "../../../lib/units";

describe("Integration: Actions with vault disconnected from hub", () => {
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

  // TODO: take all actions for disconnected vaults and tru to test them and check that they change state as expected

  describe("Funding", () => {
    it("Allows to fund amount less or equal then funder's balance + gas price", async () => {
      const amount = 1n;

      await expect(delegation.connect(roles.funder).fund({ value: amount }))
        .to.emit(stakingVault, "Funded")
        .withArgs(delegation, amount);

      // TODO check that funding changes in inOutDelta
      // TODO check that funding updates valuation
      expect(await delegation.withdrawableEther()).to.equal(amount);
    });

    // weth contract must be deployed, @Yuri will add to provision, may skip for now
    it.skip("fundWeth");
  });

  it("Reverts on minting stETH", async () => {
    await delegation.connect(roles.funder).fund({ value: ether("1") });
    await delegation.connect(owner).grantRole(await delegation.LOCK_ROLE(), roles.minter.address);

    await expect(delegation.connect(roles.minter).mintStETH(roles.locker, 1n)).to.be.revertedWithCustomError(
      ctx.contracts.vaultHub,
      "NotConnectedToHub",
    );
  });

  it("Reverts on burning stETH", async () => {
    const { lido, vaultHub, locator } = ctx.contracts;

    // suppose user somehow got 1 share and tries to burn it via the delegation contract on disconnected vault
    const accountingSigner = await impersonate(await locator.accounting(), ether("1"));
    await lido.connect(accountingSigner).mintShares(roles.burner, 1n);

    await expect(delegation.connect(roles.burner).burnStETH(1n)).to.be.revertedWithCustomError(
      vaultHub,
      "NotConnectedToHub",
    );
  });

  describe("Withdrawal", () => {
    it.skip("rejects to withdraw more than locked", async () => {
      // fund
      // lock
      // withdraw more than locked
    });

    it("withdraw all funded amount", async () => {
      await expect(delegation.connect(roles.funder).fund({ value: 2n }))
        .to.emit(stakingVault, "Funded")
        .withArgs(delegation, 2n);

      expect(await delegation.withdrawableEther()).to.equal(2n);

      await expect(await delegation.connect(roles.withdrawer).withdraw(stranger, 2n))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(delegation, stranger, 2n);

      // TODO check that withdrawing changes in inOutDelta
      // TODO check that withdrawing updates valuation
      expect(await delegation.withdrawableEther()).to.equal(0);
    });

    // weth contract must be deployed, @Yuri will add to provision, may skip for now
    it.skip("withdrawWETH");

    it.skip("can reset lock and withdraw all the funded amount", async () => {
      // fund + lock
      // reset lock
      // withdraw all
    });

    it.skip("may receive rewards and withdraw all the funds with rewards", async () => {
      // fund
    });
  });

  describe("Cant mint shares", () => {});

  describe("Cant burn shares", () => {});

  // TODO: test that deposits are possible
  describe("Set depositor / make deposit to beacon chain", () => {
    // here should set depositor to some EOA
  });

  // TODO: test that vault hub can be authorized and can revoke authorization
  describe("Authorize / Deauthorize Lido VaultHub", () => {});

  // TODO: test that vault can be ossified
  describe("Ossify vault", () => {});

  // TODO: test that vault owner can request validator exit and both can trigger exits
  describe("Request / trigger validator exit", () => {});
});
