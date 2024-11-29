import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForBeaconChainDepositor,
  StakingVault,
  StakingVault__factory,
  StETH__HarnessForVaultHub,
  VaultFactory,
  VaultHub__MockForVault,
  VaultStaffRoom,
} from "typechain-types";

import { createVaultProxy, ether, impersonate } from "lib";

import { Snapshot } from "test/suite";

describe("StakingVault.sol", async () => {
  let deployer: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let executionLayerRewardsSender: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let delegatorSigner: HardhatEthersSigner;

  let vaultHub: VaultHub__MockForVault;
  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let vaultCreateFactory: StakingVault__factory;
  let stakingVault: StakingVault;
  let steth: StETH__HarnessForVaultHub;
  let vaultFactory: VaultFactory;
  let vaultStaffRoomImpl: VaultStaffRoom;
  let vaultProxy: StakingVault;

  let originalState: string;

  before(async () => {
    [deployer, owner, executionLayerRewardsSender, stranger, holder] = await ethers.getSigners();

    vaultHub = await ethers.deployContract("VaultHub__MockForVault", { from: deployer });
    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [holder], {
      value: ether("10.0"),
      from: deployer,
    });

    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", { from: deployer });

    vaultCreateFactory = new StakingVault__factory(owner);
    stakingVault = await ethers.getContractFactory("StakingVault").then((f) => f.deploy(vaultHub, depositContract));

    vaultStaffRoomImpl = await ethers.deployContract("VaultStaffRoom", [steth], { from: deployer });

    vaultFactory = await ethers.deployContract("VaultFactory", [deployer, stakingVault, vaultStaffRoomImpl], {
      from: deployer,
    });

    const { vault, vaultStaffRoom } = await createVaultProxy(vaultFactory, owner);
    vaultProxy = vault;

    delegatorSigner = await impersonate(await vaultStaffRoom.getAddress(), ether("100.0"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  describe("constructor", () => {
    it("reverts if `_vaultHub` is zero address", async () => {
      await expect(vaultCreateFactory.deploy(ZeroAddress, await depositContract.getAddress()))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_vaultHub");
    });

    it("reverts if `_beaconChainDepositContract` is zero address", async () => {
      await expect(vaultCreateFactory.deploy(await vaultHub.getAddress(), ZeroAddress)).to.be.revertedWithCustomError(
        stakingVault,
        "DepositContractZeroAddress",
      );
    });

    it("sets `vaultHub` and `_stETH` and `depositContract`", async () => {
      expect(await stakingVault.vaultHub(), "vaultHub").to.equal(await vaultHub.getAddress());
      expect(await stakingVault.DEPOSIT_CONTRACT(), "DPST").to.equal(await depositContract.getAddress());
    });
  });

  describe("initialize", () => {
    it("reverts on impl initialization", async () => {
      await expect(stakingVault.initialize(await owner.getAddress(), "0x")).to.be.revertedWithCustomError(
        vaultProxy,
        "SenderShouldBeBeacon",
      );
    });

    it("reverts if already initialized", async () => {
      await expect(vaultProxy.initialize(await owner.getAddress(), "0x")).to.be.revertedWithCustomError(
        vaultProxy,
        "SenderShouldBeBeacon",
      );
    });
  });

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
      await expect(vaultProxy.connect(delegatorSigner).fund({ value: 0 }))
        .to.be.revertedWithCustomError(vaultProxy, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("accepts ether, increases `inOutDelta`, and emits `Funded` event", async () => {
      const fundAmount = ether("1");
      const inOutDeltaBefore = await stakingVault.inOutDelta();

      await expect(vaultProxy.connect(delegatorSigner).fund({ value: fundAmount }))
        .to.emit(vaultProxy, "Funded")
        .withArgs(delegatorSigner, fundAmount);

      // for some reason, there are race conditions (probably batching or something)
      // so, we have to wait for confirmation
      // @TODO: troubleshoot (probably provider batching or smth)
      // (await tx).wait();
      expect(await vaultProxy.inOutDelta()).to.equal(inOutDeltaBefore + fundAmount);
    });
  });
});
