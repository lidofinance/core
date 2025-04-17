import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Delegation, StakingVault } from "typechain-types";

import {
  connectToHub,
  createVaultWithDelegation,
  disconnectFromHub,
  getProtocolContext,
  ProtocolContext,
  setupLido,
  VaultRoles,
} from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);

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

    await connectToHub(ctx, delegation, stakingVault);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  it("Allows minting stETH", async () => {
    const { vaultHub } = ctx.contracts;

    // add some stETH to the vault to have valuation
    await delegation.connect(roles.funder).fund({ value: ether("1") });

    await expect(delegation.connect(roles.minter).mintStETH(stranger, 1n))
      .to.emit(vaultHub, "MintedSharesOnVault")
      .withArgs(stakingVault, 1n);
  });

  it("Allows burning stETH", async () => {
    const { vaultHub, lido } = ctx.contracts;

    // add some stETH to the vault to have valuation, mint shares and approve stETH
    await delegation.connect(roles.funder).fund({ value: ether("1") });
    await delegation.connect(roles.minter).mintStETH(roles.burner, 1n);
    await lido.connect(roles.burner).approve(delegation, 1n);

    await expect(delegation.connect(roles.burner).burnStETH(1n))
      .to.emit(vaultHub, "BurnedSharesOnVault")
      .withArgs(stakingVault, 1n);
  });

  it("Allows trigger validator withdrawal", async () => {
    await expect(
      delegation
        .connect(roles.validatorWithdrawalTriggerer)
        .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], roles.validatorWithdrawalTriggerer, { value: 1n }),
    )
      .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
      .withArgs(delegation, SAMPLE_PUBKEY, [ether("1")], roles.validatorWithdrawalTriggerer, 0);

    await expect(
      stakingVault
        .connect(nodeOperatorManager)
        .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], roles.validatorWithdrawalTriggerer, { value: 1n }),
    ).to.emit(stakingVault, "ValidatorWithdrawalTriggered");
  });

  describe("Authorize / Deauthorize Lido VaultHub", () => {
    it("After creation via createVaultWithDelegation and connection vault is authorized", async () => {
      expect(await stakingVault.vaultHubAuthorized()).to.equal(true);
    });

    it("Can't deauthorize Lido VaultHub if connected to Hub", async () => {
      await expect(
        delegation.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub(),
      ).to.be.revertedWithCustomError(stakingVault, "VaultConnected");
    });

    it.skip("Can deauthorize Lido VaultHub if dicsconnected from Hub", async () => {
      await disconnectFromHub(ctx, stakingVault);
      // todo: need to call something to actually disconnect the socket, but did not find, what to call
      await expect(delegation.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub())
        .to.emit(stakingVault, "VaultHubAuthorizedSet")
        .withArgs(false);
    });
  });
});
