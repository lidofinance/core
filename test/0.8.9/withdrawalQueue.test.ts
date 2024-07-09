import { expect } from "chai";
import { HDNodeWallet, Wallet, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  StETH__MockForWithdrawalQueue,
  WithdrawalsQueue__Harness,
  WstETH__MockForWithdrawalQueue,
} from "typechain-types";

import {
  ether,
  impersonate,
  MAX_UINT256,
  proxify,
  randomAddress,
  shareRate,
  shares,
  streccak,
  WITHDRAWAL_MAX_STETH_WITHDRAWAL_AMOUNT,
  WITHDRAWAL_MIN_STETH_WITHDRAWAL_AMOUNT,
} from "lib";

import { Snapshot } from "test/suite";

const ZERO = 0n;

const BUNKER_MODE_DISABLED_TIMESTAMP = MAX_UINT256;
const PETRIFIED_VERSION = MAX_UINT256;

const FINALIZE_ROLE = streccak("FINALIZE_ROLE");
const ORACLE_ROLE = streccak("ORACLE_ROLE");
const PAUSE_ROLE = streccak("PAUSE_ROLE");
const RESUME_ROLE = streccak("RESUME_ROLE");

const DEFAULT_PERMIT = {
  deadline: MAX_UINT256,
  value: 0,
  v: 0,
  r: Buffer.alloc(32),
  s: Buffer.alloc(32),
};

