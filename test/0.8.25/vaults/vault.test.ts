import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { JsonRpcProvider, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { advanceChainTime, ether, getNextBlock, getNextBlockNumber } from "lib";
import { Snapshot } from "test/suite";
import {
  DepositContract__MockForBeaconChainDepositor,
  DepositContract__MockForBeaconChainDepositor__factory,
  VaultHub__MockForVault,
  VaultHub__MockForVault__factory,
} from "typechain-types";
import { StakingVault } from "typechain-types/contracts/0.8.25/vaults";
import { StakingVault__factory } from "typechain-types/factories/contracts/0.8.25/vaults";

describe.only("StakingVault.sol", async () => {
  let deployer: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let executionLayerRewardsSender: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let vaultHub: VaultHub__MockForVault;
  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let vaultFactory: StakingVault__factory;
  let stakingVault: StakingVault;

  let originalState: string;

  before(async () => {
    [deployer, owner, executionLayerRewardsSender, stranger] = await ethers.getSigners();

    const vaultHubFactory = new VaultHub__MockForVault__factory(deployer);
    vaultHub = await vaultHubFactory.deploy();

    const depositContractFactory = new DepositContract__MockForBeaconChainDepositor__factory(deployer);
    depositContract = await depositContractFactory.deploy();

    vaultFactory = new StakingVault__factory(owner);
    stakingVault = await vaultFactory.deploy(
      await owner.getAddress(),
      await vaultHub.getAddress(),
      await depositContract.getAddress(),
    );
  });

  beforeEach(async () => (originalState = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(originalState));

  describe("constructor", () => {
    it("reverts if `_owner` is zero address", async () => {
      expect(vaultFactory.deploy(ZeroAddress, await vaultHub.getAddress(), await depositContract.getAddress()))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_owner");
    });

    it("reverts if `_hub` is zero address", async () => {
      expect(vaultFactory.deploy(await owner.getAddress(), ZeroAddress, await depositContract.getAddress()))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_hub");
    });

    it("sets `vaultHub` and transfers ownership from zero address to `owner`", async () => {
      expect(
        vaultFactory.deploy(await owner.getAddress(), await vaultHub.getAddress(), await depositContract.getAddress()),
      )
        .to.be.emit(stakingVault, "OwnershipTransferred")
        .withArgs(ZeroAddress, await owner.getAddress());

      expect(await stakingVault.vaultHub()).to.equal(await vaultHub.getAddress());
      expect(await stakingVault.owner()).to.equal(await owner.getAddress());
    });
  });

  describe("receive", () => {
    it("reverts if `msg.value` is zero", async () => {
      expect(
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
      expect(tx)
        .to.emit(stakingVault, "ExecutionLayerRewardsReceived")
        .withArgs(await executionLayerRewardsSender.getAddress(), executionLayerRewardsAmount);
      expect(tx).to.changeEtherBalance(stakingVault, balanceBefore + executionLayerRewardsAmount);
    });
  });

  describe("fund", () => {
    it("reverts if `msg.value` is zero", async () => {
      expect(stakingVault.fund({ value: 0 }))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("reverts if `msg.sender` is not `owner`", async () => {
      expect(stakingVault.connect(stranger).fund({ value: ether("1") }))
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(await stranger.getAddress());
    });

    it("accepts ether, increases `inOutDelta`, and emits `Funded` event", async () => {
      const fundAmount = ether("1");
      const inOutDeltaBefore = await stakingVault.inOutDelta();

      const tx = stakingVault.fund({ value: fundAmount });

      expect(tx).to.emit(stakingVault, "Funded").withArgs(owner, fundAmount);

      // for some reason, there are race conditions (probably batching or something)
      // so, we have to wait for confirmation
      // @TODO: troubleshoot (probably provider batching or smth)
      (await tx).wait();
      expect(await stakingVault.inOutDelta()).to.equal(inOutDeltaBefore + fundAmount);
    });
  });
});
