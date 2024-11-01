import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { JsonRpcProvider, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { advanceChainTime, ether, createVaultProxy } from "lib";
import { Snapshot } from "test/suite";
import {
  DepositContract__MockForBeaconChainDepositor,
  DepositContract__MockForBeaconChainDepositor__factory,
  VaultHub__MockForVault,
  VaultHub__MockForVault__factory,
  StETH__HarnessForVaultHub,
  StETH__HarnessForVaultHub__factory,
  VaultFactory,
} from "typechain-types";
import { StakingVault } from "typechain-types/contracts/0.8.25/vaults";
import { StakingVault__factory } from "typechain-types/factories/contracts/0.8.25/vaults";

describe.only("StakingVault.sol", async () => {
  let deployer: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let executionLayerRewardsSender: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let holder: HardhatEthersSigner;

  let vaultHub: VaultHub__MockForVault;
  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let vaultCreateFactory: StakingVault__factory;
  let stakingVault: StakingVault;
  let steth: StETH__HarnessForVaultHub;
  let vaultFactory: VaultFactory;
  let vaultProxy: StakingVault;

  let originalState: string;

  before(async () => {
    [deployer, owner, executionLayerRewardsSender, stranger, holder] = await ethers.getSigners();

    const vaultHubFactory = new VaultHub__MockForVault__factory(deployer);
    vaultHub = await vaultHubFactory.deploy();

    const stethFactory = new StETH__HarnessForVaultHub__factory(deployer);
    steth = await stethFactory.deploy(holder, { value: ether("10.0")})

    const depositContractFactory = new DepositContract__MockForBeaconChainDepositor__factory(deployer);
    depositContract = await depositContractFactory.deploy();

    vaultCreateFactory = new StakingVault__factory(owner);
    stakingVault = await vaultCreateFactory.deploy(
      await vaultHub.getAddress(),
      await steth.getAddress(),
      await depositContract.getAddress(),
    );

    vaultFactory = await ethers.deployContract("VaultFactory", [stakingVault, deployer], { from: deployer });

    const {vault} = await createVaultProxy(vaultFactory, owner)
    vaultProxy = vault
  });

  beforeEach(async () => (originalState = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(originalState));

  describe("constructor", () => {
    it("reverts if `_vaultHub` is zero address", async () => {
      await expect(vaultCreateFactory.deploy(ZeroAddress, await steth.getAddress(), await depositContract.getAddress()))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_vaultHub");
    });

    it("reverts if `_stETH` is zero address", async () => {
      await expect(vaultCreateFactory.deploy(await vaultHub.getAddress(), ZeroAddress, await depositContract.getAddress()))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_stETH");
    });

    it("reverts if `_beaconChainDepositContract` is zero address", async () => {
      await expect(vaultCreateFactory.deploy(await vaultHub.getAddress(), await steth.getAddress(), ZeroAddress))
        .to.be.revertedWithCustomError(stakingVault, "DepositContractZeroAddress");
    });

    it("sets `vaultHub` and `_stETH` and `depositContract`", async () => {
      expect(await stakingVault.vaultHub(), "vaultHub").to.equal(await vaultHub.getAddress());
      expect(await stakingVault.stETH(), "stETH").to.equal(await steth.getAddress());
      expect(await stakingVault.DEPOSIT_CONTRACT(), "DPST").to.equal(await depositContract.getAddress());
    });
  });

  describe("initialize", () => {
    it("reverts if `_owner` is zero address", async () => {
      await expect(stakingVault.initialize(ZeroAddress))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_owner");
    });

    it("reverts if call from non proxy", async () => {
      await expect(stakingVault.initialize(await owner.getAddress()))
        .to.be.revertedWithCustomError(stakingVault, "NonProxyCall");
    });

    it("reverts if already initialized", async () => {
      await expect(vaultProxy.initialize(await owner.getAddress()))
        .to.be.revertedWithCustomError(vaultProxy, "NonZeroContractVersionOnInit");
    });
  })

  describe("receive", () => {
    it("reverts if `msg.value` is zero", async () => {
      await expect(
        executionLayerRewardsSender.sendTransaction({
          to: await stakingVault.getAddress(),
          value: 0n,
        }),
      )
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("emits `ExecutionLayerRewardsReceived` event", async () => {
      const executionLayerRewardsAmount = ether("1");

      const balanceBefore = await ethers.provider.getBalance(await stakingVault.getAddress());

      const tx = executionLayerRewardsSender.sendTransaction({
        to: await stakingVault.getAddress(),
        value: executionLayerRewardsAmount,
      });

      // can't chain `emit` and `changeEtherBalance`, so we have two expects
      // https://hardhat.org/hardhat-runner/plugins/nomicfoundation-hardhat-chai-matchers#chaining-async-matchers
      // we could also
      await expect(tx)
        .to.emit(stakingVault, "ExecutionLayerRewardsReceived")
        .withArgs(await executionLayerRewardsSender.getAddress(), executionLayerRewardsAmount);
      await expect(tx).to.changeEtherBalance(stakingVault, balanceBefore + executionLayerRewardsAmount);
    });
  });

  describe("fund", () => {
    it("reverts if `msg.sender` is not `owner`", async () => {
      await expect(vaultProxy.connect(stranger).fund({ value: ether("1") }))
        .to.be.revertedWithCustomError(vaultProxy, "OwnableUnauthorizedAccount")
        .withArgs(await stranger.getAddress());
    });

    it("reverts if `msg.value` is zero", async () => {
      await expect(vaultProxy.connect(owner).fund({ value: 0 }))
        .to.be.revertedWithCustomError(vaultProxy, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("accepts ether, increases `inOutDelta`, and emits `Funded` event", async () => {
      const fundAmount = ether("1");
      const inOutDeltaBefore = await stakingVault.inOutDelta();

      await expect(vaultProxy.connect(owner).fund({ value: fundAmount }))
        .to.emit(vaultProxy, "Funded")
        .withArgs(owner, fundAmount);

      // for some reason, there are race conditions (probably batching or something)
      // so, we have to wait for confirmation
      // @TODO: troubleshoot (probably provider batching or smth)
      // (await tx).wait();
      expect(await vaultProxy.inOutDelta()).to.equal(inOutDeltaBefore + fundAmount);
    });
  });
});