describe("WithdrawalQueue.sol", () => {
  let aliceWallet: HDNodeWallet;
  let alice: HardhatEthersSigner;

  let owner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let oracle: HardhatEthersSigner;

  let stEth: StETH__MockForWithdrawalQueue;
  let stEthAddress: string;
  let wstEth: WstETH__MockForWithdrawalQueue;
  let wstEthAddress: string;

  let impl: WithdrawalsQueue__Harness;
  let queue: WithdrawalsQueue__Harness;
  let queueAddress: string;

  let originalState: string;

  before(async () => {
    [owner, stranger, user, oracle] = await ethers.getSigners();

    stEth = await ethers.deployContract("StETH__MockForWithdrawalQueue", []);
    stEthAddress = await stEth.getAddress();

    wstEth = await ethers.deployContract("WstETH__MockForWithdrawalQueue", [await stEth.getAddress()]);
    wstEthAddress = await wstEth.getAddress();

    impl = await ethers.deployContract("WithdrawalsQueue__Harness", [wstEthAddress], owner);

    [queue] = await proxify({ impl, admin: owner });

    queueAddress = await queue.getAddress();

    aliceWallet = Wallet.createRandom(ethers.provider);
    alice = await impersonate(aliceWallet.address, ether("10.00"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constants", () => {
    it("Returns ths BUNKER_MODE_DISABLED_TIMESTAMP variable", async () => {
      expect(await queue.BUNKER_MODE_DISABLED_TIMESTAMP()).to.equal(BUNKER_MODE_DISABLED_TIMESTAMP);
    });

    it("Returns ACL roles", async () => {
      expect(await queue.PAUSE_ROLE()).to.equal(PAUSE_ROLE);
      expect(await queue.RESUME_ROLE()).to.equal(RESUME_ROLE);
      expect(await queue.FINALIZE_ROLE()).to.equal(FINALIZE_ROLE);
      expect(await queue.ORACLE_ROLE()).to.equal(ORACLE_ROLE);
    });

    it("Returns the MIN_STETH_WITHDRAWAL_AMOUNT variable", async () => {
      expect(await queue.MIN_STETH_WITHDRAWAL_AMOUNT()).to.equal(WITHDRAWAL_MIN_STETH_WITHDRAWAL_AMOUNT);
    });

    it("Returns the MAX_STETH_WITHDRAWAL_AMOUNT variable", async () => {
      expect(await queue.MAX_STETH_WITHDRAWAL_AMOUNT()).to.equal(WITHDRAWAL_MAX_STETH_WITHDRAWAL_AMOUNT);
    });

    it("Returns the STETH address", async () => {
      expect(await queue.STETH()).to.equal(stEthAddress);
    });

    it("Returns the WSTETH address", async () => {
      expect(await queue.WSTETH()).to.equal(wstEthAddress);
    });
  });

  context("constructor", () => {
    it("Reverts if wstETH address is zero", async () => {
      await expect(ethers.deployContract("WithdrawalsQueue__Harness", [ZeroAddress])).to.be.revertedWithoutReason();
    });

    it("Sets initial properties", async () => {
      const deployed = await ethers.deployContract("WithdrawalsQueue__Harness", [wstEthAddress]);

      expect(await deployed.STETH()).to.equal(stEthAddress, "stETH address");
      expect(await deployed.WSTETH()).to.equal(wstEthAddress, "wstETH address");
    });

    it("Petrifies the implementation", async () => {
      expect(await impl.getContractVersion()).to.equal(PETRIFIED_VERSION);
    });

    it("Returns 0 as the initial contract version", async () => {
      expect(await queue.getContractVersion()).to.equal(0n);
    });

    it("Enables bunker mode", async () => {
      expect(await queue.isBunkerModeActive()).to.equal(true, "isBunkerModeActive");
      expect(await queue.bunkerModeSinceTimestamp()).to.equal(0, "bunkerModeSinceTimestamp");
    });
  });

  context("initialize", () => {
    it("Reverts if initialized with zero address", async () => {
      await expect(queue.initialize(ZeroAddress)).to.be.revertedWithCustomError(queue, "AdminZeroAddress");
    });

    it("Sets initial properties`", async () => {
      await queue.initialize(owner);

      expect(await queue.getContractVersion()).to.equal(1n, "getContractVersion");
      expect(await queue.getLastRequestId()).to.equal(ZERO, "getLastRequestId");
      expect(await queue.getLastFinalizedRequestId()).to.equal(ZERO, "getLastFinalizedRequestId");
      expect(await queue.getLastCheckpointIndex()).to.equal(ZERO, "getLastCheckpointIndex");
      expect(await queue.unfinalizedStETH()).to.equal(ZERO, "unfinalizedStETH");
      expect(await queue.unfinalizedRequestNumber()).to.equal(ZERO, "unfinalizedRequestNumber");
      expect(await queue.getLockedEtherAmount()).to.equal(ZERO, "getLockedEtherAmount");
    });

    it("Pauses the contract", async () => {
      await queue.initialize(owner);

      expect(await queue.isPaused()).to.equal(true, "isPaused");
    });

    it("Disables bunker mode", async () => {
      await queue.initialize(owner);

      const TS = await queue.BUNKER_MODE_DISABLED_TIMESTAMP();

      expect(await queue.isBunkerModeActive()).to.equal(false, "isBunkerModeActive");
      expect(await queue.bunkerModeSinceTimestamp()).to.equal(TS, "bunkerModeSinceTimestamp");
    });

    it("Increases version", async () => {
      await queue.initialize(randomAddress());

      expect(await queue.getContractVersion()).to.equal(1n);
    });

    it("Emits `InitializedV1`", async () => {
      await expect(queue.initialize(owner)).to.emit(queue, "InitializedV1").withArgs(owner.address);
    });
  });

  context("Pausable", () => {
    beforeEach(async () => {
      await queue.initialize(owner);
    });

    context("resume", () => {
      it("Reverts if the caller is unauthorised", async () => {
        await expect(queue.connect(stranger).resume()).to.be.revertedWithOZAccessControlError(
          stranger.address,
          RESUME_ROLE,
        );
      });

      it("Resumes the contract with RESUME_ROLE", async () => {
        await queue.grantRole(await queue.RESUME_ROLE(), owner);

        await queue.resume();

        expect(await queue.isPaused()).to.equal(false);
      });
    });

    context("pauseFor", () => {
      beforeEach(async () => {
        await queue.grantRole(await queue.RESUME_ROLE(), owner);
        await queue.resume();
      });

      it("Reverts if the caller is unauthorised", async () => {
        await expect(queue.connect(stranger).pauseFor(1n)).to.be.revertedWithOZAccessControlError(
          stranger.address,
          PAUSE_ROLE,
        );
      });

      it("Pauses the contract with PAUSE_ROLE", async () => {
        await queue.grantRole(await queue.PAUSE_ROLE(), owner);

        await queue.pauseFor(1n);

        expect(await queue.isPaused()).to.equal(true, "isPaused after");
      });
    });

    context("pauseUntil", () => {
      beforeEach(async () => {
        await queue.grantRole(await queue.RESUME_ROLE(), owner);
        await queue.resume();
      });

      it("Reverts if the caller is unauthorised", async () => {
        const blockTimestamp = await time.latest();

        await expect(queue.connect(stranger).pauseUntil(blockTimestamp + 1)).to.be.revertedWithOZAccessControlError(
          stranger.address,
          PAUSE_ROLE,
        );
      });

      it("Pauses the contract with PAUSE_ROLE", async () => {
        const blockTimestamp = await time.latest();

        await queue.grantRole(await queue.PAUSE_ROLE(), owner);

        await queue.connect(owner).pauseUntil(blockTimestamp + 100);

        expect(await queue.isPaused()).to.equal(true, "isPaused after pauseUntil");

        await time.increase(100);

        expect(await queue.isPaused()).to.equal(false, "isPaused after time increase");
      });
    });
  });

  context("Withdrawal Requests", () => {
    beforeEach(async () => {
      await queue.initialize(owner);
      await queue.grantRole(await queue.RESUME_ROLE(), owner);
      await queue.grantRole(await queue.PAUSE_ROLE(), owner);
      await queue.resume();
    });

    context("requestWithdrawals", () => {
      beforeEach(async () => {
        await stEth.mockSetTotalPooledEther(ether("600.00"));
        await stEth.exposedMintShares(user, shares(300n));
        await stEth.connect(user).approve(queueAddress, ether("300.00"));
      });

      it("Reverts if the contract is paused", async () => {
        await queue.pauseFor(1000n);

        await expect(queue.requestWithdrawals([ether("1.00")], stranger)).to.be.revertedWithCustomError(
          queue,
          "ResumedExpected",
        );
      });

      it("Reverts if requested less that MIN_WITHDRAWAL_AMOUNT", async () => {
        const lower = WITHDRAWAL_MIN_STETH_WITHDRAWAL_AMOUNT - 1n;

        await expect(queue.connect(user).requestWithdrawals([lower], stranger))
          .to.be.revertedWithCustomError(queue, "RequestAmountTooSmall")
          .withArgs(lower);
      });

      it("Reverts if requested more than MAX_WITHDRAWAL_AMOUNT", async () => {
        const higher = WITHDRAWAL_MAX_STETH_WITHDRAWAL_AMOUNT + 1n;

        await expect(queue.connect(user).requestWithdrawals([higher], stranger))
          .to.be.revertedWithCustomError(queue, "RequestAmountTooLarge")
          .withArgs(higher);
      });

      it("Reverts if requested more than the user's balance", async () => {
        const overflow = ether("1000.00");

        await expect(queue.connect(user).requestWithdrawals([overflow], stranger)).to.be.revertedWith(
          "ALLOWANCE_EXCEEDED",
        );
      });

      it("Creates requests for multiple amounts", async () => {
        const amount1 = ether("10.00");
        const amount2 = ether("20.00");
        const shares1 = await stEth.getSharesByPooledEth(amount1);
        const shares2 = await stEth.getSharesByPooledEth(amount2);

        const requestIdBefore = await queue.getLastRequestId();

        await expect(queue.connect(user).requestWithdrawals([amount1, amount2], stranger))
          .to.emit(queue, "WithdrawalRequested")
          .withArgs(1, user.address, stranger.address, amount1, shares1)
          .to.emit(queue, "WithdrawalRequested")
          .withArgs(2, user.address, stranger.address, amount2, shares2);

        const diff = (await queue.getLastRequestId()) - requestIdBefore;
        expect(diff).to.equal(requestIdBefore + 2n);
      });

      it("Creates requests for multiple amounts with zero owner address", async () => {
        const amount = ether("10.00");
        const shares = await stEth.getSharesByPooledEth(amount);

        const requestIdBefore = await queue.getLastRequestId();

        await expect(queue.connect(user).requestWithdrawals([amount], ZeroAddress))
          .to.emit(queue, "WithdrawalRequested")
          .withArgs(1, user.address, user.address, amount, shares);

        const diff = (await queue.getLastRequestId()) - requestIdBefore;
        expect(diff).to.equal(requestIdBefore + 1n);
      });
    });

    context("requestWithdrawalsWstETH", () => {
      beforeEach(async () => {
        await stEth.mockSetTotalPooledEther(ether("600.00"));
        await stEth.exposedMintShares(wstEthAddress, shares(100n));
        await stEth.exposedMintShares(user, shares(100n));
        await wstEth.exposedMint(user, ether("100.00"));
        await wstEth.connect(user).approve(queueAddress, ether("300.00"));
      });

      it("Reverts if the contract is paused", async () => {
        await queue.pauseFor(100n);

        await expect(queue.requestWithdrawalsWstETH([ether("1.00")], stranger)).to.be.revertedWithCustomError(
          queue,
          "ResumedExpected",
        );
      });

      it("Reverts if requested more than the user's balance", async () => {
        const overflow = ether("1000.00");

        await expect(queue.connect(user).requestWithdrawalsWstETH([overflow], stranger)).to.be.revertedWith(
          "ERC20: transfer amount exceeds balance",
        );
      });

      it("Creates requests for multiple amounts", async () => {
        const amount1 = ether("10.00");
        const amount2 = ether("20.00");

        const stEthAmount1 = await wstEth.getStETHByWstETH(amount1);
        const stEthAmount2 = await wstEth.getStETHByWstETH(amount2);

        const shares1 = await stEth.getSharesByPooledEth(stEthAmount1);
        const shares2 = await stEth.getSharesByPooledEth(stEthAmount2);

        const requestIdBefore = await queue.getLastRequestId();

        await expect(queue.connect(user).requestWithdrawalsWstETH([amount1, amount2], stranger))
          .to.emit(queue, "WithdrawalRequested")
          .withArgs(1, user.address, stranger.address, stEthAmount1, shares1)
          .to.emit(queue, "WithdrawalRequested")
          .withArgs(2, user.address, stranger.address, stEthAmount2, shares2);

        const requestIdAfter = await queue.getLastRequestId();
        const diff = requestIdAfter - requestIdBefore;
        expect(diff).to.equal(requestIdBefore + 2n);
      });

      it("Creates requests for single amount with zero owner address", async () => {
        const amount = ether("10.00");

        const stEthAmount = await wstEth.getStETHByWstETH(amount);
        const shares = await stEth.getSharesByPooledEth(stEthAmount);

        const requestIdBefore = await queue.getLastRequestId();

        await expect(queue.connect(user).requestWithdrawalsWstETH([amount], ZeroAddress))
          .to.emit(queue, "WithdrawalRequested")
          .withArgs(1, user.address, user.address, stEthAmount, shares);

        const requestIdAfter = await queue.getLastRequestId();
        const diff = requestIdAfter - requestIdBefore;
        expect(diff).to.equal(requestIdBefore + 1n);
      });
    });

    context("requestWithdrawalsWithPermit", () => {
      const requestsCount = 2;
      const requestSize = ether("10.00");
      const requests = Array(requestsCount).fill(requestSize);
      const amount = BigInt(requestsCount) * requestSize;

      const permit = {
        ...DEFAULT_PERMIT,
        value: amount,
      };

      beforeEach(async () => {
        await stEth.mockSetTotalPooledEther(ether("100.00"));
        await stEth.exposedMintShares(alice, shares(100n));
        await stEth.connect(alice).approve(queueAddress, ether("100.00"));
      });

      it("Reverts if the contract is paused", async () => {
        await queue.pauseFor(100n);

        await expect(
          queue.connect(alice).requestWithdrawalsWithPermit(requests, stranger, permit),
        ).to.be.revertedWithCustomError(queue, "ResumedExpected");
      });

      it("Reverts bad permit with `INVALID_SIGNATURE`", async () => {
        await stEth.workaroundSetIsSignatureValid(false);

        await expect(queue.connect(alice).requestWithdrawalsWithPermit(requests, owner, permit)).to.be.revertedWith(
          "INVALID_SIGNATURE",
        );
      });

      it("Creates requests for multiple amounts with valid permit", async () => {
        const oneRequestSize = requests[0];
        const shares = await stEth.getSharesByPooledEth(oneRequestSize);

        const requestIdBefore = await queue.getLastRequestId();

        await expect(queue.connect(alice).requestWithdrawalsWithPermit(requests, owner, permit))
          .to.emit(queue, "WithdrawalRequested")
          .withArgs(1, alice.address, owner.address, oneRequestSize, shares)
          .to.emit(queue, "WithdrawalRequested")
          .withArgs(2, alice.address, owner.address, oneRequestSize, shares);

        const diff = (await queue.getLastRequestId()) - requestIdBefore;
        expect(diff).to.equal(requestIdBefore + BigInt(requests.length));
      });

      it("Creates requests for single amounts with valid permit and zero owner address", async () => {
        const request = requests[0];
        const shares = await stEth.getSharesByPooledEth(request);

        const requestIdBefore = await queue.getLastRequestId();

        await expect(queue.connect(alice).requestWithdrawalsWithPermit([request], ZeroAddress, permit))
          .to.emit(queue, "WithdrawalRequested")
          .withArgs(1, alice.address, alice.address, request, shares);

        const diff = (await queue.getLastRequestId()) - requestIdBefore;
        expect(diff).to.equal(requestIdBefore + 1n);
      });
    });

    context("requestWithdrawalsWstETHWithPermit", () => {
      const requestsCount = 2;
      const requestSize = ether("10.00");
      const requests = Array(requestsCount).fill(requestSize);
      const amount = BigInt(requestsCount) * requestSize * 10n;
      const permit = { ...DEFAULT_PERMIT, value: amount };

      beforeEach(async () => {
        await stEth.mockSetTotalPooledEther(ether("200.00"));
        await stEth.exposedMintShares(wstEthAddress, shares(100n));
        await stEth.exposedMintShares(alice, shares(100n));

        await wstEth.exposedMint(alice, ether("100.00"));
        await wstEth.connect(alice).approve(queueAddress, ether("300.00"));
      });

      it("Reverts if the contract is paused", async () => {
        await queue.pauseFor(100n);

        await expect(
          queue.connect(alice).requestWithdrawalsWstETHWithPermit(requests, owner, permit),
        ).to.be.revertedWithCustomError(queue, "ResumedExpected");
      });

      it("Reverts bad permit with `ERC20Permit: invalid signature`", async () => {
        await wstEth.workaroundSetIsSignatureValid(false);

        await expect(
          queue.connect(alice).requestWithdrawalsWstETHWithPermit(requests, owner, permit),
        ).to.be.revertedWith("ERC20Permit: invalid signature");
      });

      it("Creates requests for multiple amounts with valid permit", async () => {
        const oneRequestSize = requests[0];
        const stEthAmount = await wstEth.getStETHByWstETH(oneRequestSize);
        const shares = await stEth.getSharesByPooledEth(stEthAmount);
        const requestIdBefore = await queue.getLastRequestId();

        await expect(queue.connect(alice).requestWithdrawalsWstETHWithPermit(requests, owner, permit))
          .to.emit(queue, "WithdrawalRequested")
          .withArgs(1, alice.address, owner.address, stEthAmount, shares)
          .to.emit(queue, "WithdrawalRequested")
          .withArgs(2, alice.address, owner.address, stEthAmount, shares);

        const requestIdAfter = await queue.getLastRequestId();
        const diff = requestIdAfter - requestIdBefore;
        expect(diff).to.equal(requestIdBefore + BigInt(requests.length));
      });

      it("Creates requests for single amounts with valid permit and zero owner address", async () => {
        const request = requests[0];
        const stEthAmount = await wstEth.getStETHByWstETH(request);
        const shares = await stEth.getSharesByPooledEth(stEthAmount);
        const requestIdBefore = await queue.getLastRequestId();

        await expect(queue.connect(alice).requestWithdrawalsWstETHWithPermit([request], ZeroAddress, permit))
          .to.emit(queue, "WithdrawalRequested")
          .withArgs(1, alice.address, alice.address, stEthAmount, shares);

        const requestIdAfter = await queue.getLastRequestId();
        const diff = requestIdAfter - requestIdBefore;
        expect(diff).to.equal(requestIdBefore + 1n);
      });
    });

    context("getWithdrawalRequests", () => {
      beforeEach(async () => {
        await stEth.mockSetTotalPooledEther(ether("1000.00"));
        await stEth.exposedMintShares(user, shares(300n));
        await stEth.connect(user).approve(queueAddress, ether("300.00"));
      });

      it("Returns the requested amounts", async () => {
        const amount1 = ether("10.00");
        const amount2 = ether("20.00");

        await queue.connect(user).requestWithdrawals([amount1, amount2], stranger);

        expect(await queue.getWithdrawalRequests(user)).to.deep.equal([]);
        expect(await queue.getWithdrawalRequests(stranger)).to.deep.equal([1n, 2n]);
      });
    });

    context("getWithdrawalStatus", () => {
      beforeEach(async () => {
        await stEth.mockSetTotalPooledEther(ether("1000.00"));
        await setBalance(stEthAddress, ether("1001.00"));

        await stEth.exposedMintShares(user, shares(300n));
        await stEth.connect(user).approve(queueAddress, ether("300.00"));
      });

      it("Reverts if the request does not exist", async () => {
        await expect(queue.getWithdrawalStatus([1]))
          .to.be.revertedWithCustomError(queue, "InvalidRequestId")
          .withArgs(1);
      });

      it("Returns empty array if no requests", async () => {
        expect(await queue.getWithdrawalStatus([])).to.deep.equal([]);
      });

      it("Returns correct status", async () => {
        const amount1 = ether("10.00");
        const amount2 = ether("20.00");

        const shares1 = await stEth.getSharesByPooledEth(amount1);
        const shares2 = await stEth.getSharesByPooledEth(amount2);

        await queue.connect(user).requestWithdrawals([amount1, amount2], stranger);

        const timestamp = BigInt(await time.latest());

        expect(await queue.getWithdrawalStatus([1, 2])).to.deep.equal([
          [amount1, shares1, stranger.address, timestamp, false, false],
          [amount2, shares2, stranger.address, timestamp, false, false],
        ]);
      });
    });
  });

  context("getClaimableEther", () => {
    const requests = [1, 2];
    const amounts = [ether("10.00"), ether("20.00")];
    let lastCheckpointIndex: bigint;

    beforeEach(async () => {
      await queue.initialize(owner);
      await queue.grantRole(await queue.RESUME_ROLE(), owner);
      await queue.resume();

      await stEth.mockSetTotalPooledEther(ether("300.00"));
      await stEth.exposedMintShares(user, shares(300n));
      await stEth.connect(user).approve(queueAddress, ether("300.00"));

      await queue.connect(user).requestWithdrawals(amounts, stranger);
      await queue.prefinalize(requests, shareRate(1n));

      // Only finalize the first request, the second one will be finalized later in the test
      await queue.exposedFinalize(1, shareRate(1n), { value: amounts[0] });

      lastCheckpointIndex = await queue.getLastCheckpointIndex();
    });

    it("Reverts if the request id is zero", async () => {
      await expect(queue.getClaimableEther([0], [0]))
        .to.be.revertedWithCustomError(queue, "InvalidRequestId")
        .withArgs(0);
    });

    it("Reverts if the request id is out of bounds", async () => {
      await expect(queue.getClaimableEther([3], [0]))
        .to.be.revertedWithCustomError(queue, "InvalidRequestId")
        .withArgs(3);
    });

    it("Returns 0 if the request is not finalized", async () => {
      expect(await queue.getClaimableEther([2], [lastCheckpointIndex])).to.deep.equal([0n]);
    });

    it("Returns 0 if the request is already claimed", async () => {
      await queue.connect(stranger).claimWithdrawal(1);

      expect(await queue.getClaimableEther([1], [lastCheckpointIndex])).to.deep.equal([0n]);
    });

    it("Returns the claimable ether", async () => {
      await queue.connect(user).requestWithdrawals([], stranger);
      await queue.exposedFinalize(2, shareRate(1n), { value: amounts[0] }); // Finalize the second request

      lastCheckpointIndex = await queue.getLastCheckpointIndex();
      const hints = await queue.findCheckpointHints(requests, 1, lastCheckpointIndex);

      expect(
        await queue.getClaimableEther(
          requests,
          hints.map((v) => v.valueOf()),
        ),
      ).to.deep.equal(amounts);
    });
  });

  context("Claim Withdrawals", () => {
    beforeEach(async () => {
      await queue.initialize(owner);
      await queue.grantRole(await queue.PAUSE_ROLE(), owner);
      await queue.grantRole(await queue.RESUME_ROLE(), owner);
      await queue.resume();
    });

    context("claimWithdrawalsTo", () => {
      it("Reverts on zero recipient address", async () => {
        await expect(queue.connect(owner).claimWithdrawalsTo([1], [1], ZeroAddress)).to.be.revertedWithCustomError(
          queue,
          "ZeroRecipient",
        );
      });

      it("Reverts on arrays length mismatch", async () => {
        await expect(queue.connect(owner).claimWithdrawalsTo([1], [], stranger))
          .to.revertedWithCustomError(queue, "ArraysLengthMismatch")
          .withArgs(1, 0);
      });

      it("Claims the withdrawals for stranger and emit `WithdrawalClaimed` and triggers emitting of `Transfer` event", async () => {
        await setBalance(queueAddress, ether("10.00"));

        const requests = [1, 2];

        for (const requestId of requests) {
          await queue.exposedEnqueue(ether("1.00"), shares(1n), owner);
          await queue.prefinalize([requestId], shareRate(1n));
          await queue.exposedFinalize(requestId, shareRate(1n), { value: ether("1.00") });
        }

        const lastCheckpointIndex = await queue.getLastCheckpointIndex();
        const hints = await queue.findCheckpointHints(requests, 1, lastCheckpointIndex);

        await expect(
          queue.connect(owner).claimWithdrawalsTo(
            requests,
            hints.map((h) => h.valueOf()),
            stranger,
          ),
        )
          .to.emit(queue, "WithdrawalClaimed")
          .withArgs(1, owner.address, stranger.address, ether("1.00"))
          .to.emit(queue, "WithdrawalClaimed")
          .withArgs(2, owner.address, stranger.address, ether("1.00"))
          .to.emit(queue, "Mock__Transfer")
          .withArgs(owner.address, ZeroAddress, requests[0])
          .to.emit(queue, "Mock__Transfer")
          .withArgs(owner.address, ZeroAddress, requests[1]);
      });
    });

    context("claimWithdrawals", () => {
      it("Reverts on arrays length mismatch", async () => {
        await expect(queue.connect(owner).claimWithdrawals([1], []))
          .to.revertedWithCustomError(queue, "ArraysLengthMismatch")
          .withArgs(1, 0);
      });

      it("Claims the withdrawals and emit `WithdrawalClaimed` and triggers emitting of `Transfer` event", async () => {
        await setBalance(queueAddress, ether("10.00"));

        const requests = [1, 2];

        for (const requestId of requests) {
          await queue.exposedEnqueue(ether("1.00"), shares(1n), owner);
          await queue.prefinalize([requestId], shareRate(1n));
          await queue.exposedFinalize(requestId, shareRate(1n), { value: ether("1.00") });
        }

        const lastCheckpointIndex = await queue.getLastCheckpointIndex();
        const hints = await queue.findCheckpointHints(requests, 1, lastCheckpointIndex);

        await expect(
          queue.connect(owner).claimWithdrawals(
            requests,
            hints.map((h) => h.valueOf()),
          ),
        )
          .to.emit(queue, "WithdrawalClaimed")
          .withArgs(1, owner.address, owner.address, ether("1.00"))
          .to.emit(queue, "WithdrawalClaimed")
          .withArgs(2, owner.address, owner.address, ether("1.00"))
          .to.emit(queue, "Mock__Transfer")
          .withArgs(owner.address, ZeroAddress, requests[0])
          .to.emit(queue, "Mock__Transfer")
          .withArgs(owner.address, ZeroAddress, requests[1]);
      });
    });

    context("claimWithdrawal", () => {
      it("Claims the withdrawals and emit `WithdrawalClaimed` and triggers emitting of `Transfer` event", async () => {
        const requestId = 1;

        await setBalance(queueAddress, ether("10.00"));
        await queue.exposedEnqueue(ether("1.00"), shares(1n), owner);
        await queue.prefinalize([requestId], shareRate(1n));
        await queue.exposedFinalize(requestId, shareRate(1n), { value: ether("1.00") });

        await expect(queue.connect(owner).claimWithdrawal(requestId))
          .to.emit(queue, "WithdrawalClaimed")
          .withArgs(1, owner.address, owner.address, ether("1.00"))
          .to.emit(queue, "Mock__Transfer")
          .withArgs(owner.address, ZeroAddress, requestId);
      });
    });
  });

  context("findCheckpointHints", () => {
    const requests = [1, 2];
    let lastCheckpointIndex: bigint;

    beforeEach(async () => {
      await queue.initialize(owner);
      await queue.grantRole(await queue.RESUME_ROLE(), owner);
      await queue.resume();

      for (const requestId of requests) {
        await queue.exposedEnqueue(ether("1.00"), shares(1n), owner);
        await queue.prefinalize([requestId], shareRate(1n));
        await queue.exposedFinalize(requestId, shareRate(1n), { value: ether("1.00") });
      }

      lastCheckpointIndex = await queue.getLastCheckpointIndex();
    });

    it("Reverts if the requestIds are not sorted", async () => {
      await expect(queue.findCheckpointHints([2, 1], 1, 1)).to.be.revertedWithCustomError(queue, "RequestIdsNotSorted");
    });

    it("Returns the checkpoint hints", async () => {
      const hints = await queue.findCheckpointHints(requests, 1, lastCheckpointIndex);

      expect(hints).to.deep.equal([1n, 2n]);
    });
  });

  context("Bunker Mode", () => {
    context("onOracleReport", () => {
      beforeEach(async () => {
        await queue.initialize(owner);
        await queue.grantRole(await queue.ORACLE_ROLE(), oracle);
      });

      it("Reverts if not called by the oracle", async () => {
        await expect(queue.connect(stranger).onOracleReport(true, 0, 0)).to.be.revertedWithOZAccessControlError(
          stranger.address,
          ORACLE_ROLE,
        );
      });

      it("Reverts if the bunker mode start time in future", async () => {
        const futureTimestamp = (await time.latest()) + 1000;

        await expect(queue.connect(oracle).onOracleReport(true, futureTimestamp, 0)).to.be.revertedWithCustomError(
          queue,
          "InvalidReportTimestamp",
        );
      });

      it("Reverts if the current report time in future", async () => {
        const futureTimestamp = (await time.latest()) + 1000;

        await expect(queue.connect(oracle).onOracleReport(true, 0, futureTimestamp)).to.be.revertedWithCustomError(
          queue,
          "InvalidReportTimestamp",
        );
      });

      it("Enables bunker mode and emit `BunkerModeEnabled`", async () => {
        const validTimestamp = await time.latest();

        await expect(queue.connect(oracle).onOracleReport(true, validTimestamp, validTimestamp))
          .to.emit(queue, "BunkerModeEnabled")
          .withArgs(validTimestamp);

        expect(await queue.isBunkerModeActive()).to.equal(true);
        expect(await queue.bunkerModeSinceTimestamp()).to.equal(validTimestamp);
      });

      it("Disables bunker mode and emit `BunkerModeDisabled`", async () => {
        const validTimestamp = await time.latest();

        await queue.connect(oracle).onOracleReport(true, validTimestamp, validTimestamp);

        await expect(queue.connect(oracle).onOracleReport(false, validTimestamp, validTimestamp + 1)).to.emit(
          queue,
          "BunkerModeDisabled",
        );

        expect(await queue.isBunkerModeActive()).to.equal(false);
        expect(await queue.bunkerModeSinceTimestamp()).to.equal(BUNKER_MODE_DISABLED_TIMESTAMP);
      });

      it("Changes nothing if the bunker mode is already active", async () => {
        const validTimestamp = await time.latest();

        await queue.connect(oracle).onOracleReport(true, validTimestamp, validTimestamp);

        await expect(queue.connect(oracle).onOracleReport(true, validTimestamp, validTimestamp)).to.not.emit(
          queue,
          "BunkerModeEnabled",
        );

        expect(await queue.isBunkerModeActive()).to.equal(true);
        expect(await queue.bunkerModeSinceTimestamp()).to.equal(validTimestamp);
      });
    });

    context("isBunkerModeActive", () => {
      it("Returns true if bunker mode is active", async () => {
        expect(await queue.isBunkerModeActive()).to.equal(true);
      });

      it("Returns false if bunker mode is disabled", async () => {
        await queue.initialize(queueAddress); // Disable bunker mode

        expect(await queue.isBunkerModeActive()).to.equal(false);
      });
    });

    context("bunkerModeSinceTimestamp", () => {
      it("Returns 0 if bunker mode is active", async () => {
        expect(await queue.bunkerModeSinceTimestamp()).to.equal(0);
      });

      it("Returns the timestamp if bunker mode is disabled", async () => {
        await queue.initialize(queueAddress); // Disable bunker mode

        expect(await queue.bunkerModeSinceTimestamp()).to.equal(BUNKER_MODE_DISABLED_TIMESTAMP);
      });
    });
  });
});
