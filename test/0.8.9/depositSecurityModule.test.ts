import { expect } from "chai";
import { encodeBytes32String, keccak256, solidityPacked, Wallet, ZeroAddress } from "ethers";
import { ethers, network } from "hardhat";
import { describe } from "mocha";

import { PANIC_CODES } from "@nomicfoundation/hardhat-chai-matchers/panic";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineUpTo, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  DepositContractMockForDepositSecurityModule,
  DepositSecurityModule,
  LidoMockForDepositSecurityModule,
  StakingRouterMockForDepositSecurityModule,
} from "typechain-types";

import { certainAddress, DSMAttestMessage, DSMPauseMessage, ether, streccak } from "lib";

import { Snapshot } from "test/suite";

const UNREGISTERED_STAKING_MODULE_ID = 1;
const STAKING_MODULE_ID = 100;
const MAX_DEPOSITS_PER_BLOCK = 100;
const MIN_DEPOSIT_BLOCK_DISTANCE = 14;
const PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS = 10;
const DEPOSIT_NONCE = 12;
const DEPOSIT_ROOT = "0xd151867719c94ad8458feaf491809f9bc8096c702a72747403ecaac30c179137";

// status enum
const StakingModuleStatus = {
  Active: 0, // deposits and rewards allowed
  DepositsPaused: 1, // deposits NOT allowed, rewards allowed
  Stopped: 2, // deposits and rewards NOT allowed
};

type Params = {
  lido: string;
  depositContract: string;
  stakingRouter: string;
  maxDepositsPerBlock: number;
  minDepositBlockDistance: number;
  pauseIntentValidityPeriodBlocks: number;
};

type Block = {
  number: number;
  hash: string;
};

function initialParams(): Params {
  return {
    lido: "",
    depositContract: "",
    stakingRouter: "",
    maxDepositsPerBlock: MAX_DEPOSITS_PER_BLOCK,
    minDepositBlockDistance: MIN_DEPOSIT_BLOCK_DISTANCE,
    pauseIntentValidityPeriodBlocks: PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS,
  } as Params;
}

