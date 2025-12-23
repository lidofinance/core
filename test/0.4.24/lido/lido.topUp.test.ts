import { expect } from "chai";
import { hexlify, randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ACL,
  Lido,
  LidoLocator,
  StakingRouter__MockForLidoTopUp,
  WithdrawalQueue__MockForLidoMisc,
} from "typechain-types";

import { ether, impersonate } from "lib";

import { deployLidoDao } from "test/deploy";
import { Snapshot } from "test/suite";

describe("Lido.sol:topUp", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let topUpGateway: HardhatEthersSigner;

  let lido: Lido;
  let acl: ACL;
  let locator: LidoLocator;
  let withdrawalQueue: WithdrawalQueue__MockForLidoMisc;
  let stakingRouter: StakingRouter__MockForLidoTopUp;

  let originalState: string;

  const MODULE_ID = 1n;
  const GWEI = 1_000_000_000n;
  const ETH = 10n ** 18n;

  beforeEach(async () => {
    originalState = await Snapshot.take();

    [deployer, user, stranger] = await ethers.getSigners();

    withdrawalQueue = await ethers.deployContract("WithdrawalQueue__MockForLidoMisc", deployer);
    stakingRouter = await ethers.deployContract("StakingRouter__MockForLidoTopUp", deployer);

    ({ lido, acl } = await deployLidoDao({
      rootAccount: deployer,
      initialized: true,
      locatorConfig: {
        withdrawalQueue,
        stakingRouter,
      },
    }));

    locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), deployer);

    // Impersonate topUpGateway
    topUpGateway = await impersonate(await locator.topUpGateway(), ether("10.0"));

    // Set up permissions for user to control protocol
    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.PAUSE_ROLE(), deployer);

    // Resume staking
    await lido.connect(user).resume();

    // Add some buffer by staking
    await lido.connect(stranger).submit(stranger, { value: ether("100.0") });
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  describe("access control", () => {
    it("reverts when caller is not TopUpGateway", async () => {
      const keyIndices = [0n];
      const operatorIds = [1n];
      const pubkeysPacked = hexlify(randomBytes(48));
      const topUpLimitsGwei = [10n * GWEI];

      await expect(
        lido.connect(stranger).topUp(MODULE_ID, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei),
      ).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("reverts when protocol is stopped", async () => {
      // Stop the protocol
      await lido.connect(user).stop();

      const keyIndices = [0n];
      const operatorIds = [1n];
      const pubkeysPacked = hexlify(randomBytes(48));
      const topUpLimitsGwei = [10n * GWEI];

      await expect(
        lido.connect(topUpGateway).topUp(MODULE_ID, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei),
      ).to.be.revertedWith("CAN_NOT_DEPOSIT");
    });

    it("reverts when in bunker mode", async () => {
      // Enable bunker mode
      await withdrawalQueue.mock__bunkerMode(true);

      const keyIndices = [0n];
      const operatorIds = [1n];
      const pubkeysPacked = hexlify(randomBytes(48));
      const topUpLimitsGwei = [10n * GWEI];

      await expect(
        lido.connect(topUpGateway).topUp(MODULE_ID, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei),
      ).to.be.revertedWith("CAN_NOT_DEPOSIT");
    });
  });

  describe("buffer updates", () => {
    it("decreases buffered ether by deposit amount", async () => {
      const depositAmount = 10n * ETH;
      await stakingRouter.mock__setTopUpDepositAmount(depositAmount);

      const keyIndices = [0n];
      const operatorIds = [1n];
      const pubkeysPacked = hexlify(randomBytes(48));
      const topUpLimitsGwei = [10n * GWEI];

      const bufferedBefore = await lido.getBufferedEther();

      await lido.connect(topUpGateway).topUp(MODULE_ID, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei);

      const bufferedAfter = await lido.getBufferedEther();

      expect(bufferedAfter).to.equal(bufferedBefore - depositAmount);
    });

    it("emits Unbuffered event when deposit amount > 0", async () => {
      const depositAmount = 10n * ETH;
      await stakingRouter.mock__setTopUpDepositAmount(depositAmount);

      const keyIndices = [0n];
      const operatorIds = [1n];
      const pubkeysPacked = hexlify(randomBytes(48));
      const topUpLimitsGwei = [10n * GWEI];

      await expect(lido.connect(topUpGateway).topUp(MODULE_ID, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei))
        .to.emit(lido, "Unbuffered")
        .withArgs(depositAmount);
    });

    it("does not emit Unbuffered event when deposit amount is 0", async () => {
      await stakingRouter.mock__setTopUpDepositAmount(0n);

      const keyIndices = [0n];
      const operatorIds = [1n];
      const pubkeysPacked = hexlify(randomBytes(48));
      const topUpLimitsGwei = [0n]; // zero limit

      await expect(
        lido.connect(topUpGateway).topUp(MODULE_ID, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei),
      ).to.not.emit(lido, "Unbuffered");
    });
  });

  describe("integration with StakingRouter", () => {
    it("calls StakingRouter.topUp with correct parameters", async () => {
      const depositAmount = 10n * ETH;
      await stakingRouter.mock__setTopUpDepositAmount(depositAmount);

      const keyIndices = [0n, 1n];
      const operatorIds = [1n, 2n];
      const pubkeysPacked = hexlify(randomBytes(96)); // 2 keys
      const topUpLimitsGwei = [5n * GWEI, 5n * GWEI];

      await expect(lido.connect(topUpGateway).topUp(MODULE_ID, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei))
        .to.emit(stakingRouter, "Mock__TopUpCalled")
        .withArgs(MODULE_ID, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei);

      expect(await stakingRouter.topUpCalls()).to.equal(1n);
    });

    it("handles zero deposit amount (CSM cursor advancement case)", async () => {
      await stakingRouter.mock__setTopUpDepositAmount(0n);

      const keyIndices = [0n];
      const operatorIds = [1n];
      const pubkeysPacked = hexlify(randomBytes(48));
      const topUpLimitsGwei = [0n];

      const bufferedBefore = await lido.getBufferedEther();

      // Should succeed without changing buffer
      await lido.connect(topUpGateway).topUp(MODULE_ID, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei);

      const bufferedAfter = await lido.getBufferedEther();
      expect(bufferedAfter).to.equal(bufferedBefore);
      expect(await stakingRouter.topUpCalls()).to.equal(1n);
    });
  });
});
