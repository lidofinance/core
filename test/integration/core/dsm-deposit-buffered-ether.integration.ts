import { expect } from "chai";
import { Contract, Wallet } from "ethers";
import { ethers } from "hardhat";

import { mine } from "@nomicfoundation/hardhat-network-helpers";

import { DepositSecurityModule } from "typechain-types";

import { certainAddress, DSMAttestMessage, ether, findEventsWithInterfaces, impersonate } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { setGuardians } from "lib/protocol/helpers/dsm";
import { deployDelegationContract, DeployedDelegationContract } from "lib/protocol/helpers/edf";
import { ensureSubmitFitsStakeLimit, prepareStakingModuleForTestDeposit } from "lib/protocol/helpers/staking";

import { Snapshot } from "test/suite";

const DEPOSIT_CONTRACT_ABI = ["function get_deposit_root() view returns (bytes32)"];

describe("Integration: DSM buffered ether deposit", () => {
  const stakingModuleId = 1n;

  let ctx: ProtocolContext;
  let dsm: DepositSecurityModule;
  let depositContract: Contract;
  let suiteSnapshot: string;
  let testSnapshot: string;

  before(async function () {
    ctx = await getProtocolContext();
    suiteSnapshot = await Snapshot.take();

    if (ctx.isMainnet) this.skip();

    dsm = ctx.contracts.depositSecurityModule;
    depositContract = new ethers.Contract(await dsm.DEPOSIT_CONTRACT(), DEPOSIT_CONTRACT_ABI, ethers.provider);
    DSMAttestMessage.setMessagePrefix(await dsm.ATTEST_MESSAGE_PREFIX());
  });

  beforeEach(async () => (testSnapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(testSnapshot));
  after(async () => await Snapshot.restore(suiteSnapshot));

  it("Should deposit buffered ether with a quorum of EDF guardian signatures", async () => {
    const [delegationOwner, submitter] = await ethers.getSigners();
    const delegates = [Wallet.createRandom(), Wallet.createRandom()];
    const depositsCount = 1n;
    const depositValue = ether("32") * depositsCount;

    const guardians: DeployedDelegationContract[] = [];
    for (const delegate of delegates) {
      guardians.push(await deployDelegationContract(delegationOwner, delegate.address));
    }
    const guardianDelegates = guardians
      .map((guardian, index) => ({ ...guardian, delegate: delegates[index] }))
      .sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));

    await setGuardians(
      ctx,
      guardianDelegates.map(({ address }) => address),
      2n,
    );

    const { lido, stakingRouter, withdrawalQueue } = ctx.contracts;
    const submitValue = (await withdrawalQueue.unfinalizedStETH()) + depositValue;
    const ethHolder = await impersonate(certainAddress("dsm-deposit:eth-holder"), submitValue + ether("1"));

    await ensureSubmitFitsStakeLimit(ctx, submitValue);
    await lido.connect(ethHolder).submit(ethers.ZeroAddress, { value: submitValue });
    await prepareStakingModuleForTestDeposit(ctx, stakingModuleId, depositsCount);

    if (!(await dsm.isMinDepositDistancePassed(stakingModuleId))) {
      const distance = await stakingRouter.getStakingModuleMinDepositBlockDistance(stakingModuleId);
      await mine(Number(distance) + 1);
    }

    const latestBlock = await ethers.provider.getBlock("latest");
    if (!latestBlock?.hash) throw new Error("Latest block is unavailable");

    const depositRoot = await depositContract.get_deposit_root();
    const nonce = await stakingRouter.getStakingModuleNonce(stakingModuleId);
    const signingArgs = [latestBlock.number, latestBlock.hash, depositRoot, stakingModuleId, nonce] as const;
    const signatures = guardianDelegates.map(({ address, delegate }) =>
      new DSMAttestMessage(address, ...signingArgs).sign(delegate.privateKey),
    );

    const bufferedBefore = await lido.getBufferedEther();
    const depositedBefore = (await lido.getBalanceStats()).depositedSinceLastReport;
    const [moduleBefore] = await stakingRouter.getStakingModuleDigests([stakingModuleId]);

    const tx = await dsm.connect(submitter).depositBufferedEther(...signingArgs, signatures);
    const receipt = await tx.wait();
    if (!receipt) throw new Error("DSM deposit transaction has no receipt");

    const lastDepositBlockEvents = findEventsWithInterfaces(receipt, "LastDepositBlockChanged", [dsm.interface]);
    expect(lastDepositBlockEvents).to.have.length(1);
    expect(lastDepositBlockEvents[0].args.newValue).to.equal(receipt.blockNumber);

    const bufferedAfter = await lido.getBufferedEther();
    const depositedAfter = (await lido.getBalanceStats()).depositedSinceLastReport;
    const [moduleAfter] = await stakingRouter.getStakingModuleDigests([stakingModuleId]);

    expect(await dsm.getLastDepositBlock()).to.equal(receipt.blockNumber);
    expect(bufferedBefore - bufferedAfter).to.equal(depositValue);
    expect(depositedAfter - depositedBefore).to.equal(depositValue);
    expect(moduleAfter.summary.totalDepositedValidators - moduleBefore.summary.totalDepositedValidators).to.equal(
      depositsCount,
    );
    expect(await depositContract.get_deposit_root()).to.not.equal(depositRoot);
  });
});
