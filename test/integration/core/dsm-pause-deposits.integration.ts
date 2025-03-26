import { expect } from "chai";
import { ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";

import { DepositSecurityModule } from "typechain-types";

import { DSMPauseMessage, ether, findEventsWithInterfaces, impersonate } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { setSingleGuardian } from "lib/protocol/helpers/dsm";

import { Snapshot } from "test/suite";

describe("Integration: DSM pause deposits", () => {
  let ctx: ProtocolContext;
  let stranger: HardhatEthersSigner;
  let dsm: DepositSecurityModule;

  let snapshot: string;
  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();
    dsm = ctx.contracts.depositSecurityModule;

    snapshot = await Snapshot.take();

    [stranger] = await ethers.getSigners();

    DSMPauseMessage.setMessagePrefix(await dsm.PAUSE_MESSAGE_PREFIX());
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot));

  async function pauseDeposits(
    pauser: HardhatEthersSigner,
    blockNumber: bigint,
    sig: DepositSecurityModule.SignatureStruct,
    guardian: string,
  ) {
    expect(await dsm.isDepositsPaused()).to.be.false;

    const pauseDepositTx = await dsm.connect(pauser).pauseDeposits(blockNumber, sig);

    const receipt = await pauseDepositTx.wait();
    const depositsPausedEvents = findEventsWithInterfaces(receipt!, "DepositsPaused", [dsm.interface]);

    expect(depositsPausedEvents.length).to.equal(1);
    expect(depositsPausedEvents[0].args.guardian).to.equal(guardian);
    expect(await dsm.isDepositsPaused()).to.be.true;

    return pauseDepositTx;
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
    const guardian = (await dsm.getGuardians())[0];
    const guardianSigner = await impersonate(guardian, ether("1"));

    const blockNumber = await time.latestBlock();
    await pauseDeposits(guardianSigner, BigInt(blockNumber), { r: ZeroHash, vs: ZeroHash }, guardian);
    await ownerUnpauseDeposits();
  });

  it("Should allow stranger to pause deposits with guardian signature", async () => {
    // Just an arbitrary account for using in tests
    const guardianPrivateKey = "0x516b8a7d9290502f5661da81f0cf43893e3d19cb9aea3c426cfb36e8186e9c09";
    const guardian = new ethers.Wallet(guardianPrivateKey).address;

    // Set single guardian
    await setSingleGuardian(ctx, guardian);

    // Generate signature
    const blockNumber = await time.latestBlock();
    const pauseMessage = new DSMPauseMessage(blockNumber);
    const sig = await pauseMessage.sign(guardianPrivateKey);

    // Pause and unpause
    await pauseDeposits(stranger, BigInt(blockNumber), sig, guardian);
    await ownerUnpauseDeposits();
  });

  it("Should revert when trying to pause deposits with expired block number", async () => {
    const guardian = (await dsm.getGuardians())[0];
    const guardianSigner = await impersonate(guardian, ether("1"));

    // Setting pause intent validity period to a lesser value because
    // hardhat node fails to restore snapshot after mining ~6k blocks
    const pauseIntentValidityPeriodBlocks = 40;
    const owner = await dsm.getOwner();
    const ownerSigner = await impersonate(owner, ether("1"));
    await dsm.connect(ownerSigner).setPauseIntentValidityPeriodBlocks(pauseIntentValidityPeriodBlocks);

    const expiredBlockNumber = await time.latestBlock();
    await mine(Number(pauseIntentValidityPeriodBlocks) + 1);

    await expect(
      dsm.connect(guardianSigner).pauseDeposits(expiredBlockNumber, {
        r: ZeroHash,
        vs: ZeroHash,
      }),
    ).to.be.revertedWithCustomError(dsm, "PauseIntentExpired");
  });

  it("Should revert when stranger tries to pause deposits without valid guardian signature", async () => {
    expect(await dsm.isDepositsPaused()).to.equal(false);

    // Try with empty signature
    await expect(
      dsm.connect(stranger).pauseDeposits(await time.latestBlock(), {
        r: ZeroHash,
        vs: ZeroHash,
      }),
    ).to.be.revertedWith("ECDSA: invalid signature");

    // Try with non-guardian signature
    const blockNumber = await time.latestBlock();
    const nonGuardianPrivateKey = "0x" + "1".repeat(64);
    const pauseMessage = new DSMPauseMessage(blockNumber);
    const sig = pauseMessage.sign(nonGuardianPrivateKey);

    await expect(dsm.connect(stranger).pauseDeposits(blockNumber, sig)).to.be.revertedWithCustomError(
      dsm,
      "InvalidSignature",
    );
  });
});
