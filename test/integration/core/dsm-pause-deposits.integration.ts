import { expect } from "chai";
import { Contract, ContractTransactionResponse, Signer, Wallet } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mine, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";

import { DepositSecurityModule } from "typechain-types";

import { DSMPauseMessage, ether, findEventsWithInterfaces, impersonate } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { setSingleGuardian } from "lib/protocol/helpers/dsm";
import { deployDelegationContract } from "lib/protocol/helpers/edf";

import { Snapshot } from "test/suite";

describe("Integration: DSM pause deposits", () => {
  let ctx: ProtocolContext;
  let stranger: HardhatEthersSigner;
  let delegationOwner: HardhatEthersSigner;
  let delegate: HardhatEthersSigner;
  let dsm: DepositSecurityModule;

  let snapshot: string;
  let originalState: string;

  before(async function () {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    if (ctx.isMainnet) this.skip();
    dsm = ctx.contracts.depositSecurityModule;

    [stranger, delegationOwner, delegate] = await ethers.getSigners();

    DSMPauseMessage.setMessagePrefix(await dsm.PAUSE_MESSAGE_PREFIX());
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot));

  async function pauseDeposits(
    pauser: HardhatEthersSigner,
    blockNumber: bigint,
    sig: DepositSecurityModule.GuardianSignatureStruct,
    guardian: string,
  ) {
    expect(await dsm.isDepositsPaused()).to.be.false;

    const pauseDepositTx = await dsm.connect(pauser).pauseDeposits(blockNumber, sig);

    await assertDepositsPaused(pauseDepositTx, guardian);

    return pauseDepositTx;
  }

  async function assertDepositsPaused(pauseDepositTx: ContractTransactionResponse, guardian: string) {
    const receipt = await pauseDepositTx.wait();
    const depositsPausedEvents = findEventsWithInterfaces(receipt!, "DepositsPaused", [dsm.interface]);

    expect(depositsPausedEvents.length).to.equal(1);
    expect(depositsPausedEvents[0].args.guardian).to.equal(guardian);
    expect(await dsm.isDepositsPaused()).to.be.true;
  }

  async function deployGuardian(delegateAddress = delegate.address) {
    const guardian = await deployDelegationContract(delegationOwner, delegateAddress);
    await setSingleGuardian(ctx, guardian.address);
    return guardian;
  }

  async function pauseThroughGuardian(guardian: Contract, blockNumber: bigint, caller: Signer = delegate) {
    const data = dsm.interface.encodeFunctionData("pauseDeposits", [
      blockNumber,
      { guardian: ethers.ZeroAddress, signature: "0x" },
    ]);
    return await (guardian.connect(caller) as Contract).execute(await dsm.getAddress(), data);
  }

  async function ownerUnpauseDeposits() {
    expect(await dsm.isDepositsPaused()).to.be.true;
    const owner = await dsm.getOwner();
    const ownerSigner = await impersonate(owner, ether("1"));

    const unpauseDepositTx = await dsm.connect(ownerSigner).unpauseDeposits();

    const receipt = await unpauseDepositTx.wait();
    const depositsUnpausedEvents = findEventsWithInterfaces(receipt!, "DepositsUnpaused", [dsm.interface]);

    expect(depositsUnpausedEvents.length).to.equal(1);
    expect(await dsm.isDepositsPaused()).to.be.false;

    return unpauseDepositTx;
  }

  it("Should allow guardian to pause deposits and owner to unpause", async () => {
    const guardian = await deployGuardian();

    const blockNumber = await time.latestBlock();
    const tx = await pauseThroughGuardian(guardian.contract, BigInt(blockNumber));
    await assertDepositsPaused(tx, guardian.address);
    await ownerUnpauseDeposits();
  });

  it("Should allow stranger to pause deposits with guardian signature", async () => {
    const guardianDelegate = Wallet.createRandom();

    // Set single guardian
    const guardian = await deployGuardian(guardianDelegate.address);

    // Generate signature
    const blockNumber = await time.latestBlock();
    const pauseMessage = new DSMPauseMessage(guardian.address, blockNumber);
    const sig = await pauseMessage.sign(guardianDelegate.privateKey);

    // Pause and unpause
    await pauseDeposits(stranger, BigInt(blockNumber), sig, guardian.address);
    await ownerUnpauseDeposits();
  });

  it("Should reject direct DSM calls from the delegate EOA", async () => {
    await deployGuardian();

    await expect(
      dsm.connect(delegate).pauseDeposits(await time.latestBlock(), {
        guardian: ethers.ZeroAddress,
        signature: "0x",
      }),
    ).to.be.revertedWithCustomError(dsm, "InvalidSignature");
  });

  it("Should revert when trying to pause deposits with expired block number", async () => {
    const guardian = await deployGuardian();

    // Setting pause intent validity period to a lesser value because
    // hardhat node fails to restore snapshot after mining ~6k blocks
    const pauseIntentValidityPeriodBlocks = 40;
    const owner = await dsm.getOwner();
    const ownerSigner = await impersonate(owner, ether("1"));
    await dsm.connect(ownerSigner).setPauseIntentValidityPeriodBlocks(pauseIntentValidityPeriodBlocks);

    const expiredBlockNumber = await time.latestBlock();
    await mine(Number(pauseIntentValidityPeriodBlocks) + 1);

    await expect(pauseThroughGuardian(guardian.contract, BigInt(expiredBlockNumber))).to.be.revertedWithCustomError(
      dsm,
      "PauseIntentExpired",
    );
  });

  it("Should revert when stranger tries to pause deposits without valid guardian signature", async () => {
    expect(await dsm.isDepositsPaused()).to.equal(false);

    // Try with empty signature
    await expect(
      dsm.connect(stranger).pauseDeposits(await time.latestBlock(), {
        guardian: (await dsm.getGuardians())[0],
        signature: "0x",
      }),
    ).to.be.revertedWithCustomError(dsm, "InvalidSignature");

    // Try with non-guardian signature
    const blockNumber = await time.latestBlock();
    const nonGuardian = Wallet.createRandom();
    const pauseMessage = new DSMPauseMessage(stranger.address, blockNumber);
    const sig = pauseMessage.sign(nonGuardian.privateKey);

    await expect(dsm.connect(stranger).pauseDeposits(blockNumber, sig)).to.be.revertedWithCustomError(
      dsm,
      "InvalidSignature",
    );
  });

  it("Should keep the current delegate signature valid during rotation cooldown", async () => {
    const cooldown = 100n;
    const currentDelegate = Wallet.createRandom();
    const nextDelegate = Wallet.createRandom();
    const guardian = await deployDelegationContract(delegationOwner, currentDelegate.address, cooldown);
    await setSingleGuardian(ctx, guardian.address);

    await (
      await (guardian.contract.connect(delegationOwner) as Contract).nominateDelegate(nextDelegate.address)
    ).wait();

    const blockNumber = await time.latestBlock();
    const pauseMessage = new DSMPauseMessage(guardian.address, blockNumber);
    const currentSig = pauseMessage.sign(currentDelegate.privateKey);
    const nextSig = pauseMessage.sign(nextDelegate.privateKey);

    await expect(dsm.connect(stranger).pauseDeposits(blockNumber, nextSig)).to.be.revertedWithCustomError(
      dsm,
      "InvalidSignature",
    );
    await pauseDeposits(stranger, BigInt(blockNumber), currentSig, guardian.address);
  });

  it("Should accept only the new delegate signature after rotation cooldown", async () => {
    const cooldown = 100n;
    const currentDelegate = Wallet.createRandom();
    const nextDelegate = Wallet.createRandom();
    const guardian = await deployDelegationContract(delegationOwner, currentDelegate.address, cooldown);
    await setSingleGuardian(ctx, guardian.address);

    await (
      await (guardian.contract.connect(delegationOwner) as Contract).nominateDelegate(nextDelegate.address)
    ).wait();
    await time.increase(cooldown);

    const blockNumber = await time.latestBlock();
    const pauseMessage = new DSMPauseMessage(guardian.address, blockNumber);
    const oldSig = pauseMessage.sign(currentDelegate.privateKey);
    const newSig = pauseMessage.sign(nextDelegate.privateKey);

    await expect(dsm.connect(stranger).pauseDeposits(blockNumber, oldSig)).to.be.revertedWithCustomError(
      dsm,
      "InvalidSignature",
    );
    await pauseDeposits(stranger, BigInt(blockNumber), newSig, guardian.address);
  });

  it("Should invalidate guardian signatures after delegate revocation", async () => {
    const currentDelegate = Wallet.createRandom().connect(ethers.provider);
    await setBalance(currentDelegate.address, ether("1"));
    const guardian = await deployDelegationContract(delegationOwner, currentDelegate.address);
    await setSingleGuardian(ctx, guardian.address);

    const blockNumber = await time.latestBlock();
    const sig = new DSMPauseMessage(guardian.address, blockNumber).sign(currentDelegate.privateKey);
    await (await (guardian.contract.connect(delegationOwner) as Contract).revokeDelegate()).wait();

    await expect(dsm.connect(stranger).pauseDeposits(blockNumber, sig)).to.be.revertedWithCustomError(
      dsm,
      "InvalidSignature",
    );
    await expect(
      pauseThroughGuardian(guardian.contract, BigInt(blockNumber), currentDelegate),
    ).to.be.revertedWithCustomError(guardian.contract, "NotDelegate");
  });

  it("Should invalidate guardian signatures after termination", async () => {
    const currentDelegate = Wallet.createRandom().connect(ethers.provider);
    await setBalance(currentDelegate.address, ether("1"));
    const guardian = await deployDelegationContract(delegationOwner, currentDelegate.address);
    await setSingleGuardian(ctx, guardian.address);

    const blockNumber = await time.latestBlock();
    const sig = new DSMPauseMessage(guardian.address, blockNumber).sign(currentDelegate.privateKey);
    await (await (guardian.contract.connect(delegationOwner) as Contract).terminate()).wait();

    await expect(dsm.connect(stranger).pauseDeposits(blockNumber, sig)).to.be.revertedWithCustomError(
      dsm,
      "InvalidSignature",
    );
    await expect(
      pauseThroughGuardian(guardian.contract, BigInt(blockNumber), currentDelegate),
    ).to.be.revertedWithCustomError(guardian.contract, "ContractTerminated");
  });
});
