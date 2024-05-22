import { expect } from "chai";
import {
  concat,
  ContractTransactionResponse,
  encodeBytes32String,
  keccak256,
  solidityPacked,
  Wallet,
  ZeroAddress,
  ZeroHash,
} from "ethers";
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
const MAX_OPERATORS_PER_UNVETTING = 20;
const MODULE_NONCE = 12;
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
  pauseIntentValidityPeriodBlocks: number;
  unvetIntentValidityPeriodBlocks: number;
  maxOperatorsPerUnvetting: number;
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
    pauseIntentValidityPeriodBlocks: PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS,
    maxOperatorsPerUnvetting: MAX_OPERATORS_PER_UNVETTING,
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

  type DepositArgs = {
    blockNumber?: number;
    blockHash?: string;
    depositRoot?: string;
    stakingModuleId?: number;
    nonce?: number;
    depositCalldata?: string;
  };

  async function getDepositArgs(overridingArgs?: DepositArgs) {
    const stakingModuleId = overridingArgs?.stakingModuleId ?? STAKING_MODULE_ID;

    const [latestBlock, defaultDepositRoot, defaultModuleNonce] = await Promise.all([
      getLatestBlock(),
      depositContract.get_deposit_root(),
      stakingRouter.getStakingModuleNonce(stakingModuleId),
    ]);

    const blockNumber = overridingArgs?.blockNumber ?? latestBlock.number;
    const blockHash = overridingArgs?.blockHash ?? latestBlock.hash;
    const depositRoot = overridingArgs?.depositRoot ?? defaultDepositRoot;
    const nonce = overridingArgs?.nonce ?? Number(defaultModuleNonce);
    const depositCalldata = overridingArgs?.depositCalldata ?? encodeBytes32String("");

    return [depositCalldata, blockNumber, blockHash, depositRoot, stakingModuleId, nonce] as const;
  }

  async function deposit(
    sortedGuardianWallets: Wallet[],
    overridingArgs?: DepositArgs,
  ): Promise<ContractTransactionResponse> {
    const [depositCalldata, ...signingArgs] = await getDepositArgs(overridingArgs);

    const sortedGuardianSignatures = sortedGuardianWallets.map((guardian) => {
      const validAttestMessage = new DSMAttestMessage(...signingArgs);
      return validAttestMessage.sign(guardian.privateKey);
    });

    return await dsm.depositBufferedEther(...signingArgs, depositCalldata, sortedGuardianSignatures);
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
    DSMUnvetMessage.setMessagePrefix(await dsm.UNVET_MESSAGE_PREFIX());

    await stakingRouter.setStakingModuleMinDepositBlockDistance(MIN_DEPOSIT_BLOCK_DISTANCE);
    const minDepositBlockDistance = await stakingRouter.getStakingModuleMinDepositBlockDistance(STAKING_MODULE_ID);
    expect(minDepositBlockDistance).to.equal(MIN_DEPOSIT_BLOCK_DISTANCE);

    await stakingRouter.setStakingModuleMaxDepositsPerBlock(MAX_DEPOSITS_PER_BLOCK);
    const maxDepositsPerBlock = await stakingRouter.getStakingModuleMaxDepositsPerBlock(STAKING_MODULE_ID);
    expect(maxDepositsPerBlock).to.equal(MAX_DEPOSITS_PER_BLOCK);

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

    it("Sets `lastDepositBlock` to deployment block", async () => {
      const tx = await dsm.deploymentTransaction();
      const deploymentBlock = tx?.blockNumber;

      expect(deploymentBlock).to.be.an("number");
      expect(await dsm.getLastDepositBlock()).to.equal(deploymentBlock);
      await expect(tx).to.emit(dsm, "LastDepositBlockChanged").withArgs(deploymentBlock);
    });
  });

  context("Constants", () => {
    it("Returns the VERSION variable", async () => {
      expect(await dsm.VERSION()).to.equal(3);
    });

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

    it("Returns the UNVET_MESSAGE_PREFIX variable", async () => {
      const dsmUnvetMessagePrefix = streccak("lido.DepositSecurityModule.UNVET_MESSAGE");
      expect(dsmUnvetMessagePrefix).to.equal("0x2dd9727393562ed11c29080a884630e2d3a7078e71b313e713a8a1ef68948f6a");

      const encodedPauseMessagePrefix = keccak256(
        solidityPacked(
          ["bytes32", "uint256", "address"],
          [dsmUnvetMessagePrefix, network.config.chainId, await dsm.getAddress()],
        ),
      );

      expect(await dsm.UNVET_MESSAGE_PREFIX()).to.equal(encodedPauseMessagePrefix);
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

  context("Max operators per unvetting", () => {
    context("Function `getMaxOperatorsPerUnvetting`", () => {
      it("Returns `maxDepositsPerBlock`", async () => {
        expect(await dsm.getMaxOperatorsPerUnvetting()).to.equal(config.maxOperatorsPerUnvetting);
      });
    });

    context("Function `setMaxOperatorsPerUnvetting`", () => {
      let originalState: string;

      before(async () => {
        originalState = await Snapshot.take();
      });

      after(async () => {
        await Snapshot.restore(originalState);
      });

      it("Reverts if the `newValue` is zero parameter", async () => {
        await expect(dsm.setMaxOperatorsPerUnvetting(0)).to.be.revertedWithCustomError(dsm, "ZeroParameter");
      });

      it("Reverts if the `setMaxOperatorsPerUnvetting` called by not an owner", async () => {
        await expect(
          dsm.connect(stranger).setMaxOperatorsPerUnvetting(config.maxOperatorsPerUnvetting + 1),
        ).to.be.revertedWithCustomError(dsm, "NotAnOwner");
      });

      it("Sets `maxOperatorsPerUnvetting` and fires `MaxOperatorsPerUnvettingChanged` event", async () => {
        const valueBefore = await dsm.getMaxOperatorsPerUnvetting();

        const newValue = config.maxOperatorsPerUnvetting + 1;
        await expect(dsm.setMaxOperatorsPerUnvetting(newValue))
          .to.emit(dsm, "MaxOperatorsPerUnvettingChanged")
          .withArgs(newValue);

        expect(await dsm.getMaxOperatorsPerUnvetting()).to.equal(newValue);
        expect(await dsm.getMaxOperatorsPerUnvetting()).to.not.equal(valueBefore);
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
        expect(await dsm.getGuardians()).to.have.length(0);
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

        expect(await dsm.getGuardians()).to.have.length(2);
        expect(await dsm.isGuardian(guardian3)).to.equal(false);
      });

      it("Returns true non-guardian", async () => {
        await dsm.addGuardian(guardian1, 0);
        await dsm.addGuardian(guardian2, 0);

        expect(await dsm.getGuardians()).to.have.length(2);
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

        expect(await dsm.getGuardians()).to.have.length(2);
        expect(await dsm.getGuardianIndex(guardian3)).to.equal(-1);
      });

      it("Returns index of the guardian", async () => {
        await dsm.addGuardian(guardian1, 0);
        await dsm.addGuardian(guardian2, 0);

        expect(await dsm.getGuardians()).to.have.length(2);
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
        expect(await dsm.getGuardians()).to.have.length(1);
        expect(await dsm.getGuardianQuorum()).to.equal(newQuorum);

        await expect(tx1).to.emit(dsm, "GuardianAdded").withArgs(guardian1.address);

        await expect(tx1).to.emit(dsm, "GuardianQuorumChanged").withArgs(newQuorum);
      });

      it("Adds a guardian address sets the same quorum value, fires `GuardianAdded` and NOT `GuardianQuorumChanged` events", async () => {
        const newQuorum = 0;
        const tx1 = await dsm.addGuardian(guardian1, newQuorum);
        expect(await dsm.getGuardians()).to.have.length(1);
        expect(await dsm.getGuardianQuorum()).to.equal(newQuorum);

        await expect(tx1).to.emit(dsm, "GuardianAdded").withArgs(guardian1.address);

        await expect(tx1).to.not.emit(dsm, "GuardianQuorumChanged");
      });

      it("Re-adds deleted guardian", async () => {
        await dsm.addGuardian(guardian1, 0);
        await dsm.addGuardian(guardian2, 0);
        expect(await dsm.getGuardians()).to.have.length(2);

        await dsm.removeGuardian(guardian1, 0);
        expect(await dsm.getGuardians()).to.have.length(1);

        await dsm.addGuardian(guardian1, 0);

        expect(await dsm.getGuardians()).to.have.length(2);
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
        expect(await dsm.getGuardians()).to.have.length(2);

        await dsm.removeGuardian(guardian1, 0);
        expect(await dsm.getGuardians()).to.have.length(1);

        await dsm.addGuardians([guardian1], 0);

        expect(await dsm.getGuardians()).to.have.length(2);
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

    it("Reverts if signature is invalid", async () => {
      const blockNumber = 1;

      const sig: DepositSecurityModule.SignatureStruct = {
        r: encodeBytes32String(""),
        vs: encodeBytes32String(""),
      };

      await expect(dsm.pauseDeposits(blockNumber, sig)).to.be.revertedWith("ECDSA: invalid signature");
    });

    it("Reverts if signature is not guardian", async () => {
      const blockNumber = await time.latestBlock();
      const validPauseMessage = new DSMPauseMessage(blockNumber);

      const sig = validPauseMessage.sign(guardian3.privateKey);

      await expect(dsm.pauseDeposits(blockNumber, sig)).to.be.revertedWithCustomError(dsm, "InvalidSignature");
    });

    it("Reverts if called by an anon submitting an unrelated sig", async () => {
      const blockNumber = await time.latestBlock();
      const validPauseMessage = new DSMPauseMessage(blockNumber);

      const sig = validPauseMessage.sign(guardian3.privateKey);

      await expect(dsm.connect(stranger).pauseDeposits(blockNumber, sig)).to.be.revertedWithCustomError(
        dsm,
        "InvalidSignature",
      );
    });

    it("Reverts if called with an expired `blockNumber` by a guardian", async () => {
      const blockNumber = await time.latestBlock();
      const staleBlockNumber = blockNumber - PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS;
      const validPauseMessage = new DSMPauseMessage(blockNumber);

      const sig = validPauseMessage.sign(guardian1.privateKey);

      await expect(dsm.connect(guardian1).pauseDeposits(staleBlockNumber, sig)).to.be.revertedWithCustomError(
        dsm,
        "PauseIntentExpired",
      );
    });

    it("Reverts if called with an expired `blockNumber` by an anon submitting a guardian's sig", async () => {
      const blockNumber = await time.latestBlock();
      const staleBlockNumber = blockNumber - PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS;

      const stalePauseMessage = new DSMPauseMessage(staleBlockNumber);
      const sig = stalePauseMessage.sign(guardian1.privateKey);

      await expect(dsm.connect(stranger).pauseDeposits(staleBlockNumber, sig)).to.be.revertedWithCustomError(
        dsm,
        "PauseIntentExpired",
      );
    });

    it("Reverts if called with a future `blockNumber` by a guardian", async () => {
      const futureBlockNumber = (await time.latestBlock()) + 100;

      const sig: DepositSecurityModule.SignatureStruct = {
        r: encodeBytes32String(""),
        vs: encodeBytes32String(""),
      };

      await expect(dsm.connect(guardian1).pauseDeposits(futureBlockNumber, sig)).to.be.revertedWithPanic(
        PANIC_CODES.ARITHMETIC_OVERFLOW,
      );
    });

    it("Reverts if called with a future `blockNumber` by an anon submitting a guardian's sig", async () => {
      const futureBlockNumber = (await time.latestBlock()) + 100;

      const futurePauseMessage = new DSMPauseMessage(futureBlockNumber);
      const sig = futurePauseMessage.sign(guardian1.privateKey);

      await expect(dsm.connect(stranger).pauseDeposits(futureBlockNumber, sig)).to.be.revertedWithPanic(
        PANIC_CODES.ARITHMETIC_OVERFLOW,
      );
    });

    it("Pause if called by guardian and fires `DepositsPaused` event", async () => {
      const blockNumber = await time.latestBlock();
      const sig: DepositSecurityModule.SignatureStruct = {
        r: encodeBytes32String(""),
        vs: encodeBytes32String(""),
      };

      const tx = await dsm.connect(guardian1).pauseDeposits(blockNumber, sig);

      await expect(tx).to.emit(dsm, "DepositsPaused").withArgs(guardian1.address);
    });

    it("Pause if called by anon submitting sig of guardian", async () => {
      const blockNumber = await time.latestBlock();

      const validPauseMessage = new DSMPauseMessage(blockNumber);
      const sig = validPauseMessage.sign(guardian2.privateKey);

      const tx = await dsm.connect(stranger).pauseDeposits(blockNumber, sig);

      await expect(tx).to.emit(dsm, "DepositsPaused").withArgs(guardian2.address);
    });

    it("Do not pause and emits events if was paused before", async () => {
      const blockNumber = await time.latestBlock();

      const validPauseMessage = new DSMPauseMessage(blockNumber);
      const sig = validPauseMessage.sign(guardian2.privateKey);

      const tx1 = await dsm.connect(stranger).pauseDeposits(blockNumber, sig);
      await expect(tx1).to.emit(dsm, "DepositsPaused").withArgs(guardian2.address);

      const tx2 = await dsm.connect(stranger).pauseDeposits(blockNumber, sig);
      await expect(tx2).to.not.emit(dsm, "DepositsPaused");
    });
  });

  context("Function `unpauseDeposits`", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();

      await dsm.addGuardians([guardian1, guardian2], 0);

      const blockNumber = await time.latestBlock();

      const validPauseMessage = new DSMPauseMessage(blockNumber);
      const sig = validPauseMessage.sign(guardian2.privateKey);

      const tx = await dsm.connect(stranger).pauseDeposits(blockNumber, sig);
      await expect(tx).to.emit(dsm, "DepositsPaused").withArgs(guardian2.address);
    });

    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    it("Reverts if called by not an owner", async () => {
      await expect(dsm.connect(stranger).unpauseDeposits()).to.be.revertedWithCustomError(dsm, "NotAnOwner");
    });

    it("Unpause if called by owner and module status is `DepositsPaused` and fires events", async () => {
      const tx = await dsm.unpauseDeposits();
      await expect(tx).to.emit(dsm, "DepositsUnpaused").withArgs();
    });

    it("Reverts if already paused", async () => {
      const tx = await dsm.unpauseDeposits();
      await expect(tx).to.emit(dsm, "DepositsUnpaused").withArgs();
      await expect(dsm.unpauseDeposits()).to.be.revertedWithCustomError(dsm, "DepositsNotPaused");
    });
  });

  context("Function `canDeposit`", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();

      await dsm.addGuardian(guardian1, 1);
      const lastDepositBlockNumber = await time.latestBlock();
      await stakingRouter.setStakingModuleLastDepositBlock(lastDepositBlockNumber);
      await mineUpTo((await time.latestBlock()) + MIN_DEPOSIT_BLOCK_DISTANCE);
    });

    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    it("Returns `false` if staking module is unregistered in StakingRouter", async () => {
      expect(await dsm.canDeposit(UNREGISTERED_STAKING_MODULE_ID)).to.equal(false);
    });

    it("Returns `true` if: \n\t\t1) Deposits is not paused \n\t\t2) Module is active \n\t\t3) DSM quorum > 0 \n\t\t4) Min deposit block distance is passed \n\t\t5) Lido.canDeposit() is true", async () => {
      const dsmLastDepositBlock = await dsm.getLastDepositBlock();
      const moduleLastDepositBlock = await stakingRouter.getStakingModuleLastDepositBlock(STAKING_MODULE_ID);
      const minDepositBlockDistance = await stakingRouter.getStakingModuleMinDepositBlockDistance(STAKING_MODULE_ID);
      const currentBlockNumber = await time.latestBlock();
      const maxLastDepositBlock = Math.max(Number(dsmLastDepositBlock), Number(moduleLastDepositBlock));

      expect(await dsm.isDepositsPaused()).to.equal(false);
      expect(await stakingRouter.getStakingModuleIsActive(STAKING_MODULE_ID)).to.equal(true);
      expect(await dsm.getGuardianQuorum()).to.equal(1);
      expect(currentBlockNumber - maxLastDepositBlock >= minDepositBlockDistance).to.equal(true);
      expect(await lido.canDeposit()).to.equal(true);

      expect(await dsm.canDeposit(STAKING_MODULE_ID)).to.equal(true);
    });

    it("Returns `false` if deposits paused", async () => {
      const blockNumber = await time.latestBlock();
      const sig: DepositSecurityModule.SignatureStruct = {
        r: encodeBytes32String(""),
        vs: encodeBytes32String(""),
      };

      await dsm.connect(guardian1).pauseDeposits(blockNumber, sig);
      expect(await dsm.isDepositsPaused()).to.equal(true);
      expect(await dsm.canDeposit(STAKING_MODULE_ID)).to.equal(false);
    });

    it("Returns `false` if module is paused", async () => {
      await stakingRouter.setStakingModuleStatus(STAKING_MODULE_ID, StakingModuleStatus.DepositsPaused);
      expect(await stakingRouter.getStakingModuleIsActive(STAKING_MODULE_ID)).to.equal(false);
      expect(await dsm.canDeposit(STAKING_MODULE_ID)).to.equal(false);
    });

    it("Returns `false` if module is stopped", async () => {
      await stakingRouter.setStakingModuleStatus(STAKING_MODULE_ID, StakingModuleStatus.Stopped);
      expect(await stakingRouter.getStakingModuleIsActive(STAKING_MODULE_ID)).to.equal(false);
      expect(await dsm.canDeposit(STAKING_MODULE_ID)).to.equal(false);
    });

    it("Returns `false` if quorum is 0", async () => {
      await dsm.setGuardianQuorum(0);
      expect(await dsm.getGuardianQuorum()).to.equal(0);
      expect(await dsm.canDeposit(STAKING_MODULE_ID)).to.equal(false);
    });

    it("Returns `false` if min deposit block distance is not passed and dsm.lastDepositBlock < module.lastDepositBlock", async () => {
      const moduleLastDepositBlock = await time.latestBlock();
      const dsmLastDepositBlock = Number(await dsm.getLastDepositBlock());

      await stakingRouter.setStakingModuleLastDepositBlock(moduleLastDepositBlock);
      await mineUpTo((await time.latestBlock()) + MIN_DEPOSIT_BLOCK_DISTANCE / 2);

      const minDepositBlockDistance = await stakingRouter.getStakingModuleMinDepositBlockDistance(STAKING_MODULE_ID);
      const currentBlockNumber = await time.latestBlock();

      expect(dsmLastDepositBlock < moduleLastDepositBlock).to.equal(true);
      expect(currentBlockNumber - dsmLastDepositBlock >= minDepositBlockDistance).to.equal(true);
      expect(currentBlockNumber - moduleLastDepositBlock < minDepositBlockDistance).to.equal(true);
      expect(await dsm.canDeposit(STAKING_MODULE_ID)).to.equal(false);
    });

    it("Returns `false` if min deposit block distance is not passed and dsm.lastDepositBlock > module.lastDepositBlock", async () => {
      await mineUpTo((await time.latestBlock()) + MIN_DEPOSIT_BLOCK_DISTANCE);
      await deposit([guardian1]);

      const dsmLastDepositBlock = Number(await dsm.getLastDepositBlock());
      const moduleLastDepositBlock = dsmLastDepositBlock - MIN_DEPOSIT_BLOCK_DISTANCE;
      await stakingRouter.setStakingModuleLastDepositBlock(moduleLastDepositBlock);

      const minDepositBlockDistance = await stakingRouter.getStakingModuleMinDepositBlockDistance(STAKING_MODULE_ID);
      const currentBlockNumber = await time.latestBlock();

      expect(dsmLastDepositBlock > moduleLastDepositBlock).to.equal(true);
      expect(currentBlockNumber - dsmLastDepositBlock < minDepositBlockDistance).to.equal(true);
      expect(currentBlockNumber - moduleLastDepositBlock >= minDepositBlockDistance).to.equal(true);
      expect(await dsm.canDeposit(STAKING_MODULE_ID)).to.equal(false);
    });

    it("Returns `false` if Lido.canDeposit() is false", async () => {
      await lido.setCanDeposit(false);

      expect(await lido.canDeposit()).to.equal(false);
      expect(await dsm.canDeposit(STAKING_MODULE_ID)).to.equal(false);
    });
  });

  context("Function `getLastDepositBlock`", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();
    });

    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    it("Returns deployment block before any deposits", async () => {
      const tx = await dsm.deploymentTransaction();
      const deploymentBlock = tx?.blockNumber;

      expect(deploymentBlock).to.be.an("number");
      expect(await dsm.getLastDepositBlock()).to.equal(deploymentBlock);
      await expect(tx).to.emit(dsm, "LastDepositBlockChanged").withArgs(deploymentBlock);
    });

    it("Returns last deposit block", async () => {
      await dsm.addGuardian(guardian1, 1);
      const tx = await await deposit([guardian1]);
      const depositBlock = tx.blockNumber;

      expect(await dsm.getLastDepositBlock()).to.equal(depositBlock);
      await expect(tx).to.emit(dsm, "LastDepositBlockChanged").withArgs(depositBlock);
    });
  });

  context("Function `isMinDepositDistancePassed`", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();
      await dsm.addGuardian(guardian1, 1);
      await mineUpTo((await time.latestBlock()) + MIN_DEPOSIT_BLOCK_DISTANCE);
    });

    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    it("Returns true if min deposit distance is passed", async () => {
      expect(await dsm.isMinDepositDistancePassed(STAKING_MODULE_ID)).to.equal(true);
    });

    it("Returns false if distance is not passed for both dsm.lastDepositBlock and module.lastDepositBlock", async () => {
      await deposit([guardian1]);
      const dsmLastDepositBlock = await dsm.getLastDepositBlock();
      await stakingRouter.setStakingModuleLastDepositBlock(dsmLastDepositBlock);

      const moduleLastDepositBlock = await stakingRouter.getStakingModuleLastDepositBlock(STAKING_MODULE_ID);
      const minDepositBlockDistance = await stakingRouter.getStakingModuleMinDepositBlockDistance(STAKING_MODULE_ID);
      const currentBlockNumber = await time.latestBlock();

      expect(dsmLastDepositBlock).to.equal(moduleLastDepositBlock);
      expect(currentBlockNumber - Number(dsmLastDepositBlock) < minDepositBlockDistance).to.equal(true);
      expect(currentBlockNumber - Number(moduleLastDepositBlock) < minDepositBlockDistance).to.equal(true);

      expect(await dsm.isMinDepositDistancePassed(STAKING_MODULE_ID)).to.equal(false);
    });

    it("Returns false if distance is not passed for dsm.lastDepositBlock but passed for module.lastDepositBlock", async () => {
      await deposit([guardian1]);
      const currentBlockNumber = await time.latestBlock();
      const minDepositBlockDistance = await stakingRouter.getStakingModuleMinDepositBlockDistance(STAKING_MODULE_ID);
      await stakingRouter.setStakingModuleLastDepositBlock(currentBlockNumber - Number(minDepositBlockDistance));

      const dsmLastDepositBlock = await dsm.getLastDepositBlock();
      const moduleLastDepositBlock = await stakingRouter.getStakingModuleLastDepositBlock(STAKING_MODULE_ID);

      expect(currentBlockNumber - Number(dsmLastDepositBlock) < minDepositBlockDistance).to.equal(true);
      expect(currentBlockNumber - Number(moduleLastDepositBlock) >= minDepositBlockDistance).to.equal(true);

      expect(await dsm.isMinDepositDistancePassed(STAKING_MODULE_ID)).to.equal(false);
    });
  });

  context("Function `depositBufferedEther`", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();

      await stakingRouter.setStakingModuleNonce(MODULE_NONCE);
      expect(await stakingRouter.getStakingModuleNonce(STAKING_MODULE_ID)).to.equal(MODULE_NONCE);
    });

    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    context("Total guardians: 0, quorum: 0", () => {
      it("Reverts if no quorum", async () => {
        expect(await dsm.getGuardianQuorum()).to.equal(0);
        await expect(deposit([])).to.be.revertedWithCustomError(dsm, "DepositNoQuorum");
      });
    });

    context("Total guardians: 1, quorum: 0", () => {
      it("Reverts if no quorum", async () => {
        await dsm.addGuardian(guardian1, 0);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect(await dsm.getGuardians()).to.have.length(1);
        expect(await dsm.getGuardianQuorum()).to.equal(0);

        await expect(deposit([])).to.be.revertedWithCustomError(dsm, "DepositNoQuorum");
      });
    });

    context("Total guardians: 1, quorum: 1", () => {
      it("Reverts if no guardian signatures", async () => {
        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect(await dsm.getGuardians()).to.have.length(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        await expect(deposit([])).to.be.revertedWithCustomError(dsm, "DepositNoQuorum");
      });

      it("Reverts if deposit with an unrelated sig", async () => {
        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect(await dsm.getGuardians()).to.have.length(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        await expect(deposit([guardian2])).to.be.revertedWithCustomError(dsm, "InvalidSignature");
      });

      it("Reverts if deposit contract root changed", async () => {
        const depositRootBefore = await depositContract.get_deposit_root();
        const newDepositRoot = "0x9daddc4daa5915981fd9f1bcc367a2be1389b017d5c24a58d44249a5dbb60289";
        await depositContract.set_deposit_root(newDepositRoot);
        expect(await depositContract.get_deposit_root()).to.equal(newDepositRoot);
        expect(await depositContract.get_deposit_root()).to.not.equal(depositRootBefore);

        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect(await dsm.getGuardians()).to.have.length(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        await expect(
          deposit([guardian1], {
            depositRoot: depositRootBefore,
          }),
        ).to.be.revertedWithCustomError(dsm, "DepositRootChanged");
      });

      it("Reverts if nonce changed", async () => {
        const nonceBefore = Number(await stakingRouter.getStakingModuleNonce(STAKING_MODULE_ID));
        const newNonce = nonceBefore + 1;
        await stakingRouter.setStakingModuleNonce(newNonce);
        expect(await stakingRouter.getStakingModuleNonce(STAKING_MODULE_ID)).to.equal(newNonce);
        expect(await stakingRouter.getStakingModuleNonce(STAKING_MODULE_ID)).to.not.equal(nonceBefore);

        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect(await dsm.getGuardians()).to.have.length(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        await expect(
          deposit([guardian1], {
            nonce: nonceBefore,
          }),
        ).to.be.revertedWithCustomError(dsm, "ModuleNonceChanged");
      });

      it("Reverts if deposit too frequent", async () => {
        const latestBlock = await getLatestBlock();
        await stakingRouter.setStakingModuleLastDepositBlock(latestBlock.number - 1);

        const lastDepositBlock = await stakingRouter.getStakingModuleLastDepositBlock(STAKING_MODULE_ID);
        expect(BigInt(latestBlock.number) - BigInt(lastDepositBlock) < BigInt(MIN_DEPOSIT_BLOCK_DISTANCE)).to.equal(
          true,
        );

        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect(await dsm.getGuardians()).to.have.length(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        await expect(deposit([guardian1])).to.be.revertedWithCustomError(dsm, "DepositTooFrequent");
      });

      it("Reverts if module is inactive", async () => {
        await stakingRouter.setStakingModuleStatus(STAKING_MODULE_ID, Status.DepositsPaused);

        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect(await dsm.getGuardians()).to.have.length(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        await expect(deposit([guardian1])).to.be.revertedWithCustomError(dsm, "DepositInactiveModule");
      });

      it("Reverts if `block.hash` and `block.number` from different blocks", async () => {
        const previousBlockNumber = await time.latestBlock();
        await mineUpTo((await time.latestBlock()) + 1);
        const latestBlockNumber = await time.latestBlock();
        expect(latestBlockNumber > previousBlockNumber).to.equal(true);

        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect(await dsm.getGuardians()).to.have.length(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        await expect(
          deposit([guardian1], {
            blockNumber: previousBlockNumber,
          }),
        ).to.be.revertedWithCustomError(dsm, "DepositUnexpectedBlockHash");
      });

      it("Reverts if called with zero `block.hash`", async () => {
        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect(await dsm.getGuardians()).to.have.length(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        await expect(deposit([guardian1], { blockHash: ZeroHash })).to.be.revertedWithCustomError(
          dsm,
          "DepositUnexpectedBlockHash",
        );
      });

      it("Reverts if called for block with unrecoverable `block.hash`", async () => {
        const tooOldBlock = await getLatestBlock();
        await mineUpTo((await time.latestBlock()) + 255);
        const latestBlock = await getLatestBlock();
        expect(latestBlock.number > tooOldBlock.number).to.equal(true);

        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect(await dsm.getGuardians()).to.have.length(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        await expect(
          deposit([guardian1], {
            blockNumber: tooOldBlock.number,
            blockHash: tooOldBlock.hash,
          }),
        ).to.be.revertedWithCustomError(dsm, "DepositUnexpectedBlockHash");
      });

      it("Reverts if deposits are paused", async () => {
        const blockNumber = await time.latestBlock();

        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect(await dsm.getGuardians()).to.have.length(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        await dsm.connect(guardian1).pauseDeposits(blockNumber, {
          r: encodeBytes32String(""),
          vs: encodeBytes32String(""),
        });
        expect(await dsm.isDepositsPaused()).to.equal(true);

        await expect(deposit([guardian1])).to.be.revertedWithCustomError(dsm, "DepositsArePaused");
      });

      it("Deposit with the guardian's sig", async () => {
        await dsm.addGuardian(guardian1, 1);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address]);
        expect(await dsm.getGuardians()).to.have.length(1);
        expect(await dsm.getGuardianQuorum()).to.equal(1);

        const depositCalldata = encodeBytes32String("");
        const tx = await deposit([guardian1], { depositCalldata });

        await expect(tx)
          .to.emit(lido, "StakingModuleDeposited")
          .withArgs(MAX_DEPOSITS_PER_BLOCK, STAKING_MODULE_ID, depositCalldata);
      });
    });

    context("Total guardians: 3, quorum: 2", () => {
      it("Reverts if no signatures", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect(await dsm.getGuardians()).to.have.length(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        await expect(deposit([])).to.be.revertedWithCustomError(dsm, "DepositNoQuorum");
      });

      it("Reverts if signatures < quorum", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect(await dsm.getGuardians()).to.have.length(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        await expect(deposit([guardian1])).to.be.revertedWithCustomError(dsm, "DepositNoQuorum");
      });

      it("Reverts if deposit with guardian's sigs (1,0) with `SignaturesNotSorted` exception", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect(await dsm.getGuardians()).to.have.length(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        await expect(deposit([guardian2, guardian1])).to.be.revertedWithCustomError(dsm, "SignaturesNotSorted");
      });

      it("Reverts if deposit with guardian's sigs (0,0,1) with `SignaturesNotSorted` exception", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect(await dsm.getGuardians()).to.have.length(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        await expect(deposit([guardian1, guardian1, guardian2])).to.be.revertedWithCustomError(
          dsm,
          "SignaturesNotSorted",
        );
      });

      it("Reverts if deposit with guardian's sigs (0,x,x) with `InvalidSignature` exception", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect(await dsm.getGuardians()).to.have.length(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        await expect(deposit([guardian1, unrelatedGuardian1, unrelatedGuardian2])).to.be.revertedWithCustomError(
          dsm,
          "InvalidSignature",
        );
      });

      it("Allow deposit if deposit with guardian's sigs (0,1,2)", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect(await dsm.getGuardians()).to.have.length(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        const depositCalldata = encodeBytes32String("");
        const tx = await deposit([guardian1, guardian2, guardian3], { depositCalldata });

        await expect(tx)
          .to.emit(lido, "StakingModuleDeposited")
          .withArgs(MAX_DEPOSITS_PER_BLOCK, STAKING_MODULE_ID, depositCalldata);
      });

      it("Allow deposit if deposit with guardian's sigs (0,1)", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect(await dsm.getGuardians()).to.have.length(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        const depositCalldata = encodeBytes32String("");
        const tx = await deposit([guardian1, guardian2], { depositCalldata });

        await expect(tx)
          .to.emit(lido, "StakingModuleDeposited")
          .withArgs(MAX_DEPOSITS_PER_BLOCK, STAKING_MODULE_ID, depositCalldata);
      });

      it("Allow deposit if deposit with guardian's sigs (0,2)", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect(await dsm.getGuardians()).to.have.length(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        const depositCalldata = encodeBytes32String("");
        const tx = await deposit([guardian1, guardian3], { depositCalldata });

        await expect(tx)
          .to.emit(lido, "StakingModuleDeposited")
          .withArgs(MAX_DEPOSITS_PER_BLOCK, STAKING_MODULE_ID, depositCalldata);
      });

      it("Allow deposit if deposit with guardian's sigs (1,2)", async () => {
        await dsm.addGuardians([guardian1, guardian2, guardian3], 2);
        expect(await dsm.getGuardians()).to.deep.equal([guardian1.address, guardian2.address, guardian3.address]);
        expect(await dsm.getGuardians()).to.have.length(3);
        expect(await dsm.getGuardianQuorum()).to.equal(2);

        const depositCalldata = encodeBytes32String("");
        const tx = await deposit([guardian2, guardian3], { depositCalldata });

        await expect(tx)
          .to.emit(lido, "StakingModuleDeposited")
          .withArgs(MAX_DEPOSITS_PER_BLOCK, STAKING_MODULE_ID, depositCalldata);
      });
    });
  });

  context("Function `unvetSigningKeys`", () => {
    const operatorId1 = "0x0000000000000001";
    const operatorId2 = "0x0000000000000002";
    const vettedSigningKeysCount1 = "0x00000000000000000000000000000001";
    const vettedSigningKeysCount2 = "0x00000000000000000000000000000002";
    const defaultNodeOperatorIds = concat([operatorId1, operatorId2]);
    const defaultVettedSigningKeysCounts = concat([vettedSigningKeysCount1, vettedSigningKeysCount2]);

    const invalidSig: DepositSecurityModule.SignatureStruct = {
      r: encodeBytes32String(""),
      vs: encodeBytes32String(""),
    };

    type UnvetArgs = {
      blockNumber?: number;
      blockHash?: string;
      stakingModuleId?: number;
      nonce?: number;
      nodeOperatorIds?: string;
      vettedSigningKeysCounts?: string;
      sig?: DepositSecurityModule.SignatureStruct;
    };

    type UnvetSignedArgs = UnvetArgs & { sig?: DepositSecurityModule.SignatureStruct };

    async function getUnvetArgs(overridingArgs?: UnvetArgs) {
      const latestBlock = await getLatestBlock();
      const blockNumber = overridingArgs?.blockNumber ?? latestBlock.number;
      const blockHash = overridingArgs?.blockHash ?? latestBlock.hash;
      const stakingModuleId = overridingArgs?.stakingModuleId ?? STAKING_MODULE_ID;
      const nonce = overridingArgs?.nonce ?? MODULE_NONCE;

      const nodeOperatorIds = overridingArgs?.nodeOperatorIds ?? defaultNodeOperatorIds;
      const vettedSigningKeysCounts = overridingArgs?.vettedSigningKeysCounts ?? defaultVettedSigningKeysCounts;

      return [blockNumber, blockHash, stakingModuleId, nonce, nodeOperatorIds, vettedSigningKeysCounts] as const;
    }

    async function getUnvetSignature(from: Wallet, overridingArgs?: UnvetArgs) {
      const args = await getUnvetArgs(overridingArgs);
      const validUnvetMessage = new DSMUnvetMessage(...args);
      return validUnvetMessage.sign(from.privateKey);
    }

    async function unvetSigningKeys(from: Wallet, overridingArgs?: UnvetSignedArgs) {
      const unvetArgs = await getUnvetArgs(overridingArgs);
      const sig = overridingArgs?.sig ?? (await getUnvetSignature(from, overridingArgs));
      return await dsm.connect(from).unvetSigningKeys(...unvetArgs, sig);
    }

    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();

      await dsm.addGuardians([guardian1, guardian2], 0);
      expect(await dsm.getGuardians()).to.have.length(2);

      await stakingRouter.setStakingModuleNonce(MODULE_NONCE);
      expect(await stakingRouter.getStakingModuleNonce(STAKING_MODULE_ID)).to.equal(MODULE_NONCE);
    });

    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    it("Reverts if module nonce changed", async () => {
      const nonceBefore = Number(await stakingRouter.getStakingModuleNonce(STAKING_MODULE_ID));
      const newNonce = nonceBefore + 1;
      await stakingRouter.setStakingModuleNonce(newNonce);
      expect(await stakingRouter.getStakingModuleNonce(STAKING_MODULE_ID)).to.equal(newNonce);
      expect(await stakingRouter.getStakingModuleNonce(STAKING_MODULE_ID)).to.not.equal(nonceBefore);

      await expect(unvetSigningKeys(guardian1, { nonce: nonceBefore })).to.be.revertedWithCustomError(
        dsm,
        "ModuleNonceChanged",
      );
    });

    it("Reverts if `nodeOperatorIds` is not a multiple of 8 bytes", async () => {
      await expect(unvetSigningKeys(guardian1, { nodeOperatorIds: "0x000001" })).to.be.revertedWithCustomError(
        dsm,
        "UnvetPayloadInvalid",
      );
    });

    it("Reverts if `vettedSigningKeysCounts` is not a multiple of 16 bytes", async () => {
      await expect(unvetSigningKeys(guardian1, { vettedSigningKeysCounts: "0x000001" })).to.be.revertedWithCustomError(
        dsm,
        "UnvetPayloadInvalid",
      );
    });

    it("Reverts if the number of operator ids is not equal to the number of keys count", async () => {
      await expect(
        unvetSigningKeys(guardian1, {
          nodeOperatorIds: concat([operatorId1, operatorId2]),
          vettedSigningKeysCounts: vettedSigningKeysCount1,
        }),
      ).to.be.revertedWithCustomError(dsm, "UnvetPayloadInvalid");
    });

    it("Reverts if the number of operators is greater than the limit", async () => {
      const overlimitedPayloadSize = MAX_OPERATORS_PER_UNVETTING + 1;
      const nodeOperatorIds = concat(Array(overlimitedPayloadSize).fill(operatorId1));
      const vettedSigningKeysCounts = concat(Array(overlimitedPayloadSize).fill(vettedSigningKeysCount1));

      await expect(
        unvetSigningKeys(guardian1, { nodeOperatorIds, vettedSigningKeysCounts }),
      ).to.be.revertedWithCustomError(dsm, "UnvetPayloadInvalid");
    });

    it("Reverts if it's called by stranger with invalid signature", async () => {
      await expect(unvetSigningKeys(unrelatedGuardian1, { sig: invalidSig })).to.be.revertedWith(
        "ECDSA: invalid signature",
      );
    });

    it("Reverts if called with zero `block.hash`", async () => {
      await expect(unvetSigningKeys(guardian1, { blockHash: ZeroHash })).to.be.revertedWithCustomError(
        dsm,
        "UnvetUnexpectedBlockHash",
      );
    });

    it("Reverts if called for block with unrecoverable `block.hash`", async () => {
      const tooOldBlock = await getLatestBlock();
      await mineUpTo((await time.latestBlock()) + 255);
      const latestBlock = await getLatestBlock();
      expect(latestBlock.number > tooOldBlock.number).to.equal(true);

      await expect(unvetSigningKeys(guardian1, { blockHash: ZeroHash })).to.be.revertedWithCustomError(
        dsm,
        "UnvetUnexpectedBlockHash",
      );
    });

    it("Reverts if `block.hash` and `block.number` from different blocks", async () => {
      const previousBlockNumber = await time.latestBlock();
      await mineUpTo((await time.latestBlock()) + 1);
      const latestBlockNumber = await time.latestBlock();
      expect(latestBlockNumber > previousBlockNumber).to.equal(true);

      await expect(unvetSigningKeys(guardian1, { blockNumber: previousBlockNumber })).to.be.revertedWithCustomError(
        dsm,
        "UnvetUnexpectedBlockHash",
      );
    });

    it("Reverts if signature is not guardian", async () => {
      await expect(unvetSigningKeys(unrelatedGuardian1)).to.be.revertedWithCustomError(dsm, "InvalidSignature");
    });

    it("Unvets keys if it's called by stranger with valid signature", async () => {
      const sig = await getUnvetSignature(guardian1);
      const tx = await unvetSigningKeys(unrelatedGuardian1, { sig });

      await expect(tx)
        .to.emit(stakingRouter, "StakingModuleVettedKeysDecreased")
        .withArgs(STAKING_MODULE_ID, defaultNodeOperatorIds, defaultVettedSigningKeysCounts);
    });

    it("Unvets keys if it's called by guardian", async () => {
      const tx = await unvetSigningKeys(guardian1);

      await expect(tx)
        .to.emit(stakingRouter, "StakingModuleVettedKeysDecreased")
        .withArgs(STAKING_MODULE_ID, defaultNodeOperatorIds, defaultVettedSigningKeysCounts);
    });

    it("Unvets keys if it's called by guardian with valid signature", async () => {
      const sig = await getUnvetSignature(guardian1);
      const tx = await unvetSigningKeys(guardian1, { sig });

      await expect(tx)
        .to.emit(stakingRouter, "StakingModuleVettedKeysDecreased")
        .withArgs(STAKING_MODULE_ID, defaultNodeOperatorIds, defaultVettedSigningKeysCounts);
    });

    it("Unvets keys if it's called by guardian with invalid signature", async () => {
      const sig = await getUnvetSignature(unrelatedGuardian1);
      const tx = await unvetSigningKeys(guardian1, { sig });

      await expect(tx)
        .to.emit(stakingRouter, "StakingModuleVettedKeysDecreased")
        .withArgs(STAKING_MODULE_ID, defaultNodeOperatorIds, defaultVettedSigningKeysCounts);
    });
  });
});

enum Status {
  Active,
  DepositsPaused,
  Stopped,
}
