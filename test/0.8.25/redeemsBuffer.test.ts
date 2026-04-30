import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Burner__MockForRedeemsBuffer,
  ERC20__MockForRedeemsBuffer,
  HashConsensus__MockForRedeemsBuffer,
  Lido__MockForRedeemsBuffer,
  RedeemsBuffer,
  WithdrawalQueue__MockForRedeemsBuffer,
} from "typechain-types";

import { ether, impersonate, proxify } from "lib";

import { Snapshot } from "test/suite";

describe("RedeemsBuffer.sol", () => {
  let admin: HardhatEthersSigner;
  let redeemer: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;

  let lido: Lido__MockForRedeemsBuffer;
  let burner: Burner__MockForRedeemsBuffer;
  let wq: WithdrawalQueue__MockForRedeemsBuffer;
  let consensus: HashConsensus__MockForRedeemsBuffer;
  let buffer: RedeemsBuffer;

  let lidoSigner: HardhatEthersSigner;

  const DEFAULT_REF_SLOT = 100n;

  let originalState: string;

  before(async () => {
    [, admin, redeemer, stranger, recipient] = await ethers.getSigners();

    // Deploy mocks
    lido = await ethers.deployContract("Lido__MockForRedeemsBuffer", []);
    burner = await ethers.deployContract("Burner__MockForRedeemsBuffer", []);
    wq = await ethers.deployContract("WithdrawalQueue__MockForRedeemsBuffer", []);
    consensus = await ethers.deployContract("HashConsensus__MockForRedeemsBuffer", [DEFAULT_REF_SLOT]);

    // Deploy RedeemsBuffer behind OssifiableProxy
    const bufferImpl = await ethers.deployContract("RedeemsBuffer", [
      await lido.getAddress(),
      await burner.getAddress(),
      await wq.getAddress(),
      await consensus.getAddress(),
    ]);
    [buffer] = await proxify<RedeemsBuffer>({ impl: bufferImpl, admin });

    // Initialize
    await buffer.initialize(admin.address);

    // Grant REDEEMER_ROLE to redeemer
    const REDEEMER_ROLE = await buffer.REDEEMER_ROLE();
    await buffer.connect(admin).grantRole(REDEEMER_ROLE, redeemer.address);

    // Grant RESUME_ROLE to admin and resume (PausableUntil starts paused-like, but default is 0 which means resumed)
    const RESUME_ROLE = await buffer.RESUME_ROLE();
    await buffer.connect(admin).grantRole(RESUME_ROLE, admin.address);

    const PAUSE_ROLE = await buffer.PAUSE_ROLE();
    await buffer.connect(admin).grantRole(PAUSE_ROLE, admin.address);

    const RECOVER_ROLE = await buffer.RECOVER_ROLE();
    await buffer.connect(admin).grantRole(RECOVER_ROLE, admin.address);

    // Impersonate Lido for calling fundReserve / reconcile
    lidoSigner = await impersonate(await lido.getAddress(), ether("100"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("initialize", () => {
    it("reverts on zero admin", async () => {
      const freshImpl = await ethers.deployContract("RedeemsBuffer", [
        await lido.getAddress(),
        await burner.getAddress(),
        await wq.getAddress(),
        await consensus.getAddress(),
      ]);
      const [freshBuffer] = await proxify<RedeemsBuffer>({ impl: freshImpl, admin });
      await expect(freshBuffer.initialize(ZeroAddress)).to.be.revertedWithCustomError(freshBuffer, "AdminCannotBeZero");
    });

    it("reverts on double initialize", async () => {
      await expect(buffer.initialize(admin.address)).to.be.revertedWithCustomError(buffer, "InvalidInitialization");
    });

    it("reverts when calling initialize on the implementation directly", async () => {
      const impl = await ethers.deployContract("RedeemsBuffer", [
        await lido.getAddress(),
        await burner.getAddress(),
        await wq.getAddress(),
        await consensus.getAddress(),
      ]);
      await expect(impl.initialize(admin.address)).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });

    it("grants DEFAULT_ADMIN_ROLE to admin", async () => {
      const DEFAULT_ADMIN_ROLE = await buffer.DEFAULT_ADMIN_ROLE();
      expect(await buffer.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("returns contract version 1", async () => {
      expect(await buffer.getContractVersion()).to.equal(1);
    });
  });

  context("redeem", () => {
    const redeemAmount = ether("1");

    async function fundAndPrepare(amount: bigint) {
      // Fund the buffer via Lido
      await buffer.connect(lidoSigner).fundReserve({ value: amount });
    }

    it("reverts when paused", async () => {
      await buffer.connect(admin).pauseFor(1000);
      await expect(buffer.connect(redeemer).redeem(redeemAmount, recipient.address)).to.be.revertedWithCustomError(
        buffer,
        "ResumedExpected",
      );
    });

    it("reverts when caller lacks REDEEMER_ROLE", async () => {
      const REDEEMER_ROLE = await buffer.REDEEMER_ROLE();
      await expect(buffer.connect(stranger).redeem(redeemAmount, recipient.address))
        .to.be.revertedWithCustomError(buffer, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, REDEEMER_ROLE);
    });

    it("reverts on zero amount", async () => {
      await expect(buffer.connect(redeemer).redeem(0, recipient.address)).to.be.revertedWithCustomError(
        buffer,
        "ZeroAmount",
      );
    });

    it("reverts on zero recipient", async () => {
      await expect(buffer.connect(redeemer).redeem(redeemAmount, ZeroAddress)).to.be.revertedWithCustomError(
        buffer,
        "ZeroRecipient",
      );
    });

    it("reverts when Lido stopped", async () => {
      await lido.setStopped(true);
      await expect(buffer.connect(redeemer).redeem(redeemAmount, recipient.address)).to.be.revertedWithCustomError(
        buffer,
        "LidoStopped",
      );
    });

    it("reverts when bunker mode active", async () => {
      await wq.setBunkerMode(true);
      await expect(buffer.connect(redeemer).redeem(redeemAmount, recipient.address)).to.be.revertedWithCustomError(
        buffer,
        "BunkerModeActive",
      );
    });

    it("reverts when WQ paused", async () => {
      await wq.setPaused(true);
      await expect(buffer.connect(redeemer).redeem(redeemAmount, recipient.address)).to.be.revertedWithCustomError(
        buffer,
        "WithdrawalQueuePaused",
      );
    });

    it("reverts when insufficient reserve", async () => {
      // Fund less than redeemAmount
      await fundAndPrepare(ether("0.5"));
      await expect(buffer.connect(redeemer).redeem(redeemAmount, recipient.address))
        .to.be.revertedWithCustomError(buffer, "InsufficientReserve")
        .withArgs(redeemAmount, ether("0.5"));
    });

    it("successfully redeems: emits Redeemed event, updates store, sends ETH to recipient", async () => {
      await fundAndPrepare(ether("10"));

      const recipientBalanceBefore = await ethers.provider.getBalance(recipient.address);

      await expect(buffer.connect(redeemer).redeem(redeemAmount, recipient.address))
        .to.emit(buffer, "Redeemed")
        .withArgs(redeemer.address, recipient.address, redeemAmount, redeemAmount, redeemAmount);

      const [redeemedEther, redeemedShares] = await buffer.getRedeemed();
      expect(redeemedEther).to.equal(redeemAmount);
      expect(redeemedShares).to.equal(redeemAmount);

      const recipientBalanceAfter = await ethers.provider.getBalance(recipient.address);
      expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(redeemAmount);
    });
  });

  context("uint104 overflow on redeemedEther", () => {
    it("reverts on arithmetic overflow when cumulative redeemedEther would exceed type(uint104).max", async () => {
      const MAX_UINT104 = (1n << 104n) - 1n;

      const HUGE_BALANCE = MAX_UINT104 + ether("10");
      await ethers.provider.send("hardhat_setBalance", [await lido.getAddress(), "0x" + HUGE_BALANCE.toString(16)]);

      await buffer.connect(lidoSigner).fundReserve({ value: MAX_UINT104 + 1n });

      await buffer.connect(redeemer).redeem(MAX_UINT104, recipient.address);
      expect((await buffer.getRedeemed())[0]).to.equal(MAX_UINT104);

      await expect(buffer.connect(redeemer).redeem(1n, recipient.address)).to.be.revertedWithPanic(0x11);
    });
  });

  context("fundReserve", () => {
    it("reverts when caller is not Lido", async () => {
      await expect(buffer.connect(stranger).fundReserve({ value: ether("1") })).to.be.revertedWithCustomError(
        buffer,
        "NotLido",
      );
    });

    it("increments _reserveBalance and emits ReserveFunded", async () => {
      const amount = ether("5");

      await expect(buffer.connect(lidoSigner).fundReserve({ value: amount }))
        .to.emit(buffer, "ReserveFunded")
        .withArgs(amount);

      expect(await buffer.getReserveBalance()).to.equal(amount);

      // Fund again
      await expect(buffer.connect(lidoSigner).fundReserve({ value: amount }))
        .to.emit(buffer, "ReserveFunded")
        .withArgs(amount);

      expect(await buffer.getReserveBalance()).to.equal(amount * 2n);
    });
  });

  context("reconcile", () => {
    it("reverts when caller is not Lido", async () => {
      await expect(buffer.connect(stranger).reconcile(0, 0)).to.be.revertedWithCustomError(buffer, "NotLido");
    });

    it("returns unredeemed ETH to Lido", async () => {
      await buffer.connect(lidoSigner).fundReserve({ value: ether("10") });
      await buffer.connect(redeemer).redeem(ether("3"), recipient.address);

      const receivedBefore = await lido.receivedETH();
      await buffer.connect(lidoSigner).reconcile(ether("3"), ether("3"));
      const receivedAfter = await lido.receivedETH();

      expect(receivedAfter - receivedBefore).to.equal(ether("7"));
      expect(await buffer.getReserveBalance()).to.equal(0);
    });

    it("preserves post-refSlot redeems when the snapshot is smaller than live", async () => {
      await buffer.connect(lidoSigner).fundReserve({ value: ether("10") });
      await buffer.connect(redeemer).redeem(ether("5"), recipient.address);
      await buffer.connect(lidoSigner).reconcile(ether("2"), ether("2"));

      const [postRefSlotRedeemedEther, postRefSlotRedeemedShares] = await buffer.getRedeemed();
      expect(postRefSlotRedeemedEther).to.equal(ether("3"));
      expect(postRefSlotRedeemedShares).to.equal(ether("3"));
      expect(await buffer.getReserveBalance()).to.equal(0);
    });

    it("zeroes when snapshot == live", async () => {
      await buffer.connect(lidoSigner).fundReserve({ value: ether("10") });
      await buffer.connect(redeemer).redeem(ether("4"), recipient.address);
      await buffer.connect(lidoSigner).reconcile(ether("4"), ether("4"));

      const [postRefSlotRedeemedEther, postRefSlotRedeemedShares] = await buffer.getRedeemed();
      expect(postRefSlotRedeemedEther).to.equal(0);
      expect(postRefSlotRedeemedShares).to.equal(0);
      expect(await buffer.getReserveBalance()).to.equal(0);
    });
  });

  context("validateReconciledAndPause", () => {
    it("reverts when caller is not Lido", async () => {
      await expect(buffer.connect(stranger).validateReconciledAndPause()).to.be.revertedWithCustomError(
        buffer,
        "NotLido",
      );
    });

    it("reverts when reserve balance is non-zero", async () => {
      await buffer.connect(lidoSigner).fundReserve({ value: ether("4") });

      await expect(buffer.connect(lidoSigner).validateReconciledAndPause())
        .to.be.revertedWithCustomError(buffer, "BufferNotReconciled")
        .withArgs(ether("4"), 0, 0);
    });

    it("reverts when there are in-flight redeemed ether/shares", async () => {
      await buffer.connect(lidoSigner).fundReserve({ value: ether("10") });
      await buffer.connect(redeemer).redeem(ether("3"), recipient.address);
      await buffer.connect(lidoSigner).reconcile(0, 0);

      await expect(buffer.connect(lidoSigner).validateReconciledAndPause())
        .to.be.revertedWithCustomError(buffer, "BufferNotReconciled")
        .withArgs(0, ether("3"), ether("3"));
    });

    it("succeeds after a normal reconcile fully clears state and infinitely pauses", async () => {
      await buffer.connect(lidoSigner).fundReserve({ value: ether("10") });
      await buffer.connect(redeemer).redeem(ether("4"), recipient.address);
      await buffer.connect(lidoSigner).reconcile(ether("4"), ether("4"));

      expect(await buffer.getReserveBalance()).to.equal(0);
      const [redeemedEther, redeemedShares] = await buffer.getRedeemed();
      expect(redeemedEther).to.equal(0);
      expect(redeemedShares).to.equal(0);

      const receivedBefore = await lido.receivedETH();
      await buffer.connect(lidoSigner).validateReconciledAndPause();
      const receivedAfter = await lido.receivedETH();

      expect(receivedAfter).to.equal(receivedBefore, "no ETH should move during validation");
      expect(await buffer.isPaused()).to.equal(true);
      await expect(buffer.connect(redeemer).redeem(ether("0.1"), recipient.address)).to.be.reverted;
    });

    it("succeeds on a freshly initialized buffer (all-zero state)", async () => {
      expect(await buffer.getReserveBalance()).to.equal(0);
      await buffer.connect(lidoSigner).validateReconciledAndPause();
      expect(await buffer.isPaused()).to.equal(true);
    });
  });

  context("recoverERC20", () => {
    let token: ERC20__MockForRedeemsBuffer;

    before(async () => {
      token = await ethers.deployContract("ERC20__MockForRedeemsBuffer", ["Test Token", "TT"]);
    });

    it("reverts on zero recipient", async () => {
      await expect(
        buffer.connect(admin).recoverERC20(await token.getAddress(), ether("1"), ZeroAddress),
      ).to.be.revertedWithCustomError(buffer, "ZeroRecipient");
    });

    it("reverts when token is stETH", async () => {
      await expect(
        buffer.connect(admin).recoverERC20(await lido.getAddress(), ether("1"), await lido.getAddress()),
      ).to.be.revertedWithCustomError(buffer, "StETHRecoveryNotAllowed");
    });

    it("transfers token to caller", async () => {
      const amount = ether("5");
      // Mint tokens to the buffer
      await token.mint(await buffer.getAddress(), amount);

      const balanceBefore = await token.balanceOf(admin.address);
      await buffer.connect(admin).recoverERC20(await token.getAddress(), amount, admin.address);
      const balanceAfter = await token.balanceOf(admin.address);

      expect(balanceAfter - balanceBefore).to.equal(amount);
    });

    it("reverts when caller lacks RECOVER_ROLE", async () => {
      await expect(buffer.connect(stranger).recoverERC20(await token.getAddress(), ether("1"), admin.address)).to.be
        .reverted;
    });
  });

  context("recoverStETHShares", () => {
    it("reverts on zero recipient", async () => {
      await expect(buffer.connect(admin).recoverStETHShares(ZeroAddress)).to.be.revertedWithCustomError(
        buffer,
        "ZeroRecipient",
      );
    });

    it("transfers stuck shares to recipient", async () => {
      const stuck = ether("7");
      await lido.setSharesOnBuffer(stuck);

      await expect(buffer.connect(admin).recoverStETHShares(recipient.address))
        .to.emit(buffer, "StETHSharesRecovered")
        .withArgs(admin.address, stuck, recipient.address);
    });

    it("does nothing when no shares are stuck", async () => {
      await lido.setSharesOnBuffer(0);

      await expect(buffer.connect(admin).recoverStETHShares(recipient.address)).to.not.emit(
        buffer,
        "StETHSharesRecovered",
      );
    });

    it("reverts when caller lacks RECOVER_ROLE", async () => {
      await expect(buffer.connect(stranger).recoverStETHShares(recipient.address)).to.be.reverted;
    });
  });

  context("recoverEther", () => {
    it("reverts on zero recipient", async () => {
      await expect(buffer.connect(admin).recoverEther(ZeroAddress)).to.be.revertedWithCustomError(
        buffer,
        "ZeroRecipient",
      );
    });

    it("recovers zero after redeem without donation (does not underflow)", async () => {
      // Fund 10 ETH, redeem 4 ETH. balance = 6, reserve = 10, redeemed = 4
      // Without the fix, `balance - reserve` underflows — this test guards the formula order.
      await buffer.connect(lidoSigner).fundReserve({ value: ether("10") });
      await buffer.connect(redeemer).redeem(ether("4"), recipient.address);

      const balanceBefore = await ethers.provider.getBalance(recipient.address);
      await buffer.connect(admin).recoverEther(recipient.address);
      const balanceAfter = await ethers.provider.getBalance(recipient.address);

      expect(balanceAfter).to.equal(balanceBefore);
    });

    it("recovers excess ether forced via selfdestruct", async () => {
      const bufferAddr = await buffer.getAddress();
      const forced = ether("3");

      // Force ETH onto buffer bypassing receive()
      await ethers.deployContract("SelfDestructor", [bufferAddr], { value: forced });

      const balanceBefore = await ethers.provider.getBalance(recipient.address);
      await buffer.connect(admin).recoverEther(recipient.address);
      const balanceAfter = await ethers.provider.getBalance(recipient.address);

      expect(balanceAfter - balanceBefore).to.equal(forced);
    });

    it("does nothing when no excess ether", async () => {
      const balanceBefore = await ethers.provider.getBalance(recipient.address);
      await buffer.connect(admin).recoverEther(recipient.address);
      const balanceAfter = await ethers.provider.getBalance(recipient.address);

      expect(balanceAfter).to.equal(balanceBefore);
    });

    it("does not recover reserve ether", async () => {
      const bufferAddr = await buffer.getAddress();

      // Fund reserve via Lido
      await buffer.connect(lidoSigner).fundReserve({ value: ether("10") });

      // Force extra ETH
      const forced = ether("2");
      await ethers.deployContract("SelfDestructor", [bufferAddr], { value: forced });

      const balanceBefore = await ethers.provider.getBalance(recipient.address);
      await buffer.connect(admin).recoverEther(recipient.address);
      const balanceAfter = await ethers.provider.getBalance(recipient.address);

      // Only the forced excess is recovered, not the reserve
      expect(balanceAfter - balanceBefore).to.equal(forced);
    });

    it("reverts when caller lacks RECOVER_ROLE", async () => {
      await expect(buffer.connect(stranger).recoverEther(recipient.address)).to.be.reverted;
    });
  });

  context("receive", () => {
    it("reverts with DirectETHTransfer", async () => {
      await expect(
        stranger.sendTransaction({ to: await buffer.getAddress(), value: ether("1") }),
      ).to.be.revertedWithCustomError(buffer, "DirectETHTransfer");
    });
  });
});
