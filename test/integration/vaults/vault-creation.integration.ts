import { expect } from "chai";
import { ContractRunner, ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";
import { before } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Delegation, StakingVault } from "typechain-types";

import { days, ether, impersonate } from "lib";
import { getProtocolContext, getRandomSigners, ProtocolContext } from "lib/protocol";

import { deployWithdrawalsPreDeployedMock } from "test/deploy";
import { Snapshot, Tracing } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);
const VAULT_OWNER_FEE = 1_00n; // 1% AUM owner fee
const VAULT_NODE_OPERATOR_FEE = 3_00n; // 3% node operator fee

const reserveRatio = 10_00n; // 10% of ETH allocation as reserve
const rebalanceThreshold = 8_00n; // 8% is a threshold to force rebalance on the vault

describe("Scenario: Vault creation", () => {
  let ctx: ProtocolContext;

  let delegation: Delegation;
  let stakingVault: StakingVault;
  let owner: HardhatEthersSigner,
    nodeOperatorManager: HardhatEthersSigner,
    funder: HardhatEthersSigner,
    withdrawer: HardhatEthersSigner,
    minter: HardhatEthersSigner,
    burner: HardhatEthersSigner,
    assetRecoverer: HardhatEthersSigner,
    rebalancer: HardhatEthersSigner,
    depositPausers: HardhatEthersSigner,
    depositResumers: HardhatEthersSigner,
    validatorExitRequesters: HardhatEthersSigner,
    validatorWithdrawalTriggerers: HardhatEthersSigner,
    disconnecters: HardhatEthersSigner,
    curatorFeeSetters: HardhatEthersSigner,
    curatorFeeClaimers: HardhatEthersSigner,
    nodeOperatorFeeClaimers: HardhatEthersSigner,
    stranger: HardhatEthersSigner,
    agentSigner: HardhatEthersSigner,
    votingSigner: HardhatEthersSigner;

  let allRoles: HardhatEthersSigner[];
  let shareLimit: bigint;
  let snapshot: string;

  before(async () => {
    snapshot = await Snapshot.take();

    ctx = await getProtocolContext();

    // ERC7002 pre-deployed contract mock (0x00000961Ef480Eb55e80D19ad83579A64c007002)
    await deployWithdrawalsPreDeployedMock(1n);

    const { depositSecurityModule, stakingVaultFactory } = ctx.contracts;
    await depositSecurityModule.DEPOSIT_CONTRACT();

    allRoles = await getRandomSigners(20);
    [
      owner,
      nodeOperatorManager,
      funder,
      withdrawer,
      minter,
      burner,
      assetRecoverer,
      rebalancer,
      depositPausers,
      depositResumers,
      validatorExitRequesters,
      validatorWithdrawalTriggerers,
      disconnecters,
      curatorFeeSetters,
      curatorFeeClaimers,
      nodeOperatorFeeClaimers,
      stranger,
      agentSigner,
      votingSigner,
    ] = allRoles;

    // Owner can create a vault with operator as a node operator
    const deployTx = await stakingVaultFactory.connect(owner).createVaultWithDelegation(
      {
        defaultAdmin: owner,
        nodeOperatorManager: nodeOperatorManager,
        curatorFeeBP: VAULT_OWNER_FEE,
        assetRecoverer: assetRecoverer,
        nodeOperatorFeeBP: VAULT_NODE_OPERATOR_FEE,
        confirmExpiry: days(7n),
        funders: [funder],
        withdrawers: [withdrawer],
        minters: [minter],
        burners: [burner],
        rebalancers: [rebalancer],
        depositPausers: [depositPausers],
        depositResumers: [depositResumers],
        validatorExitRequesters: [validatorExitRequesters],
        validatorWithdrawalTriggerers: [validatorWithdrawalTriggerers],
        disconnecters: [disconnecters],
        curatorFeeSetters: [curatorFeeSetters],
        curatorFeeClaimers: [curatorFeeClaimers],
        nodeOperatorFeeClaimers: [nodeOperatorFeeClaimers],
      },
      "0x",
    );
    const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
    const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

    expect(createVaultEvents.length).to.equal(1n);

    stakingVault = await ethers.getContractAt("StakingVault", createVaultEvents[0].args?.vault);
    delegation = await ethers.getContractAt("Delegation", createVaultEvents[0].args?.owner);
    await setupLido();
  });

  after(async () => await Snapshot.restore(snapshot));

  async function generateFeesToClaim() {
    const { vaultHub } = ctx.contracts;
    const hubSigner = await impersonate(await vaultHub.getAddress(), ether("100"));
    const rewards = ether("1");
    await stakingVault.connect(hubSigner).report(rewards, 0n, 0n);
  }

  async function setupLido() {
    const { lido } = ctx.contracts;
    await lido.connect(votingSigner).setMaxExternalRatioBP(20_00n);
    // only equivalent of 10.0% of TVL can be minted as stETH on the vault
    shareLimit = (await lido.getTotalShares()) / 10n; // 10% of total shares
  }

  async function connectToHub() {
    const { vaultHub } = ctx.contracts;
    const treasuryFeeBP = 5_00n; // 5% of the treasury fee

    await vaultHub
      .connect(agentSigner)
      .connectVault(stakingVault, shareLimit, reserveRatio, rebalanceThreshold, treasuryFeeBP);
  }

  async function disconnectFromHub() {
    const { vaultHub } = ctx.contracts;

    await vaultHub.connect(agentSigner).disconnect(stakingVault);
  }

  it("Allows to fund an withdraw funds for dedicated roles", async () => {
    expect(await delegation.connect(funder).fund({ value: 2n })).to.be.ok;
    expect(await delegation.connect(owner).withdrawableEther()).to.equal(2n);
    expect(await delegation.connect(withdrawer).withdraw(stranger, 2n)).to.be.ok;
    expect(await delegation.connect(owner).withdrawableEther()).to.equal(0);
  });

  it("Allows to pause/resume deposits to validators", async () => {
    expect(await delegation.connect(depositPausers).pauseBeaconChainDeposits()).to.be.ok;
    expect(await delegation.connect(depositResumers).resumeBeaconChainDeposits()).to.be.ok;
  });

  it("Allows to ask Node Operator to withdraw funds from validator(s)", async () => {
    const vaultOwnerAddress = await stakingVault.owner();
    const vaultOwner: ContractRunner = await impersonate(vaultOwnerAddress, ether("10000"));
    expect(await stakingVault.connect(vaultOwner).requestValidatorExit(SAMPLE_PUBKEY)).to.be.ok;
  });

  it("Allows to trigger validator withdrawal", async () => {
    const vaultOwnerAddress = await stakingVault.owner();
    const vaultOwner: ContractRunner = await impersonate(vaultOwnerAddress, ether("10000"));

    expect(
      await stakingVault
        .connect(vaultOwner)
        .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], vaultOwnerAddress, { value: 1n }),
    ).to.be.ok;
  });

  describe("Allows actions only after connecting to Hub", () => {
    it("Allows to mint stEth", async () => {
      const { vaultHub } = ctx.contracts;

      await expect(delegation.connect(minter).mintStETH(stranger, 1n)).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
      await connectToHub();

      await expect(delegation.connect(minter).mintStETH(stranger, 1n)).to.not.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
      await disconnectFromHub();
    });

    it("to burn stEth", async () => {
      const { vaultHub } = ctx.contracts;

      // todo: why it fails with ALLOWANCE_EXCEEDED before NotConnectedToHub? How to fix it?
      await expect(delegation.connect(burner).burnStETH(1n)).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
      await connectToHub();

      await expect(delegation.connect(burner).burnStETH(1n)).to.not.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
      await disconnectFromHub();
    });

    describe("claiming fees", async () => {
      before(async () => {
        await delegation.connect(funder).fund({ value: ether("1") });
        await generateFeesToClaim();
      });

      it("to claim Curator's fee", async () => {
        const { vaultHub } = ctx.contracts;
        //await connectToHub();
        // todo: expecting for method to be reverted because we are not connected to the hub, but it is passing fine
        await expect(delegation.connect(curatorFeeClaimers).claimCuratorFee(stranger)).to.be.revertedWithCustomError(
          vaultHub,
          "NotConnectedToHub",
        );
        await connectToHub();

        await expect(
          delegation.connect(curatorFeeClaimers).claimCuratorFee(stranger),
        ).to.not.be.revertedWithCustomError(vaultHub, "NotConnectedToHub");
        await disconnectFromHub();
      });

      it("to claim NO's fee", async () => {
        const { vaultHub } = ctx.contracts;
        Tracing.enable();

        //await connectToHub();
        // todo: expecting for method to be reverted because we are not connected to the hub but it is passing fine
        await expect(
          delegation.connect(nodeOperatorFeeClaimers).claimNodeOperatorFee(stranger),
        ).to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub");

        await disconnectFromHub();
      });
    });
  });

  it("NO Manager can spawn a validator using ETH from the Vault ", () => {
    // todo: what method to use?
  });
});
