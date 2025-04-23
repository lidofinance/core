import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault } from "typechain-types";

import {
  createVaultWithDashboard,
  disconnectFromHub,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLido,
  VaultRoles,
} from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);

describe("Integration: Actions with vault is connected to VaultHub", () => {
  let ctx: ProtocolContext;

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let roles: VaultRoles;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let snapshot: string;
  let originalSnapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLido(ctx);

    [owner, nodeOperator, stranger] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, dashboard, roles } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
    ));
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));
  it("Allows minting stETH", async () => {
    const { vaultHub } = ctx.contracts;

    // add some stETH to the vault to have totalValue
    await dashboard.connect(roles.funder).fund({ value: ether("1") });

    await expect(dashboard.connect(roles.minter).mintStETH(stranger, 1n))
      .to.emit(vaultHub, "MintedSharesOnVault")
      .withArgs(stakingVault, 1n);
  });

  it("Allows burning stETH", async () => {
    const { vaultHub, lido } = ctx.contracts;

    // add some stETH to the vault to have totalValue, mint shares and approve stETH
    await dashboard.connect(roles.funder).fund({ value: ether("1") });
    await dashboard.connect(roles.minter).mintStETH(roles.burner, 1n);
    await lido.connect(roles.burner).approve(dashboard, 1n);

    await expect(dashboard.connect(roles.burner).burnStETH(1n))
      .to.emit(vaultHub, "BurnedSharesOnVault")
      .withArgs(stakingVault, 1n);
  });
  it("Allows trigger validator withdrawal", async () => {
    await expect(
      dashboard
        .connect(roles.validatorWithdrawalTriggerer)
        .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], roles.validatorWithdrawalTriggerer, { value: 1n }),
    )
      .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
      .withArgs(dashboard, SAMPLE_PUBKEY, [ether("1")], roles.validatorWithdrawalTriggerer, 0);

    await expect(
      stakingVault
        .connect(nodeOperator)
        .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], roles.validatorWithdrawalTriggerer, { value: 1n }),
    ).to.emit(stakingVault, "ValidatorWithdrawalTriggered");
  });

  describe("Authorize / Deauthorize Lido VaultHub", () => {
    it("After creation via createVaultWithDelegation and connection vault is authorized", async () => {
      expect(await stakingVault.vaultHubAuthorized()).to.equal(true);
    });

    it("Can't deauthorize Lido VaultHub if connected to Hub", async () => {
      await expect(
        dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub(),
      ).to.be.revertedWithCustomError(stakingVault, "VaultConnected");
    });

    it.skip("Can deauthorize Lido VaultHub if dicsconnected from Hub", async () => {
      await disconnectFromHub(ctx, stakingVault);
      await reportVaultDataWithProof(stakingVault);

      await expect(dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub())
        .to.emit(stakingVault, "VaultHubAuthorizedSet")
        .withArgs(false);
    });
  });
});
