import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, Lido, StakingVault, VaultHub } from "typechain-types";

import { ether, updateBalance } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";

import { Snapshot } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "01".repeat(48);

describe("Integration: VaultHub.forceValidatorExit", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let vaultHub: VaultHub;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let lido: Lido;
  let vaultAddress: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let validatorExitOperator: HardhatEthersSigner;
  let agentSigner: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    [, owner, nodeOperator, validatorExitOperator] = await ethers.getSigners();
    await setupLidoForVaults(ctx);

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    vaultAddress = await stakingVault.getAddress();
    vaultHub = ctx.contracts.vaultHub;
    lido = ctx.contracts.lido;
    dashboard = dashboard.connect(owner);

    agentSigner = await ctx.getSigner("agent");
    await vaultHub.connect(agentSigner).grantRole(await vaultHub.VALIDATOR_EXIT_ROLE(), validatorExitOperator.address);
    await vaultHub.connect(agentSigner).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), agentSigner.address);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("forceValidatorExit access and behavior", () => {
    it("reverts when there is no obligations shortfall", async () => {
      const fee = await stakingVault.calculateValidatorWithdrawalFee(1n);

      expect(await vaultHub.obligationsShortfallValue(vaultAddress)).to.equal(0n);

      await expect(
        vaultHub
          .connect(validatorExitOperator)
          .forceValidatorExit(vaultAddress, SAMPLE_PUBKEY, validatorExitOperator.address, { value: fee }),
      ).to.be.revertedWithCustomError(vaultHub, "ForcedValidatorExitNotAllowed");
    });

    it("triggers validator withdrawals when obligations shortfall exists", async () => {
      const fee = await stakingVault.calculateValidatorWithdrawalFee(1n);

      await dashboard.fund({ value: ether("3") });
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      await updateBalance(stakingVault, 0n);
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("1"),
        cumulativeLidoFees: ether("2"),
        waitForNextRefSlot: true,
      });

      expect(await vaultHub.obligationsShortfallValue(vaultAddress)).to.equal(ether("2"));

      const tx = vaultHub
        .connect(validatorExitOperator)
        .forceValidatorExit(vaultAddress, SAMPLE_PUBKEY, validatorExitOperator.address, { value: fee });

      await expect(tx)
        .to.emit(vaultHub, "ForcedValidatorExitTriggered")
        .withArgs(vaultAddress, SAMPLE_PUBKEY, validatorExitOperator.address);

      await expect(tx)
        .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
        .withArgs(SAMPLE_PUBKEY, [], 0n, validatorExitOperator.address);
    });

    it("reduces redemptionShares after forced exit and refreshed report", async () => {
      const fee = await stakingVault.calculateValidatorWithdrawalFee(1n);

      await dashboard.fund({ value: ether("4") });
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const redemptionValue = ether("2");
      const redemptionShares = await lido.getSharesByPooledEth(redemptionValue);

      await dashboard.mintShares(owner, redemptionShares);
      await vaultHub.connect(agentSigner).setLiabilitySharesTarget(vaultAddress, 0n);

      await updateBalance(stakingVault, 0n);
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("1"),
        cumulativeLidoFees: 0n,
        waitForNextRefSlot: true,
      });

      const recordBefore = await vaultHub.vaultRecord(vaultAddress);
      expect(recordBefore.redemptionShares).to.equal(redemptionShares);

      await vaultHub
        .connect(validatorExitOperator)
        .forceValidatorExit(vaultAddress, SAMPLE_PUBKEY, validatorExitOperator.address, { value: fee });

      const recovered = redemptionValue + ether("1");
      await dashboard.fund({ value: recovered });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: recovered,
        cumulativeLidoFees: 0n,
        waitForNextRefSlot: true,
      });

      const expectedRebalanceValue = await lido.getPooledEthBySharesRoundUp(redemptionShares);

      await expect(dashboard.rebalanceVaultWithShares(redemptionShares))
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(vaultAddress, redemptionShares, expectedRebalanceValue)
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(vaultAddress, 0n);

      const recordAfter = await vaultHub.vaultRecord(vaultAddress);
      expect(recordAfter.redemptionShares).to.equal(0n);
      expect(await vaultHub.obligationsShortfallValue(vaultAddress)).to.equal(0n);
    });
  });
});