describe("DepositSecurityModule.sol", () => {
  const config = initialParams();

  let dsm: DepositSecurityModule;
  let lido: LidoMockForDepositSecurityModule;
  let stakingRouter: StakingRouterMockForDepositSecurityModule;
  let depositContract: DepositContractMockForDepositSecurityModule;

  let admin: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let guardian1: Wallet;
  let guardian2: Wallet;
  let guardian3: Wallet;
  let unrelatedGuardian1: Wallet;
  let unrelatedGuardian2: Wallet;

  let originalState: string;
  let provider: typeof ethers.provider;

  async function getLatestBlock(): Promise<Block> {
    const block = await provider.getBlock("latest");
    if (!block) throw new Error("Failed to retrieve latest block");

    return block as Block;
  }

  before(async () => {
    ({ provider } = ethers);
    [admin, stranger] = await ethers.getSigners();

    guardian1 = new Wallet(streccak("guardian1"), provider);
    guardian2 = new Wallet(streccak("guardian2"), provider);
    guardian3 = new Wallet(streccak("guardian3"), provider);
    unrelatedGuardian1 = new Wallet(streccak("unrelatedGuardian1"), provider);
    unrelatedGuardian2 = new Wallet(streccak("unrelatedGuardian2"), provider);

    await setBalance(guardian1.address, ether("100"));
    await setBalance(guardian2.address, ether("100"));
    await setBalance(guardian3.address, ether("100"));
    await setBalance(unrelatedGuardian1.address, ether("100"));
    await setBalance(unrelatedGuardian2.address, ether("100"));

    lido = await ethers.deployContract("LidoMockForDepositSecurityModule");
    stakingRouter = await ethers.deployContract("StakingRouterMockForDepositSecurityModule", [STAKING_MODULE_ID]);
    depositContract = await ethers.deployContract("DepositContractMockForDepositSecurityModule");

    config.lido = await lido.getAddress();
    config.stakingRouter = await stakingRouter.getAddress();
    config.depositContract = await depositContract.getAddress();

    dsm = await ethers.deployContract("DepositSecurityModule", Object.values(config));

    DSMAttestMessage.setMessagePrefix(await dsm.ATTEST_MESSAGE_PREFIX());
    DSMPauseMessage.setMessagePrefix(await dsm.PAUSE_MESSAGE_PREFIX());

    await depositContract.set_deposit_root(DEPOSIT_ROOT);
    expect(await depositContract.get_deposit_root()).to.equal(DEPOSIT_ROOT);

    await mineUpTo((await time.latestBlock()) + MIN_DEPOSIT_BLOCK_DISTANCE);
    originalState = await Snapshot.take();
  });

  after(async () => {
    await Snapshot.restore(originalState);
  });

  context("constructor", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();
    });
    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    it("Reverts if the `lido` is zero address", async () => {
      const cfg = { ...config };
      cfg.lido = ZeroAddress;
      await expect(ethers.deployContract("DepositSecurityModule", Object.values(cfg))).to.be.revertedWithCustomError(
        dsm,
        "ZeroAddress",
      );
    });

    it("Reverts if the `depositContract` is zero address", async () => {
      const cfg = { ...config };
      cfg.depositContract = ZeroAddress;
      await expect(ethers.deployContract("DepositSecurityModule", Object.values(cfg))).to.be.revertedWithCustomError(
        dsm,
        "ZeroAddress",
      );
    });

    it("Reverts if the `stakingRouter` is zero address", async () => {
      const cfg = { ...config };
      cfg.stakingRouter = ZeroAddress;
      await expect(ethers.deployContract("DepositSecurityModule", Object.values(cfg))).to.be.revertedWithCustomError(
        dsm,
        "ZeroAddress",
      );
    });
  });

  context("Constants", () => {
    it("Returns the ATTEST_MESSAGE_PREFIX variable", async () => {
      const dsmAttestMessagePrefix = streccak("lido.DepositSecurityModule.ATTEST_MESSAGE");
      expect(dsmAttestMessagePrefix).to.equal("0x1085395a994e25b1b3d0ea7937b7395495fb405b31c7d22dbc3976a6bd01f2bf");

      const encodedAttestMessagePrefix = keccak256(
        solidityPacked(
          ["bytes32", "uint256", "address"],
          [dsmAttestMessagePrefix, network.config.chainId, await dsm.getAddress()],
        ),
      );

      expect(await dsm.ATTEST_MESSAGE_PREFIX()).to.equal(encodedAttestMessagePrefix);
    });
    it("Returns the PAUSE_MESSAGE_PREFIX variable", async () => {
      const dsmPauseMessagePrefix = streccak("lido.DepositSecurityModule.PAUSE_MESSAGE");
      expect(dsmPauseMessagePrefix).to.equal("0x9c4c40205558f12027f21204d6218b8006985b7a6359bcab15404bcc3e3fa122");

      const encodedPauseMessagePrefix = keccak256(
        solidityPacked(
          ["bytes32", "uint256", "address"],
          [dsmPauseMessagePrefix, network.config.chainId, await dsm.getAddress()],
        ),
      );

      expect(await dsm.PAUSE_MESSAGE_PREFIX()).to.equal(encodedPauseMessagePrefix);
    });
    it("Returns the LIDO address", async () => {
      expect(await dsm.LIDO()).to.equal(config.lido);
    });
    it("Returns the STAKING_ROUTER address", async () => {
      expect(await dsm.STAKING_ROUTER()).to.equal(config.stakingRouter);
    });
    it("Returns the DEPOSIT_CONTRACT address", async () => {
      expect(await dsm.DEPOSIT_CONTRACT()).to.equal(config.depositContract);
    });
  });

  context("Owner", () => {
    context("Function `getOwner`", () => {
      it("Returns the current owner of the contract", async () => {
        expect(await dsm.getOwner()).to.equal(admin.address);
      });
    });

    context("Function `setOwner`", () => {
      let originalState: string;

      before(async () => {
        originalState = await Snapshot.take();
      });

      after(async () => {
        await Snapshot.restore(originalState);
      });

      it("Reverts if the `newValue` is zero address", async () => {
        await expect(dsm.setOwner(ZeroAddress)).to.be.revertedWithCustomError(dsm, "ZeroAddress");
      });

      it("Reverts if the `setOwner` called by not an owner", async () => {
        await expect(dsm.connect(stranger).setOwner(certainAddress("owner"))).to.be.revertedWithCustomError(
          dsm,
          "NotAnOwner",
        );
      });

      it("Set a new owner and fires `OwnerChanged` event", async () => {
        const valueBefore = await dsm.getOwner();
        const newOwner = certainAddress("new owner");

        await expect(dsm.setOwner(newOwner)).to.emit(dsm, "OwnerChanged").withArgs(newOwner);

        expect(await dsm.getOwner()).to.equal(newOwner);
        expect(await dsm.getOwner()).to.not.equal(valueBefore);
      });
    });
  });

  context("Pause intent validity period blocks", () => {
    context("Function `getPauseIntentValidityPeriodBlocks`", () => {
      it("Returns current `pauseIntentValidityPeriodBlocks` contract parameter", async () => {
        expect(await dsm.getPauseIntentValidityPeriodBlocks()).to.equal(config.pauseIntentValidityPeriodBlocks);
      });
    });

    context("Function `setPauseIntentValidityPeriodBlocks`", () => {
      let originalState: string;

      before(async () => {
        originalState = await Snapshot.take();
      });

      after(async () => {
        await Snapshot.restore(originalState);
      });

      it("Reverts if the `newValue` is zero parameter", async () => {
        await expect(dsm.setPauseIntentValidityPeriodBlocks(0)).to.be.revertedWithCustomError(dsm, "ZeroParameter");
      });

      it("Reverts if the `setPauseIntentValidityPeriodBlocks` called by not an owner", async () => {
        await expect(
          dsm.connect(stranger).setPauseIntentValidityPeriodBlocks(config.pauseIntentValidityPeriodBlocks),
        ).to.be.revertedWithCustomError(dsm, "NotAnOwner");
      });

      it("Sets `pauseIntentValidityPeriodBlocks` and fires `PauseIntentValidityPeriodBlocksChanged` event", async () => {
        const newValue = config.pauseIntentValidityPeriodBlocks + 1;

        await expect(dsm.setPauseIntentValidityPeriodBlocks(newValue))
          .to.emit(dsm, "PauseIntentValidityPeriodBlocksChanged")
          .withArgs(newValue);

        expect(await dsm.getPauseIntentValidityPeriodBlocks()).to.equal(newValue);
      });
    });
  });

  context("Max deposits", () => {
    context("Function `getMaxDeposits`", () => {
      it("Returns `maxDepositsPerBlock`", async () => {
        expect(await dsm.getMaxDeposits()).to.equal(config.maxDepositsPerBlock);
      });
    });

    context("Function `setMaxDeposits`", () => {
      let originalState: string;

      before(async () => {
        originalState = await Snapshot.take();
      });

      after(async () => {
        await Snapshot.restore(originalState);
      });

      it("Reverts if the `setMaxDeposits` called by not an owner", async () => {
        await expect(
          dsm.connect(stranger).setMaxDeposits(config.maxDepositsPerBlock + 1),
        ).to.be.revertedWithCustomError(dsm, "NotAnOwner");
      });

      it("Sets `setMaxDeposits` and fires `MaxDepositsChanged` event", async () => {
        const valueBefore = await dsm.getMaxDeposits();

        const newValue = config.maxDepositsPerBlock + 1;
        await expect(dsm.setMaxDeposits(newValue)).to.emit(dsm, "MaxDepositsChanged").withArgs(newValue);

        expect(await dsm.getMaxDeposits()).to.equal(newValue);
        expect(await dsm.getMaxDeposits()).to.not.equal(valueBefore);
      });
    });
  });

  context("Min deposit block distance", () => {
    context("Function `getMinDepositBlockDistance`", () => {
      it("Returns `getMinDepositBlockDistance`", async () => {
        expect(await dsm.getMinDepositBlockDistance()).to.equal(config.minDepositBlockDistance);
      });
    });

    context("Function `setMinDepositBlockDistance`", () => {
      let originalState: string;

      before(async () => {
        originalState = await Snapshot.take();
      });

      after(async () => {
        await Snapshot.restore(originalState);
      });

      it("Reverts if the `setMinDepositBlockDistance` called by not an owner", async () => {
        await expect(
          dsm.connect(stranger).setMinDepositBlockDistance(config.minDepositBlockDistance + 1),
        ).to.be.revertedWithCustomError(dsm, "NotAnOwner");
      });

      it("Reverts if the `newValue` is zero parameter", async () => {
        await expect(dsm.setMinDepositBlockDistance(0)).to.be.revertedWithCustomError(dsm, "ZeroParameter");
      });

      it("Sets the equal `newValue` as previous one and NOT fires `MinDepositBlockDistanceChanged` event", async () => {
        await expect(dsm.setMinDepositBlockDistance(config.minDepositBlockDistance)).to.not.emit(
          dsm,
          "MinDepositBlockDistanceChanged",
        );

        expect(await dsm.getMinDepositBlockDistance()).to.equal(config.minDepositBlockDistance);
      });

      it("Sets the `newValue` and fires `MinDepositBlockDistanceChanged` event", async () => {
        const newValue = config.minDepositBlockDistance + 1;

        await expect(dsm.setMinDepositBlockDistance(newValue))
          .to.emit(dsm, "MinDepositBlockDistanceChanged")
          .withArgs(newValue);

        expect(await dsm.getMinDepositBlockDistance()).to.equal(newValue);
      });
    });
  });

  context("Guardians", () => {
    context("Function `getGuardianQuorum`", () => {
      it("Returns number of valid guardian signatures required to vet", async () => {
        expect(await dsm.getGuardianQuorum()).to.equal(0);
      });
    });

    context("Function `setGuardianQuorum`", () => {
      let originalState: string;
      const guardianQuorum = 1;

      beforeEach(async () => {
        originalState = await Snapshot.take();
      });

      afterEach(async () => {
        await Snapshot.restore(originalState);
      });

      it("Reverts if the `setGuardianQuorum` called by not an owner", async () => {
        await expect(dsm.connect(stranger).setGuardianQuorum(guardianQuorum)).to.be.revertedWithCustomError(
          dsm,
          "NotAnOwner",
        );
      });

      it("Sets the `newValue` and fires `GuardianQuorumChanged` event", async () => {
        await expect(dsm.setGuardianQuorum(guardianQuorum))
          .to.emit(dsm, "GuardianQuorumChanged")
          .withArgs(guardianQuorum);

        expect(await dsm.getGuardianQuorum()).to.equal(guardianQuorum);
      });

      it("Sets the equal `newValue` as previous one and NOT fires `GuardianQuorumChanged` event", async () => {
        await expect(dsm.setGuardianQuorum(guardianQuorum))
          .to.emit(dsm, "GuardianQuorumChanged")
          .withArgs(guardianQuorum);

        await expect(dsm.setGuardianQuorum(guardianQuorum)).to.not.emit(dsm, "GuardianQuorumChanged");

        expect(await dsm.getGuardianQuorum()).to.equal(guardianQuorum);
      });

      it("Sets the `newValue` higher than the current guardians count", async () => {
        const newGuardianQuorum = 100;
        await dsm.setGuardianQuorum(newGuardianQuorum);
        expect(await dsm.getGuardianQuorum()).to.equal(newGuardianQuorum);

        const guardiansLength = (await dsm.getGuardians()).length;
        expect(newGuardianQuorum > guardiansLength).to.equal(true);
      });
    });

    context("Function `getGuardians`", () => {
      it("Returns empty list of guardians initially", async () => {
        expect((await dsm.getGuardians()).length).to.equal(0);
      });
    });

    context("Function `isGuardian`", () => {
      let originalState: string;

      beforeEach(async () => {
        originalState = await Snapshot.take();
      });

      afterEach(async () => {
        await Snapshot.restore(originalState);
      });

      it("Returns false if list of guardians is empty", async () => {
        expect(await dsm.isGuardian(guardian1)).to.equal(false);
      });

      it("Returns false for non-guardian", async () => {
        await dsm.addGuardian(guardian1, 0);
        await dsm.addGuardian(guardian2, 0);

        expect((await dsm.getGuardians()).length).to.equal(2);
        expect(await dsm.isGuardian(guardian3)).to.equal(false);
      });

      it("Returns true non-guardian", async () => {
        await dsm.addGuardian(guardian1, 0);
        await dsm.addGuardian(guardian2, 0);

        expect((await dsm.getGuardians()).length).to.equal(2);
        expect(await dsm.isGuardian(guardian1)).to.equal(true);
        expect(await dsm.isGuardian(guardian2)).to.equal(true);
      });
    });

    context("Function `getGuardianIndex`", () => {
      let originalState: string;

      beforeEach(async () => {
        originalState = await Snapshot.take();
      });

      afterEach(async () => {
        await Snapshot.restore(originalState);
      });

      it("Returns -1 if list of guardians is empty", async () => {
        expect(await dsm.getGuardianIndex(guardian1)).to.equal(-1);
      });

      it("Returns -1 if the address is not a guardian", async () => {
        await dsm.addGuardian(guardian1, 0);
        await dsm.addGuardian(guardian2, 0);

        expect((await dsm.getGuardians()).length).to.equal(2);
        expect(await dsm.getGuardianIndex(guardian3)).to.equal(-1);
      });

      it("Returns index of the guardian", async () => {
        await dsm.addGuardian(guardian1, 0);
        await dsm.addGuardian(guardian2, 0);

        expect((await dsm.getGuardians()).length).to.equal(2);
        expect(await dsm.getGuardianIndex(guardian2)).to.equal(1);
      });
    });

    context("Function `addGuardian`", () => {
      let originalState: string;

      beforeEach(async () => {
        originalState = await Snapshot.take();
      });

      afterEach(async () => {
        await Snapshot.restore(originalState);
      });

      it("Reverts if the `addGuardian` called by not an owner", async () => {
        await expect(dsm.connect(stranger).addGuardian(guardian1, 0)).to.be.revertedWithCustomError(dsm, "NotAnOwner");
      });

      it("Reverts if added zero address", async () => {
        await expect(dsm.addGuardian(ZeroAddress, 0)).to.be.revertedWithCustomError(dsm, "ZeroAddress");
      });

      it("Reverts if added duplicate address", async () => {
        await dsm.addGuardian(guardian1, 0);

        await expect(dsm.addGuardian(guardian1, 0)).to.be.revertedWithCustomError(dsm, "DuplicateAddress");
      });

      it("Adds a guardian address sets a new quorum value, fires `GuardianAdded` and `GuardianQuorumChanged` events", async () => {
        const newQuorum = 1;
        const tx1 = await dsm.addGuardian(guardian1, newQuorum);
        expect((await dsm.getGuardians()).length).to.equal(1);
        expect(await dsm.getGuardianQuorum()).to.equal(newQuorum);

        await expect(tx1).to.emit(dsm, "GuardianAdded").withArgs(guardian1.address);

        await expect(tx1).to.emit(dsm, "GuardianQuorumChanged").withArgs(newQuorum);
      });

      it("Adds a guardian address sets the same quorum value, fires `GuardianAdded` and NOT `GuardianQuorumChanged` events", async () => {
        const newQuorum = 0;
        const tx1 = await dsm.addGuardian(guardian1, newQuorum);
        expect((await dsm.getGuardians()).length).to.equal(1);
        expect(await dsm.getGuardianQuorum()).to.equal(newQuorum);

        await expect(tx1).to.emit(dsm, "GuardianAdded").withArgs(guardian1.address);

        await expect(tx1).to.not.emit(dsm, "GuardianQuorumChanged");
      });

      it("Re-adds deleted guardian", async () => {
        await dsm.addGuardian(guardian1, 0);
        await dsm.addGuardian(guardian2, 0);
        expect((await dsm.getGuardians()).length).to.equal(2);

        await dsm.removeGuardian(guardian1, 0);
        expect((await dsm.getGuardians()).length).to.equal(1);

        await dsm.addGuardian(guardian1, 0);

        expect((await dsm.getGuardians()).length).to.equal(2);
        expect(await dsm.isGuardian(guardian1)).to.equal(true);
        expect(await dsm.getGuardians()).to.include(guardian1.address);
      });
    });

    context("Function `addGuardians`", () => {
      let originalState: string;

      beforeEach(async () => {
        originalState = await Snapshot.take();
      });

      afterEach(async () => {
        await Snapshot.restore(originalState);
      });

      it("Reverts if the `addGuardians` called by not an owner", async () => {
        await expect(dsm.connect(stranger).addGuardians([guardian1, guardian2], 0)).to.be.revertedWithCustomError(
          dsm,
          "NotAnOwner",
        );
      });

      it("Reverts if added zero address", async () => {
        await expect(dsm.addGuardians([guardian1, ZeroAddress, guardian2], 0)).to.be.revertedWithCustomError(
          dsm,
          "ZeroAddress",
        );
      });

      it("Reverts if added duplicate address", async () => {
        await dsm.addGuardian(guardian1, 0);

        await expect(dsm.addGuardians([guardian1, guardian2, guardian1], 0)).to.be.revertedWithCustomError(
          dsm,
          "DuplicateAddress",
        );
      });

      it("Re-adds deleted guardian", async () => {
        await dsm.addGuardians([guardian1, guardian2], 0);
        expect((await dsm.getGuardians()).length).to.equal(2);

        await dsm.removeGuardian(guardian1, 0);
        expect((await dsm.getGuardians()).length).to.equal(1);

        await dsm.addGuardians([guardian1], 0);

        expect((await dsm.getGuardians()).length).to.equal(2);
        expect(await dsm.isGuardian(guardian1)).to.equal(true);
        expect(await dsm.getGuardians()).to.include(guardian1.address);
      });
    });

    context("Function `removeGuardian`", () => {
      let originalState: string;

      beforeEach(async () => {
        originalState = await Snapshot.take();
      });

      afterEach(async () => {
        await Snapshot.restore(originalState);
      });

      it("Reverts if the `removeGuardian` called by not an owner", async () => {
        await expect(dsm.connect(stranger).removeGuardian(guardian1, 0)).to.be.revertedWithCustomError(
          dsm,
          "NotAnOwner",
        );
      });

      it("Reverts if the `addr` is non-guardian address", async () => {
        await dsm.addGuardian(guardian1, 0);
        await expect(dsm.removeGuardian(guardian2, 0)).to.be.revertedWithCustomError(dsm, "NotAGuardian");
      });

      it("Sets a new quorum on `removeGuardian` and fires `GuardianRemoved` and `GuardianQuorumChanged` event", async () => {
        const newQuorum = 2;

        await dsm.addGuardian(guardian1, 0);
        await dsm.addGuardian(guardian2, 1);
        const tx1 = await dsm.removeGuardian(guardian1, newQuorum);

        await expect(tx1).to.emit(dsm, "GuardianRemoved").withArgs(guardian1.address);

        await expect(tx1).to.emit(dsm, "GuardianQuorumChanged").withArgs(newQuorum);
      });

      it("Can be used to remove all guardians going from head", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 0);

        await dsm.removeGuardian(guardian1, 0);
        expect(await dsm.getGuardians()).to.deep.equal([guardian3.address, guardian2.address]);
        expect(await dsm.getGuardianIndex(guardian1)).to.equal(-1);
        expect(await dsm.getGuardianIndex(guardian2)).to.equal(1);
        expect(await dsm.getGuardianIndex(guardian3)).to.equal(0);

        await dsm.removeGuardian(guardian3, 0);
        expect(await dsm.getGuardians()).to.deep.equal([guardian2.address]);
        expect(await dsm.getGuardianIndex(guardian1)).to.equal(-1);
        expect(await dsm.getGuardianIndex(guardian2)).to.equal(0);
        expect(await dsm.getGuardianIndex(guardian3)).to.equal(-1);

        await dsm.removeGuardian(guardian2, 0);
        expect(await dsm.getGuardians()).to.deep.equal([]);
        expect(await dsm.getGuardianIndex(guardian1)).to.equal(-1);
        expect(await dsm.getGuardianIndex(guardian2)).to.equal(-1);
        expect(await dsm.getGuardianIndex(guardian3)).to.equal(-1);
      });

      it("Can be used to remove all guardians going from tail", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 0);

        await dsm.removeGuardian(guardian3, 0);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address]);
        expect(await dsm.getGuardianIndex(guardian1)).to.equal(0);
        expect(await dsm.getGuardianIndex(guardian2)).to.equal(1);
        expect(await dsm.getGuardianIndex(guardian3)).to.equal(-1);

        await dsm.removeGuardian(guardian2, 0);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect(await dsm.getGuardianIndex(guardian1)).to.equal(0);
        expect(await dsm.getGuardianIndex(guardian2)).to.equal(-1);
        expect(await dsm.getGuardianIndex(guardian3)).to.equal(-1);

        await dsm.removeGuardian(guardian1, 0);
        expect(await dsm.getGuardians()).to.deep.equal([]);
        expect(await dsm.getGuardianIndex(guardian1)).to.equal(-1);
        expect(await dsm.getGuardianIndex(guardian2)).to.equal(-1);
        expect(await dsm.getGuardianIndex(guardian3)).to.equal(-1);
      });

      it("Can be used to remove all guardians going from the middle", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 0);

        await dsm.removeGuardian(guardian2, 0);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian3.address]);
        expect(await dsm.getGuardianIndex(guardian1)).to.equal(0);
        expect(await dsm.getGuardianIndex(guardian2)).to.equal(-1);
        expect(await dsm.getGuardianIndex(guardian3)).to.equal(1);
      });
    });
  });

  context("Function `pauseDeposits`", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();

      await dsm.addGuardians([guardian1, guardian2], 0);
    });

    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    it("Reverts if staking module is unregistered and fires `StakingModuleUnregistered` event on StakingRouter contract", async () => {
      const blockNumber = 1;

      const sig: DepositSecurityModule.SignatureStruct = {
        r: encodeBytes32String(""),
        vs: encodeBytes32String(""),
      };

      await expect(dsm.pauseDeposits(blockNumber, UNREGISTERED_STAKING_MODULE_ID, sig)).to.be.revertedWithCustomError(
        stakingRouter,
        "StakingModuleUnregistered",
      );
    });

    it("Reverts if signature is invalid", async () => {
      const blockNumber = 1;

      const sig: DepositSecurityModule.SignatureStruct = {
        r: encodeBytes32String(""),
        vs: encodeBytes32String(""),
      };

      await expect(dsm.pauseDeposits(blockNumber, STAKING_MODULE_ID, sig)).to.be.revertedWith(
        "ECDSA: invalid signature",
      );
    });

    it("Reverts if signature is not guardian", async () => {
      const blockNumber = await time.latestBlock();
      const validPauseMessage = new DSMPauseMessage(blockNumber, STAKING_MODULE_ID);

      const sig = validPauseMessage.sign(guardian3.privateKey);

      await expect(dsm.pauseDeposits(blockNumber, STAKING_MODULE_ID, sig)).to.be.revertedWithCustomError(
        dsm,
        "InvalidSignature",
      );
    });

    it("Reverts if called by an anon submitting an unrelated sig", async () => {
      const blockNumber = await time.latestBlock();
      const validPauseMessage = new DSMPauseMessage(blockNumber, STAKING_MODULE_ID);

      const sig = validPauseMessage.sign(guardian3.privateKey);

      await expect(
        dsm.connect(stranger).pauseDeposits(blockNumber, STAKING_MODULE_ID, sig),
      ).to.be.revertedWithCustomError(dsm, "InvalidSignature");
    });

    it("Reverts if called with an expired `blockNumber` by a guardian", async () => {
      const blockNumber = await time.latestBlock();
      const staleBlockNumber = blockNumber - PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS;
      const validPauseMessage = new DSMPauseMessage(blockNumber, STAKING_MODULE_ID);

      const sig = validPauseMessage.sign(guardian1.privateKey);

      await expect(
        dsm.connect(guardian1).pauseDeposits(staleBlockNumber, STAKING_MODULE_ID, sig),
      ).to.be.revertedWithCustomError(dsm, "PauseIntentExpired");
    });

    it("Reverts if called with an expired `blockNumber` by an anon submitting a guardian's sig", async () => {
      const blockNumber = await time.latestBlock();
      const staleBlockNumber = blockNumber - PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS;

      const stalePauseMessage = new DSMPauseMessage(staleBlockNumber, STAKING_MODULE_ID);
      const sig = stalePauseMessage.sign(guardian1.privateKey);

      await expect(
        dsm.connect(stranger).pauseDeposits(staleBlockNumber, STAKING_MODULE_ID, sig),
      ).to.be.revertedWithCustomError(dsm, "PauseIntentExpired");
    });

    it("Reverts if called with a future `blockNumber` by a guardian", async () => {
      const futureBlockNumber = (await time.latestBlock()) + 100;

      const sig: DepositSecurityModule.SignatureStruct = {
        r: encodeBytes32String(""),
        vs: encodeBytes32String(""),
      };

      await expect(
        dsm.connect(guardian1).pauseDeposits(futureBlockNumber, STAKING_MODULE_ID, sig),
      ).to.be.revertedWithPanic(PANIC_CODES.ARITHMETIC_OVERFLOW);
    });

    it("Reverts if called with a future `blockNumber` by an anon submitting a guardian's sig", async () => {
      const futureBlockNumber = (await time.latestBlock()) + 100;

      const futurePauseMessage = new DSMPauseMessage(futureBlockNumber, STAKING_MODULE_ID);
      const sig = futurePauseMessage.sign(guardian1.privateKey);

      await expect(
        dsm.connect(stranger).pauseDeposits(futureBlockNumber, STAKING_MODULE_ID, sig),
      ).to.be.revertedWithPanic(PANIC_CODES.ARITHMETIC_OVERFLOW);
    });

    it("Pause if called by guardian and fires `DepositsPaused` and `StakingModuleStatusSet` events", async () => {
      const blockNumber = await time.latestBlock();
      const sig: DepositSecurityModule.SignatureStruct = {
        r: encodeBytes32String(""),
        vs: encodeBytes32String(""),
      };

      const tx = await dsm.connect(guardian1).pauseDeposits(blockNumber, STAKING_MODULE_ID, sig);

      await expect(tx).to.emit(dsm, "DepositsPaused").withArgs(guardian1.address, STAKING_MODULE_ID);
      await expect(tx)
        .to.emit(stakingRouter, "StakingModuleStatusSet")
        .withArgs(STAKING_MODULE_ID, StakingModuleStatus.DepositsPaused, await dsm.getAddress());
    });

    it("Pause if called by anon submitting sig of guardian", async () => {
      const blockNumber = await time.latestBlock();

      const validPauseMessage = new DSMPauseMessage(blockNumber, STAKING_MODULE_ID);
      const sig = validPauseMessage.sign(guardian2.privateKey);

      const tx = await dsm.connect(stranger).pauseDeposits(blockNumber, STAKING_MODULE_ID, sig);

      await expect(tx).to.emit(dsm, "DepositsPaused").withArgs(guardian2.address, STAKING_MODULE_ID);
      await expect(tx)
        .to.emit(stakingRouter, "StakingModuleStatusSet")
        .withArgs(STAKING_MODULE_ID, StakingModuleStatus.DepositsPaused, await dsm.getAddress());
    });

    it("Do not pause and emits events if was paused before", async () => {
      const blockNumber = await time.latestBlock();

      const validPauseMessage = new DSMPauseMessage(blockNumber, STAKING_MODULE_ID);
      const sig = validPauseMessage.sign(guardian2.privateKey);

      const tx1 = await dsm.connect(stranger).pauseDeposits(blockNumber, STAKING_MODULE_ID, sig);

      await expect(tx1).to.emit(dsm, "DepositsPaused").withArgs(guardian2.address, STAKING_MODULE_ID);
      await expect(tx1)
        .to.emit(stakingRouter, "StakingModuleStatusSet")
        .withArgs(STAKING_MODULE_ID, StakingModuleStatus.DepositsPaused, await dsm.getAddress());

      const tx2 = await dsm.connect(stranger).pauseDeposits(blockNumber, STAKING_MODULE_ID, sig);
      await expect(tx2).to.not.emit(dsm, "DepositsPaused");
      await expect(tx2).to.not.emit(stakingRouter, "StakingModuleStatusSet");
    });
  });

  context("Function `unpauseDeposits`", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();

      await dsm.addGuardians([guardian1, guardian2], 0);

      const blockNumber = await time.latestBlock();

      const validPauseMessage = new DSMPauseMessage(blockNumber, STAKING_MODULE_ID);
      const sig = validPauseMessage.sign(guardian2.privateKey);

      const tx = await dsm.connect(stranger).pauseDeposits(blockNumber, STAKING_MODULE_ID, sig);

      await expect(tx).to.emit(dsm, "DepositsPaused").withArgs(guardian2.address, STAKING_MODULE_ID);
      await expect(tx)
        .to.emit(stakingRouter, "StakingModuleStatusSet")
        .withArgs(STAKING_MODULE_ID, StakingModuleStatus.DepositsPaused, await dsm.getAddress());
    });

    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    it("Reverts if called by not an owner", async () => {
      await expect(dsm.connect(stranger).unpauseDeposits(UNREGISTERED_STAKING_MODULE_ID)).to.be.revertedWithCustomError(
        dsm,
        "NotAnOwner",
      );
    });

    it("Reverts if staking module is unregistered and fires `StakingModuleUnregistered` event on StakingRouter contract", async () => {
      await expect(dsm.unpauseDeposits(UNREGISTERED_STAKING_MODULE_ID)).to.be.revertedWithCustomError(
        stakingRouter,
        "StakingModuleUnregistered",
      );
    });

    it("No events on active module", async () => {
      expect(await stakingRouter.getStakingModuleStatus(STAKING_MODULE_ID)).to.equal(
        StakingModuleStatus.DepositsPaused,
      );
      await stakingRouter.setStakingModuleStatus(STAKING_MODULE_ID, StakingModuleStatus.Active);
      expect(await stakingRouter.getStakingModuleStatus(STAKING_MODULE_ID)).to.equal(StakingModuleStatus.Active);

      await expect(dsm.unpauseDeposits(STAKING_MODULE_ID)).to.not.emit(dsm, "DepositsUnpaused");
    });

    it("No events on stopped module", async () => {
      expect(await stakingRouter.getStakingModuleStatus(STAKING_MODULE_ID)).to.equal(
        StakingModuleStatus.DepositsPaused,
      );
      await stakingRouter.setStakingModuleStatus(STAKING_MODULE_ID, StakingModuleStatus.Stopped);
      expect(await stakingRouter.getStakingModuleStatus(STAKING_MODULE_ID)).to.equal(StakingModuleStatus.Stopped);

      await expect(dsm.unpauseDeposits(STAKING_MODULE_ID)).to.not.emit(dsm, "DepositsUnpaused");
    });

    it("Unpause if called by owner and module status is `DepositsPaused` and fires events", async () => {
      expect(await stakingRouter.getStakingModuleStatus(STAKING_MODULE_ID)).to.equal(
        StakingModuleStatus.DepositsPaused,
      );

      const tx = await dsm.unpauseDeposits(STAKING_MODULE_ID);

      await expect(tx).to.emit(dsm, "DepositsUnpaused").withArgs(STAKING_MODULE_ID);
      await expect(tx)
        .to.emit(stakingRouter, "StakingModuleStatusSet")
        .withArgs(STAKING_MODULE_ID, StakingModuleStatus.Active, await dsm.getAddress());
    });
  });

  context("Function `canDeposit`", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();
    });

    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    it("Returns `false` if staking module is unregistered in StakingRouter", async () => {
      expect(await dsm.canDeposit(UNREGISTERED_STAKING_MODULE_ID)).to.equal(false);
    });

    it("Returns `true` if: \n\t\t1) StakingModule is not paused \n\t\t2) DSN quorum > 0 \n\t\t3) block.number - lastDepositBlock >= minDepositBlockDistance \n\t\t4) Lido.canDeposit() is true", async () => {
      expect(await stakingRouter.getStakingModuleIsActive(STAKING_MODULE_ID)).to.equal(true);

      await dsm.addGuardian(guardian1, 1);
      expect(await dsm.getGuardianQuorum()).to.equal(1);

      const lastDepositBlockNumber = await time.latestBlock();
      await stakingRouter.setStakingModuleLastDepositBlock(lastDepositBlockNumber);
      await mineUpTo((await time.latestBlock()) + MIN_DEPOSIT_BLOCK_DISTANCE);

      const currentBlockNumber = await time.latestBlock();
      const minDepositBlockDistance = await dsm.getMinDepositBlockDistance();

      expect(currentBlockNumber - lastDepositBlockNumber >= minDepositBlockDistance).to.equal(true);
      expect(await lido.canDeposit()).to.equal(true);
      expect(await dsm.canDeposit(STAKING_MODULE_ID)).to.equal(true);
    });

    it("Returns `false` if: \n\t\t1) StakingModule is paused \n\t\t2) DSN quorum > 0 \n\t\t3) block.number - lastDepositBlock >= minDepositBlockDistance \n\t\t4) Lido.canDeposit() is true", async () => {
      expect(await stakingRouter.getStakingModuleIsActive(STAKING_MODULE_ID)).to.equal(true);
      await stakingRouter.setStakingModuleStatus(STAKING_MODULE_ID, StakingModuleStatus.DepositsPaused);
      expect(await stakingRouter.getStakingModuleIsDepositsPaused(STAKING_MODULE_ID)).to.equal(true);

      await dsm.addGuardian(guardian1, 1);
      expect(await dsm.getGuardianQuorum()).to.equal(1);

      const lastDepositBlockNumber = await time.latestBlock();
      await stakingRouter.setStakingModuleLastDepositBlock(lastDepositBlockNumber);
      await mineUpTo((await time.latestBlock()) + MIN_DEPOSIT_BLOCK_DISTANCE);

      const currentBlockNumber = await time.latestBlock();
      const minDepositBlockDistance = await dsm.getMinDepositBlockDistance();

      expect(currentBlockNumber - lastDepositBlockNumber >= minDepositBlockDistance).to.equal(true);
      expect(await lido.canDeposit()).to.equal(true);
      expect(await dsm.canDeposit(STAKING_MODULE_ID)).to.equal(false);
    });

    it("Returns `false` if: \n\t\t1) StakingModule is not paused \n\t\t2) DSN quorum = 0 \n\t\t3) block.number - lastDepositBlock >= minDepositBlockDistance \n\t\t4) Lido.canDeposit() is true", async () => {
      expect(await stakingRouter.getStakingModuleIsActive(STAKING_MODULE_ID)).to.equal(true);

      await dsm.addGuardian(guardian1, 0);
      expect(await dsm.getGuardianQuorum()).to.equal(0);

      const lastDepositBlockNumber = await time.latestBlock();
      await stakingRouter.setStakingModuleLastDepositBlock(lastDepositBlockNumber);
      await mineUpTo((await time.latestBlock()) + MIN_DEPOSIT_BLOCK_DISTANCE);

      const currentBlockNumber = await time.latestBlock();
      const minDepositBlockDistance = await dsm.getMinDepositBlockDistance();

      expect(currentBlockNumber - lastDepositBlockNumber >= minDepositBlockDistance).to.equal(true);
      expect(await lido.canDeposit()).to.equal(true);
      expect(await dsm.canDeposit(STAKING_MODULE_ID)).to.equal(false);
    });

    it("Returns `false` if: \n\t\t1) StakingModule is not paused \n\t\t2) DSN quorum > 0 \n\t\t3) block.number - lastDepositBlock < minDepositBlockDistance \n\t\t4) Lido.canDeposit() is true", async () => {
      expect(await stakingRouter.getStakingModuleIsActive(STAKING_MODULE_ID)).to.equal(true);

      await dsm.addGuardian(guardian1, 1);
      expect(await dsm.getGuardianQuorum()).to.equal(1);

      const lastDepositBlockNumber = await time.latestBlock();
      await stakingRouter.setStakingModuleLastDepositBlock(lastDepositBlockNumber);
      await mineUpTo((await time.latestBlock()) + MIN_DEPOSIT_BLOCK_DISTANCE / 2);

      const currentBlockNumber = await time.latestBlock();
      const minDepositBlockDistance = await dsm.getMinDepositBlockDistance();

      expect(currentBlockNumber - lastDepositBlockNumber < minDepositBlockDistance).to.equal(true);
      expect(await lido.canDeposit()).to.equal(true);
      expect(await dsm.canDeposit(STAKING_MODULE_ID)).to.equal(false);
    });

    it("Returns `false` if: \n\t\t1) StakingModule is not paused \n\t\t2) DSN quorum > 0 \n\t\t3) block.number - lastDepositBlock >= minDepositBlockDistance \n\t\t4) Lido.canDeposit() is false", async () => {
      expect(await stakingRouter.getStakingModuleIsActive(STAKING_MODULE_ID)).to.equal(true);

      await dsm.addGuardian(guardian1, 1);
      expect(await dsm.getGuardianQuorum()).to.equal(1);

      const lastDepositBlockNumber = await time.latestBlock();
      await stakingRouter.setStakingModuleLastDepositBlock(lastDepositBlockNumber);
      await mineUpTo((await time.latestBlock()) + 2 * MIN_DEPOSIT_BLOCK_DISTANCE);

      const currentBlockNumber = await time.latestBlock();
      const minDepositBlockDistance = await dsm.getMinDepositBlockDistance();

      expect(currentBlockNumber - lastDepositBlockNumber >= minDepositBlockDistance).to.equal(true);

      await lido.setCanDeposit(false);
      expect(await lido.canDeposit()).to.equal(false);

      expect(await dsm.canDeposit(STAKING_MODULE_ID)).to.equal(false);
    });
  });

  context("Function `depositBufferedEther`", () => {
    let originalState: string;
    let validAttestMessage: DSMAttestMessage;
    let block: Block;

    beforeEach(async () => {
      originalState = await Snapshot.take();
      block = await getLatestBlock();

      await stakingRouter.setStakingModuleNonce(DEPOSIT_NONCE);
      expect(await stakingRouter.getStakingModuleNonce(STAKING_MODULE_ID)).to.equal(DEPOSIT_NONCE);

      validAttestMessage = new DSMAttestMessage(
        block.number,
        block.hash,
        DEPOSIT_ROOT,
        STAKING_MODULE_ID,
        DEPOSIT_NONCE,
      );
    });

    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    context("Total guardians: 0, quorum: 0", () => {
      it("Reverts if no quorum", async () => {
        expect(await dsm.getGuardianQuorum()).to.equal(0);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures: DepositSecurityModule.SignatureStruct[] = [];
        await expect(
          dsm.depositBufferedEther(
            block.number,
            block.hash,
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          ),
        ).to.be.revertedWithCustomError(dsm, "DepositNoQuorum");
      });
    });

    context("Total guardians: 1, quorum: 0", () => {
      it("Reverts if no quorum", async () => {
        await dsm.addGuardian(guardian1, 0);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect((await dsm.getGuardians()).length).to.equal(1);
        expect(await dsm.getGuardianQuorum()).to.equal(0);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures: DepositSecurityModule.SignatureStruct[] = [];
        await expect(
          dsm.depositBufferedEther(
            block.number,
            block.hash,
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          ),
        ).to.be.revertedWithCustomError(dsm, "DepositNoQuorum");
      });
    });

    context("Total guardians: 1, quorum: 1", () => {
      it("Reverts if no guardian signatures", async () => {
        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect((await dsm.getGuardians()).length).to.equal(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures: DepositSecurityModule.SignatureStruct[] = [];
        await expect(
          dsm.depositBufferedEther(
            block.number,
            block.hash,
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          ),
        ).to.be.revertedWithCustomError(dsm, "DepositNoQuorum");
      });

      it("Reverts if deposit with an unrelated sig", async () => {
        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect((await dsm.getGuardians()).length).to.equal(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures: DepositSecurityModule.SignatureStruct[] = [
          validAttestMessage.sign(guardian2.privateKey),
        ];

        await expect(
          dsm.depositBufferedEther(
            block.number,
            block.hash,
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          ),
        ).to.be.revertedWithCustomError(dsm, "InvalidSignature");
      });

      it("Reverts if deposit contract root changed", async () => {
        const depositRootBefore = await depositContract.get_deposit_root();
        const newDepositRoot = "0x9daddc4daa5915981fd9f1bcc367a2be1389b017d5c24a58d44249a5dbb60289";
        await depositContract.set_deposit_root(newDepositRoot);
        expect(await depositContract.get_deposit_root()).to.equal(newDepositRoot);
        expect(await depositContract.get_deposit_root()).to.not.equal(depositRootBefore);

        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect((await dsm.getGuardians()).length).to.equal(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures: DepositSecurityModule.SignatureStruct[] = [
          validAttestMessage.sign(guardian1.privateKey),
        ];

        await expect(
          dsm.depositBufferedEther(
            block.number,
            block.hash,
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          ),
        ).to.be.revertedWithCustomError(dsm, "DepositRootChanged");
      });

      it("Reverts if nonce changed", async () => {
        const nonceBefore = await stakingRouter.getStakingModuleNonce(STAKING_MODULE_ID);
        const newNonce = 11;
        await stakingRouter.setStakingModuleNonce(newNonce);
        expect(await stakingRouter.getStakingModuleNonce(STAKING_MODULE_ID)).to.equal(newNonce);
        expect(await stakingRouter.getStakingModuleNonce(STAKING_MODULE_ID)).to.not.equal(nonceBefore);

        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect((await dsm.getGuardians()).length).to.equal(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures: DepositSecurityModule.SignatureStruct[] = [
          validAttestMessage.sign(guardian1.privateKey),
        ];

        await expect(
          dsm.depositBufferedEther(
            block.number,
            block.hash,
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          ),
        ).to.be.revertedWithCustomError(dsm, "DepositNonceChanged");
      });

      it("Reverts if deposit too frequent", async () => {
        await stakingRouter.setStakingModuleLastDepositBlock(block.number - 1);

        const latestBlock = await getLatestBlock();
        const lastDepositBlock = await stakingRouter.getStakingModuleLastDepositBlock(STAKING_MODULE_ID);
        expect(BigInt(latestBlock.number) - BigInt(lastDepositBlock) < BigInt(MIN_DEPOSIT_BLOCK_DISTANCE)).to.equal(
          true,
        );

        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect((await dsm.getGuardians()).length).to.equal(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures: DepositSecurityModule.SignatureStruct[] = [
          validAttestMessage.sign(guardian1.privateKey),
        ];

        await expect(
          dsm.depositBufferedEther(
            block.number,
            block.hash,
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          ),
        ).to.be.revertedWithCustomError(dsm, "DepositTooFrequent");
      });

      it("Reverts if module is inactive", async () => {
        await stakingRouter.pauseStakingModule(STAKING_MODULE_ID);

        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect((await dsm.getGuardians()).length).to.equal(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures: DepositSecurityModule.SignatureStruct[] = [
          validAttestMessage.sign(guardian1.privateKey),
        ];

        await expect(
          dsm.depositBufferedEther(
            block.number,
            block.hash,
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          ),
        ).to.be.revertedWithCustomError(dsm, "DepositInactiveModule");
      });

      it("Reverts if `block.hash` and `block.number` from different blocks", async () => {
        await mineUpTo((await time.latestBlock()) + 1);
        const latestBlock = await getLatestBlock();
        expect(latestBlock.number > block.number).to.equal(true);

        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect((await dsm.getGuardians()).length).to.equal(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures: DepositSecurityModule.SignatureStruct[] = [
          validAttestMessage.sign(guardian1.privateKey),
        ];

        await expect(
          dsm.depositBufferedEther(
            latestBlock.number,
            block.hash,
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          ),
        ).to.be.revertedWithCustomError(dsm, "DepositUnexpectedBlockHash");
      });

      it("Reverts if deposit with zero `block.hash`", async () => {
        await mineUpTo((await time.latestBlock()) + 255);
        const latestBlock = await getLatestBlock();
        expect(latestBlock.number > block.number).to.equal(true);

        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect((await dsm.getGuardians()).length).to.equal(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures: DepositSecurityModule.SignatureStruct[] = [
          validAttestMessage.sign(guardian1.privateKey),
        ];

        await expect(
          dsm.depositBufferedEther(
            latestBlock.number,
            encodeBytes32String(""),
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          ),
        ).to.be.revertedWithCustomError(dsm, "DepositUnexpectedBlockHash");
      });

      it("Deposit with the guardian's sig", async () => {
        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect((await dsm.getGuardians()).length).to.equal(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures: DepositSecurityModule.SignatureStruct[] = [
          validAttestMessage.sign(guardian1.privateKey),
        ];

        const tx = await dsm
          .connect(stranger)
          .depositBufferedEther(
            block.number,
            block.hash,
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          );

        await expect(tx)
          .to.emit(lido, "StakingModuleDeposited")
          .withArgs(MAX_DEPOSITS_PER_BLOCK, STAKING_MODULE_ID, depositCalldata);
      });
    });

    context("Total guardians: 3, quorum: 2", () => {
      it("Reverts if no signatures", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect((await dsm.getGuardians()).length).to.equal(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures: DepositSecurityModule.SignatureStruct[] = [];

        await expect(
          dsm
            .connect(stranger)
            .depositBufferedEther(
              block.number,
              block.hash,
              DEPOSIT_ROOT,
              STAKING_MODULE_ID,
              DEPOSIT_NONCE,
              depositCalldata,
              sortedGuardianSignatures,
            ),
        ).to.be.revertedWithCustomError(dsm, "DepositNoQuorum");
      });

      it("Reverts if signatures < quorum", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect((await dsm.getGuardians()).length).to.equal(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures = [validAttestMessage.sign(guardian1.privateKey)];

        await expect(
          dsm
            .connect(stranger)
            .depositBufferedEther(
              block.number,
              block.hash,
              DEPOSIT_ROOT,
              STAKING_MODULE_ID,
              DEPOSIT_NONCE,
              depositCalldata,
              sortedGuardianSignatures,
            ),
        ).to.be.revertedWithCustomError(dsm, "DepositNoQuorum");
      });

      it("Reverts if deposit with guardian's sigs (1,0) with `SignaturesNotSorted` exception", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect((await dsm.getGuardians()).length).to.equal(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures = [
          validAttestMessage.sign(guardian2.privateKey),
          validAttestMessage.sign(guardian1.privateKey),
        ];

        await expect(
          dsm
            .connect(stranger)
            .depositBufferedEther(
              block.number,
              block.hash,
              DEPOSIT_ROOT,
              STAKING_MODULE_ID,
              DEPOSIT_NONCE,
              depositCalldata,
              sortedGuardianSignatures,
            ),
        ).to.be.revertedWithCustomError(dsm, "SignaturesNotSorted");
      });

      it("Reverts if deposit with guardian's sigs (0,0,1) with `SignaturesNotSorted` exception", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect((await dsm.getGuardians()).length).to.equal(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures = [
          validAttestMessage.sign(guardian1.privateKey),
          validAttestMessage.sign(guardian1.privateKey),
          validAttestMessage.sign(guardian2.privateKey),
        ];

        await expect(
          dsm
            .connect(stranger)
            .depositBufferedEther(
              block.number,
              block.hash,
              DEPOSIT_ROOT,
              STAKING_MODULE_ID,
              DEPOSIT_NONCE,
              depositCalldata,
              sortedGuardianSignatures,
            ),
        ).to.be.revertedWithCustomError(dsm, "SignaturesNotSorted");
      });

      it("Reverts if deposit with guardian's sigs (0,0,1) with `InvalidSignature` exception", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect((await dsm.getGuardians()).length).to.equal(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures = [
          validAttestMessage.sign(guardian1.privateKey),
          validAttestMessage.sign(unrelatedGuardian1.privateKey),
          validAttestMessage.sign(unrelatedGuardian2.privateKey),
        ];

        await expect(
          dsm
            .connect(stranger)
            .depositBufferedEther(
              block.number,
              block.hash,
              DEPOSIT_ROOT,
              STAKING_MODULE_ID,
              DEPOSIT_NONCE,
              depositCalldata,
              sortedGuardianSignatures,
            ),
        ).to.be.revertedWithCustomError(dsm, "InvalidSignature");
      });

      it("Allow deposit if deposit with guardian's sigs (0,1,2)", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect((await dsm.getGuardians()).length).to.equal(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures = [
          validAttestMessage.sign(guardian1.privateKey),
          validAttestMessage.sign(guardian2.privateKey),
          validAttestMessage.sign(guardian3.privateKey),
        ];

        const tx = await dsm
          .connect(stranger)
          .depositBufferedEther(
            block.number,
            block.hash,
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          );

        await expect(tx)
          .to.emit(lido, "StakingModuleDeposited")
          .withArgs(MAX_DEPOSITS_PER_BLOCK, STAKING_MODULE_ID, depositCalldata);
      });

      it("Allow deposit if deposit with guardian's sigs (0,1)", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect((await dsm.getGuardians()).length).to.equal(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures = [
          validAttestMessage.sign(guardian1.privateKey),
          validAttestMessage.sign(guardian2.privateKey),
        ];

        const tx = await dsm
          .connect(stranger)
          .depositBufferedEther(
            block.number,
            block.hash,
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          );

        await expect(tx)
          .to.emit(lido, "StakingModuleDeposited")
          .withArgs(MAX_DEPOSITS_PER_BLOCK, STAKING_MODULE_ID, depositCalldata);
      });

      it("Allow deposit if deposit with guardian's sigs (0,2)", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect((await dsm.getGuardians()).length).to.equal(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures = [
          validAttestMessage.sign(guardian1.privateKey),
          validAttestMessage.sign(guardian3.privateKey),
        ];

        const tx = await dsm
          .connect(stranger)
          .depositBufferedEther(
            block.number,
            block.hash,
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          );

        await expect(tx)
          .to.emit(lido, "StakingModuleDeposited")
          .withArgs(MAX_DEPOSITS_PER_BLOCK, STAKING_MODULE_ID, depositCalldata);
      });

      it("Allow deposit if deposit with guardian's sigs (1,2)", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect((await dsm.getGuardians()).length).to.equal(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        const depositCalldata = encodeBytes32String("");
        const sortedGuardianSignatures = [
          validAttestMessage.sign(guardian2.privateKey),
          validAttestMessage.sign(guardian3.privateKey),
        ];

        const tx = await dsm
          .connect(stranger)
          .depositBufferedEther(
            block.number,
            block.hash,
            DEPOSIT_ROOT,
            STAKING_MODULE_ID,
            DEPOSIT_NONCE,
            depositCalldata,
            sortedGuardianSignatures,
          );

        await expect(tx)
          .to.emit(lido, "StakingModuleDeposited")
          .withArgs(MAX_DEPOSITS_PER_BLOCK, STAKING_MODULE_ID, depositCalldata);
      });
    });
  });
});
