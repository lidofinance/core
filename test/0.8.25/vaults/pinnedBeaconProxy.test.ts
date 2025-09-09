import { expect } from "chai";
import { keccak256 } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setStorageAt } from "@nomicfoundation/hardhat-network-helpers";

import {
  DepositContract__MockForBeaconChainDepositor,
  PinnedBeaconProxy,
  StakingVault,
  StakingVault__HarnessForTestUpgrade,
  UpgradeableBeacon,
} from "typechain-types";

import { randomAddress } from "lib";

import { Snapshot } from "test/suite";

const PINNED_BEACON_STORAGE_SLOT = "0x8d75cfa6c9a3cd2fb8b6d445eafb32adc5497a45b333009f9000379f7024f9f5";

describe("PinnedBeaconProxy.sol", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let beacon: UpgradeableBeacon;
  let implOld: StakingVault;
  let implNew: StakingVault__HarnessForTestUpgrade;
  let pinnedBeaconProxy: PinnedBeaconProxy;
  let originalState: string;

  before(async () => {
    [deployer, admin] = await ethers.getSigners();

    // Deploy mock deposit contract
    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);

    // Deploy vault implementations
    implOld = await ethers.deployContract("StakingVault", [depositContract], { from: deployer });
    implNew = await ethers.deployContract("StakingVault__HarnessForTestUpgrade", [depositContract], {
      from: deployer,
    });

    // Deploy beacon with initial implementation
    beacon = await ethers.deployContract("UpgradeableBeacon", [implOld, admin]);

    // Deploy PinnedBeaconProxy
    pinnedBeaconProxy = await ethers.deployContract("PinnedBeaconProxy", [beacon, "0x"]);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  async function ossify(proxy: PinnedBeaconProxy, pin: string) {
    await setStorageAt(await proxy.getAddress(), PINNED_BEACON_STORAGE_SLOT, pin);
  }

  async function resetOssify(proxy: PinnedBeaconProxy) {
    await ossify(proxy, ethers.ZeroAddress);
  }

  describe("Constructor", () => {
    it("should deploy successfully", async () => {
      const proxy = await ethers.deployContract("PinnedBeaconProxy", [beacon, "0x"]);

      expect(await proxy.getAddress()).to.be.properAddress;
      expect(await proxy.implementation()).to.equal(await beacon.implementation());
    });

    it("should return different codehash for different beacon", async () => {
      const beacon2 = await ethers.deployContract("UpgradeableBeacon", [implNew, admin]);
      const proxy2 = await ethers.deployContract("PinnedBeaconProxy", [beacon2, "0x"]);
      await proxy2.waitForDeployment();

      const proxyCode = await ethers.provider.getCode(await pinnedBeaconProxy.getAddress());
      const proxyCodeHash = keccak256(proxyCode);

      const proxy2Code = await ethers.provider.getCode(await proxy2.getAddress());
      const proxy2CodeHash = keccak256(proxy2Code);

      expect(proxy2CodeHash).to.not.equal(proxyCodeHash);
    });

    it("should return same codehash for same beacon", async () => {
      const proxy2 = await ethers.deployContract("PinnedBeaconProxy", [beacon, "0x"]);
      await proxy2.waitForDeployment();

      const proxyCode = await ethers.provider.getCode(await pinnedBeaconProxy.getAddress());
      const proxyCodeHash = keccak256(proxyCode);

      const proxy2Code = await ethers.provider.getCode(await proxy2.getAddress());
      const proxy2CodeHash = keccak256(proxy2Code);

      expect(proxy2CodeHash).to.equal(proxyCodeHash);
    });
  });

  describe("_implementation()", () => {
    it("should return beacon implementation when not ossified", async () => {
      const beaconImpl = await beacon.implementation();
      const proxyImpl = await pinnedBeaconProxy.implementation();
      expect(proxyImpl).to.equal(beaconImpl);
    });

    it("should return pinned implementation when ossified", async () => {
      const pin = await randomAddress();

      await ossify(pinnedBeaconProxy, pin);

      expect(await pinnedBeaconProxy.implementation()).to.equal(pin);

      await resetOssify(pinnedBeaconProxy);

      expect(await pinnedBeaconProxy.implementation()).to.equal(await beacon.implementation());
    });

    it("should use new beacon implementation when beacon is upgraded and not ossified", async () => {
      expect(await pinnedBeaconProxy.implementation()).to.equal(await beacon.implementation());

      await beacon.connect(admin).upgradeTo(implNew);
      expect(await pinnedBeaconProxy.implementation()).to.equal(await implNew.getAddress());
    });

    it("should continue using pinned implementation after beacon upgrade when ossified", async () => {
      const initialImpl = await beacon.implementation();
      await ossify(pinnedBeaconProxy, initialImpl);
      expect(await pinnedBeaconProxy.implementation()).to.equal(initialImpl);

      await beacon.connect(admin).upgradeTo(implNew);
      expect(await pinnedBeaconProxy.implementation()).to.equal(initialImpl);
      expect(await pinnedBeaconProxy.implementation()).to.not.equal(await beacon.implementation());
    });

    it("should handle multiple proxy instances with different pinned implementations", async () => {
      const proxy2 = await ethers.deployContract("PinnedBeaconProxy", [beacon, "0x"]);
      const currentImpl = await beacon.implementation();

      await ossify(pinnedBeaconProxy, currentImpl);

      await beacon.connect(admin).upgradeTo(implNew);
      expect(await pinnedBeaconProxy.implementation()).to.equal(currentImpl);
      expect(await proxy2.implementation()).to.equal(await beacon.implementation());
    });
  });

  describe("isOssified()", () => {
    it("should return false when not ossified", async () => {
      expect(await pinnedBeaconProxy.isOssified()).to.be.false;
    });

    it("should return true when ossified", async () => {
      await ossify(pinnedBeaconProxy, randomAddress());
      expect(await pinnedBeaconProxy.isOssified()).to.be.true;
    });
  });
});
