import { expect } from "chai";
import { ContractRunner, ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Delegation, StakingVault } from "typechain-types";

import { days, ether, impersonate } from "lib";
import { getProtocolContext, getRandomSigners, ProtocolContext } from "lib/protocol";

import { deployWithdrawalsPreDeployedMock } from "test/deploy";
import { Snapshot } from "test/suite";

import { connectToHub, setupLido } from "../../../lib/protocol/vaults";

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);
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
    nodeOperatorFeeClaimers: HardhatEthersSigner,
    stranger: HardhatEthersSigner;

  let allRoles: HardhatEthersSigner[];
  let snapshot: string;
  let originalSnapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

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
      nodeOperatorFeeClaimers,
      stranger,
    ] = allRoles;

    // Owner can create a vault with operator as a node operator
    const deployTx = await stakingVaultFactory.connect(owner).createVaultWithDelegation(
      {
        defaultAdmin: owner,
        nodeOperatorManager: nodeOperatorManager,
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
        nodeOperatorFeeClaimers: [nodeOperatorFeeClaimers],
      },
      "0x",
    );
    const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
    const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

    expect(createVaultEvents.length).to.equal(1n);

    stakingVault = await ethers.getContractAt("StakingVault", createVaultEvents[0].args?.vault);
    delegation = await ethers.getContractAt("Delegation", createVaultEvents[0].args?.owner);
    await setupLido(ctx);
    // only equivalent of 10.0% of TVL can be minted as stETH on the vault
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

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

  it("Allows to claim NO's fee", async () => {
    await expect(
      delegation.connect(nodeOperatorFeeClaimers).claimNodeOperatorFee(stranger),
    ).to.be.not.revertedWithoutReason();
  });

  describe("Reverts stETH related actions when not connected to hub", () => {
    it("Reverts on minting stETH", async () => {
      await expect(delegation.connect(minter).mintStETH(stranger, 1n)).to.be.revertedWithCustomError(
        ctx.contracts.vaultHub,
        "NotConnectedToHub",
      );
    });

    it("Reverts on burning stETH", async () => {
      const { lido, vaultHub, locator } = ctx.contracts;

      // suppose user somehow got 1 share and tries to burn it via the delegation contract on disconnected vault
      const accountingSigner = await impersonate(await locator.accounting(), ether("1"));
      await lido.connect(accountingSigner).mintShares(burner, 1n);

      await expect(delegation.connect(burner).burnStETH(1n)).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
    });
  });

  describe("Allows stETH related actions only after connecting to Hub", () => {
    beforeEach(async () => await connectToHub(ctx, stakingVault, { reserveRatio, rebalanceThreshold }));

    it("Allows to mint stETH", async () => {
      const { vaultHub } = ctx.contracts;

      // add some stETH to the vault to have valuation
      await delegation.connect(funder).fund({ value: ether("1") });

      await expect(delegation.connect(minter).mintStETH(stranger, 1n))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, 1n);
    });

    it("Allows to burn stETH", async () => {
      const { vaultHub, lido } = ctx.contracts;

      // add some stETH to the vault to have valuation, mint shares and approve stETH
      await delegation.connect(funder).fund({ value: ether("1") });
      await delegation.connect(minter).mintStETH(burner, 1n);
      await lido.connect(burner).approve(delegation, 1n);

      await expect(delegation.connect(burner).burnStETH(1n))
        .to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(stakingVault, 1n);
    });
  });

  it("NO Manager can spawn a validator using ETH from the Vault ", () => {
    // todo: what method to use?
  });
});
