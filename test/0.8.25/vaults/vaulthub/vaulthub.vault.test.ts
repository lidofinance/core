import { expect } from "chai";
import { ContractTransactionReceipt, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  ACL,
  LazyOracle__MockForVaultHub,
  Lido,
  LidoLocator,
  OperatorGrid__MockForVaultHub,
  PredepositGuarantee__HarnessForFactory,
  StakingVault__MockForVaultHub,
  VaultFactory__MockForVaultHub,
  VaultHub,
} from "typechain-types";

import { advanceChainTime, days, ether, getCurrentBlockTimestamp, impersonate } from "lib";
import { ONE_GWEI, TOTAL_BASIS_POINTS } from "lib/constants";
import { findEvents } from "lib/event";
import { ceilDiv } from "lib/protocol";

import { deployLidoDao, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot, VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

const SHARE_LIMIT = ether("10");
const RESERVE_RATIO_BP = 20_00n; // 20%
const FORCED_REBALANCE_THRESHOLD_BP = 18_00n; // 18%
const INFRA_FEE_BP = 5_00n;
const LIQUIDITY_FEE_BP = 4_00n;
const RESERVATION_FEE_BP = 1_00n;
const CONNECT_DEPOSIT = ether("1");

describe("VaultHub.sol:owner-functions", () => {
  let deployer: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let newOwner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;
  let accounting: HardhatEthersSigner;

  let vaultHub: VaultHub;
  let vaultFactory: VaultFactory__MockForVaultHub;
  let vault: StakingVault__MockForVaultHub;
  let lazyOracle: LazyOracle__MockForVaultHub;
  let lido: Lido;
  let locator: LidoLocator;
  let operatorGridMock: OperatorGrid__MockForVaultHub;
  let predepositGuarantee: PredepositGuarantee__HarnessForFactory;
  let acl: ACL;
  let vaultAddress: string;

  let originalState: string;

  async function createVault(factory: VaultFactory__MockForVaultHub, owner: HardhatEthersSigner) {
    const vaultCreationTx = (await factory
      .createVault(owner, owner, predepositGuarantee)
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const events = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = events[0];

    return ethers.getContractAt("StakingVault__MockForVaultHub", vaultCreatedEvent.args.vault, owner);
  }

  async function reportVault({
    targetVault,
    totalValue,
    inOutDelta,
    cumulativeLidoFees,
    liabilityShares,
    maxLiabilityShares,
    slashingReserve,
  }: {
    targetVault?: StakingVault__MockForVaultHub;
    totalValue?: bigint;
    inOutDelta?: bigint;
    liabilityShares?: bigint;
    cumulativeLidoFees?: bigint;
    maxLiabilityShares?: bigint;
    slashingReserve?: bigint;
  }) {
    targetVault = targetVault ?? vault;
    await lazyOracle.refreshReportTimestamp();
    const timestamp = await lazyOracle.latestReportTimestamp();

    totalValue = totalValue ?? (await vaultHub.totalValue(targetVault));
    const record = await vaultHub.vaultRecord(targetVault);
    const activeIndex = record.inOutDelta[0].refSlot >= record.inOutDelta[1].refSlot ? 0 : 1;
    inOutDelta = inOutDelta ?? record.inOutDelta[activeIndex].value;
    liabilityShares = liabilityShares ?? record.liabilityShares;
    cumulativeLidoFees = cumulativeLidoFees ?? record.cumulativeLidoFees;
    maxLiabilityShares = maxLiabilityShares ?? record.maxLiabilityShares;
    slashingReserve = slashingReserve ?? 0n;

    await lazyOracle.mock__report(
      vaultHub,
      targetVault,
      timestamp,
      totalValue,
      inOutDelta,
      cumulativeLidoFees,
      liabilityShares,
      maxLiabilityShares,
      slashingReserve,
    );
  }

  before(async () => {
    [deployer, vaultOwner, newOwner, stranger, recipient] = await ethers.getSigners();

    // Deploy dependencies
    const depositContract = await ethers.deployContract("DepositContract__MockForVaultHub");
    predepositGuarantee = await ethers.deployContract("PredepositGuarantee__HarnessForFactory", [
      "0x00000000", // GENESIS_FORK_VERSION
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      0,
    ]);

    // Deploy Lido
    ({ lido, acl } = await deployLidoDao({
      rootAccount: deployer,
      initialized: true,
      locatorConfig: { predepositGuarantee },
    }));

    locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), deployer);
    accounting = await impersonate(await locator.accounting(), ether("100.0"));

    // Setup ACL permissions
    await acl.createPermission(vaultOwner, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(vaultOwner, lido, await lido.STAKING_CONTROL_ROLE(), deployer);
    await lido.connect(vaultOwner).resume();
    await lido.connect(vaultOwner).setMaxExternalRatioBP(TOTAL_BASIS_POINTS);

    // Fund Lido
    await lido.connect(deployer).submit(deployer, { value: ether("1000") });

    // Deploy mocks
    lazyOracle = await ethers.deployContract("LazyOracle__MockForVaultHub");
    operatorGridMock = await ethers.deployContract("OperatorGrid__MockForVaultHub");
    await operatorGridMock.initialize(SHARE_LIMIT);

    // Deploy VaultHub
    const hashConsensus = await ethers.deployContract("HashConsensus__MockForVaultHub");
    const vaultHubImpl = await ethers.deployContract("VaultHub", [
      locator,
      lido,
      hashConsensus,
      VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP,
    ]);

    const proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);
    vaultHub = await ethers.getContractAt("VaultHub", proxy);
    await vaultHub.initialize(deployer);

    // Grant roles
    await vaultHub.grantRole(await vaultHub.VAULT_MASTER_ROLE(), vaultOwner);

    // Update locator
    await updateLidoLocatorImplementation(await locator.getAddress(), {
      vaultHub,
      operatorGrid: operatorGridMock,
      lazyOracle,
    });

    // Deploy vault factory
    const stakingVaultImpl = await ethers.deployContract("StakingVault__MockForVaultHub", [depositContract]);
    const beacon = await ethers.deployContract("UpgradeableBeacon", [stakingVaultImpl, deployer]);
    vaultFactory = await ethers.deployContract("VaultFactory__MockForVaultHub", [beacon]);

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultFactory });

    // Setup vault
    vault = await createVault(vaultFactory, vaultOwner);
    vaultAddress = await vault.getAddress();

    // Connect vault
    await vault.connect(vaultOwner).fund({ value: CONNECT_DEPOSIT });
    await operatorGridMock.changeVaultTierParams(vault, {
      shareLimit: SHARE_LIMIT,
      reserveRatioBP: RESERVE_RATIO_BP,
      forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
      infraFeeBP: INFRA_FEE_BP,
      liquidityFeeBP: LIQUIDITY_FEE_BP,
      reservationFeeBP: RESERVATION_FEE_BP,
    });
    await vault.connect(vaultOwner).transferOwnership(vaultHub);
    await vaultHub.connect(vaultOwner).connectVault(vaultAddress);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  describe("fund", () => {
    it("reverts when paused", async () => {
      await vaultHub.connect(deployer).grantRole(await vaultHub.PAUSE_ROLE(), vaultOwner);
      await vaultHub.connect(vaultOwner).pauseFor(1000n);

      await expect(
        vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("1") }),
      ).to.be.revertedWithCustomError(vaultHub, "ResumedExpected");
    });

    it("reverts when vault is zero address", async () => {
      await expect(vaultHub.connect(vaultOwner).fund(ZeroAddress, { value: ether("1") })).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroAddress",
      );
    });

    it("reverts when vault is not connected", async () => {
      const unconnectedVault = await createVault(vaultFactory, vaultOwner);

      await expect(vaultHub.connect(vaultOwner).fund(unconnectedVault, { value: ether("1") }))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(unconnectedVault);
    });

    it("reverts when called by non-owner", async () => {
      await expect(vaultHub.connect(stranger).fund(vaultAddress, { value: ether("1") })).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });

    it("funds the vault successfully", async () => {
      const fundAmount = ether("5");
      const balanceBefore = await ethers.provider.getBalance(vaultAddress);

      await expect(vaultHub.connect(vaultOwner).fund(vaultAddress, { value: fundAmount }))
        .to.emit(vaultHub, "VaultInOutDeltaUpdated")
        .withArgs(vaultAddress, CONNECT_DEPOSIT + fundAmount)
        .and.to.emit(vault, "Mock__Funded");

      const balanceAfter = await ethers.provider.getBalance(vaultAddress);
      expect(balanceAfter - balanceBefore).to.equal(fundAmount);
    });

    it("updates inOutDelta correctly", async () => {
      const fundAmount = ether("3");
      const recordBefore = await vaultHub.vaultRecord(vaultAddress);
      const activeIndex = recordBefore.inOutDelta[0].refSlot >= recordBefore.inOutDelta[1].refSlot ? 0 : 1;
      const inOutDeltaBefore = recordBefore.inOutDelta[activeIndex].value;

      await vaultHub.connect(vaultOwner).fund(vaultAddress, { value: fundAmount });

      const recordAfter = await vaultHub.vaultRecord(vaultAddress);
      const activeIndexAfter = recordAfter.inOutDelta[0].refSlot >= recordAfter.inOutDelta[1].refSlot ? 0 : 1;
      const inOutDeltaAfter = recordAfter.inOutDelta[activeIndexAfter].value;

      expect(inOutDeltaAfter).to.equal(inOutDeltaBefore + fundAmount);
    });
  });

  describe("withdraw", () => {
    beforeEach(async () => {
      // Fund vault to enable withdrawals
      await vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("10") });
      await reportVault({ totalValue: ether("11") }); // CONNECT_DEPOSIT + 10 ETH
    });

    it("reverts when paused", async () => {
      await vaultHub.connect(deployer).grantRole(await vaultHub.PAUSE_ROLE(), vaultOwner);
      await vaultHub.connect(vaultOwner).pauseFor(1000n);

      await expect(
        vaultHub.connect(vaultOwner).withdraw(vaultAddress, recipient, ether("1")),
      ).to.be.revertedWithCustomError(vaultHub, "ResumedExpected");
    });

    it("reverts when called by non-owner", async () => {
      await expect(
        vaultHub.connect(stranger).withdraw(vaultAddress, recipient, ether("1")),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("reverts when report is stale", async () => {
      await advanceChainTime(days(3n));

      await expect(vaultHub.connect(vaultOwner).withdraw(vaultAddress, recipient, ether("1")))
        .to.be.revertedWithCustomError(vaultHub, "VaultReportStale")
        .withArgs(vaultAddress);
    });

    it("reverts when withdrawing more than withdrawable", async () => {
      const withdrawable = await vaultHub.withdrawableValue(vaultAddress);

      await expect(vaultHub.connect(vaultOwner).withdraw(vaultAddress, recipient, withdrawable + 1n))
        .to.be.revertedWithCustomError(vaultHub, "AmountExceedsWithdrawableValue")
        .withArgs(vaultAddress, withdrawable, withdrawable + 1n);
    });

    it("withdraws successfully", async () => {
      const withdrawAmount = ether("5");
      const vaultBalanceBefore = await ethers.provider.getBalance(vaultAddress);

      await expect(vaultHub.connect(vaultOwner).withdraw(vaultAddress, recipient, withdrawAmount))
        .to.emit(vaultHub, "VaultInOutDeltaUpdated")
        .and.to.emit(vault, "Mock__Withdrawn")
        .withArgs(recipient, withdrawAmount);

      const vaultBalanceAfter = await ethers.provider.getBalance(vaultAddress);
      // The StakingVault mock now actually transfers ETH
      expect(vaultBalanceBefore - vaultBalanceAfter).to.equal(withdrawAmount);
    });

    it("respects locked amount", async () => {
      // Mint shares to lock some ether
      await vaultHub.connect(vaultOwner).mintShares(vaultAddress, vaultOwner, ether("4"));
      await reportVault({});

      const withdrawable = await vaultHub.withdrawableValue(vaultAddress);
      const locked = await vaultHub.locked(vaultAddress);
      const totalValue = await vaultHub.totalValue(vaultAddress);

      expect(withdrawable).to.be.lessThanOrEqual(totalValue - locked);

      // Should succeed for withdrawable amount
      await expect(vaultHub.connect(vaultOwner).withdraw(vaultAddress, recipient, withdrawable)).to.not.be.reverted;

      // Should fail for more than withdrawable
      if (withdrawable > 0) {
        await expect(vaultHub.connect(vaultOwner).withdraw(vaultAddress, recipient, 1n)).to.be.revertedWithCustomError(
          vaultHub,
          "AmountExceedsWithdrawableValue",
        );
      }
    });
  });

  describe("mintShares", () => {
    beforeEach(async () => {
      // Fund vault to enable minting
      await vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("10") });
      await reportVault({ totalValue: ether("11") });
    });

    it("reverts when paused", async () => {
      await vaultHub.connect(deployer).grantRole(await vaultHub.PAUSE_ROLE(), vaultOwner);
      await vaultHub.connect(vaultOwner).pauseFor(1000n);

      await expect(
        vaultHub.connect(vaultOwner).mintShares(vaultAddress, recipient, ether("1")),
      ).to.be.revertedWithCustomError(vaultHub, "ResumedExpected");
    });

    it("reverts when recipient is zero address", async () => {
      await expect(
        vaultHub.connect(vaultOwner).mintShares(vaultAddress, ZeroAddress, ether("1")),
      ).to.be.revertedWithCustomError(vaultHub, "ZeroAddress");
    });

    it("reverts when amount is zero", async () => {
      await expect(vaultHub.connect(vaultOwner).mintShares(vaultAddress, recipient, 0n)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });

    it("reverts when called by non-owner", async () => {
      await expect(
        vaultHub.connect(stranger).mintShares(vaultAddress, recipient, ether("1")),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("reverts when report is stale", async () => {
      await advanceChainTime(days(3n));

      await expect(vaultHub.connect(vaultOwner).mintShares(vaultAddress, recipient, ether("1")))
        .to.be.revertedWithCustomError(vaultHub, "VaultReportStale")
        .withArgs(vaultAddress);
    });

    it("reverts when exceeding share limit", async () => {
      const shareLimit = (await vaultHub.vaultConnection(vaultAddress)).shareLimit;

      await expect(vaultHub.connect(vaultOwner).mintShares(vaultAddress, recipient, shareLimit + 1n))
        .to.be.revertedWithCustomError(vaultHub, "ShareLimitExceeded")
        .withArgs(vaultAddress, shareLimit + 1n, shareLimit);
    });

    it("reverts when insufficient value to mint", async () => {
      const maxMintable = (ether("11") * (TOTAL_BASIS_POINTS - RESERVE_RATIO_BP)) / TOTAL_BASIS_POINTS;

      await expect(
        vaultHub.connect(vaultOwner).mintShares(vaultAddress, recipient, maxMintable + 1n),
      ).to.be.revertedWithCustomError(vaultHub, "InsufficientValue");
    });

    it("mints shares successfully", async () => {
      const mintAmount = ether("5");
      const balanceBefore = await lido.balanceOf(recipient);

      const tx = await vaultHub.connect(vaultOwner).mintShares(vaultAddress, recipient, mintAmount);
      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error("MintedSharesOnVault event not found");
      }

      const event = findEvents(receipt, "MintedSharesOnVault")[0];

      await expect(tx)
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(vaultAddress, mintAmount, event.args.lockedAmount);

      const balanceAfter = await lido.balanceOf(recipient);
      expect(balanceAfter - balanceBefore).to.equal(mintAmount);
    });

    it("updates locked amount correctly", async () => {
      const mintAmount = ether("5");

      await vaultHub.connect(vaultOwner).mintShares(vaultAddress, recipient, mintAmount);

      const lockedAfter = await vaultHub.locked(vaultAddress);
      const expectedLocked = (mintAmount * TOTAL_BASIS_POINTS) / (TOTAL_BASIS_POINTS - RESERVE_RATIO_BP);

      expect(lockedAfter).to.be.greaterThanOrEqual(expectedLocked);
    });
  });

  describe("burnShares", () => {
    beforeEach(async () => {
      // Setup: fund vault and mint shares
      await vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("10") });
      await reportVault({ totalValue: ether("11") });
      await vaultHub.connect(vaultOwner).mintShares(vaultAddress, vaultOwner, ether("5"));
      await reportVault({});
    });

    it("reverts when paused", async () => {
      await vaultHub.connect(deployer).grantRole(await vaultHub.PAUSE_ROLE(), vaultOwner);
      await vaultHub.connect(vaultOwner).pauseFor(1000n);

      await expect(vaultHub.connect(vaultOwner).burnShares(vaultAddress, ether("1"))).to.be.revertedWithCustomError(
        vaultHub,
        "ResumedExpected",
      );
    });

    it("reverts when amount is zero", async () => {
      await expect(vaultHub.connect(vaultOwner).burnShares(vaultAddress, 0n)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });

    it("reverts when called by non-owner", async () => {
      await expect(vaultHub.connect(stranger).burnShares(vaultAddress, ether("1"))).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });

    it("reverts when burning more shares than minted", async () => {
      const liabilityShares = await vaultHub.liabilityShares(vaultAddress);

      await expect(vaultHub.connect(vaultOwner).burnShares(vaultAddress, liabilityShares + 1n))
        .to.be.revertedWithCustomError(vaultHub, "InsufficientSharesToBurn")
        .withArgs(vaultAddress, liabilityShares);
    });

    it("burns shares successfully from VaultHub balance", async () => {
      // Transfer shares to VaultHub
      await lido.connect(vaultOwner).transfer(vaultHub, ether("2"));

      const liabilitySharesBefore = await vaultHub.liabilityShares(vaultAddress);

      await expect(vaultHub.connect(vaultOwner).burnShares(vaultAddress, ether("2")))
        .to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(vaultAddress, ether("2"));

      const liabilitySharesAfter = await vaultHub.liabilityShares(vaultAddress);
      expect(liabilitySharesBefore - liabilitySharesAfter).to.equal(ether("2"));
    });
  });

  describe("transferAndBurnShares", () => {
    let burnAmount: bigint;

    beforeEach(async () => {
      // Setup: fund vault and mint shares
      await vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("10") });
      await reportVault({ totalValue: ether("11") });
      await vaultHub.connect(vaultOwner).mintShares(vaultAddress, vaultOwner, ether("5"));
      await reportVault({});

      burnAmount = ether("2");

      // Approve VaultHub to transfer shares
      await lido.connect(vaultOwner).approve(vaultHub, burnAmount);
    });

    it("transfers and burns shares successfully", async () => {
      const liabilitySharesBefore = await vaultHub.liabilityShares(vaultAddress);
      const ownerBalanceBefore = await lido.balanceOf(vaultOwner);

      await expect(vaultHub.connect(vaultOwner).transferAndBurnShares(vaultAddress, burnAmount))
        .to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(vaultAddress, burnAmount);

      const liabilitySharesAfter = await vaultHub.liabilityShares(vaultAddress);
      const ownerBalanceAfter = await lido.balanceOf(vaultOwner);

      expect(liabilitySharesBefore - liabilitySharesAfter).to.equal(burnAmount);
      expect(ownerBalanceBefore - ownerBalanceAfter).to.equal(burnAmount);
    });
  });

  describe("rebalance", () => {
    beforeEach(async () => {
      // Setup: create unhealthy vault scenario
      await vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("10") });
      await reportVault({ totalValue: ether("11") });
      // Mint more shares to make it closer to unhealthy
      await vaultHub.connect(vaultOwner).mintShares(vaultAddress, vaultOwner, ether("8.5"));
      // Report lower value to make vault unhealthy
      await reportVault({ totalValue: ether("10.5"), liabilityShares: ether("8.5") });
    });

    it("reverts when report is stale", async () => {
      await advanceChainTime(days(3n));

      await expect(vaultHub.connect(vaultOwner).rebalance(vaultAddress, ether("1"))).to.be.revertedWithCustomError(
        vaultHub,
        "VaultReportStale",
      );
    });

    it("reverts when paused", async () => {
      await vaultHub.connect(deployer).grantRole(await vaultHub.PAUSE_ROLE(), vaultOwner);
      await vaultHub.connect(vaultOwner).pauseFor(1000n);

      await expect(vaultHub.connect(vaultOwner).rebalance(vaultAddress, ether("1"))).to.be.revertedWithCustomError(
        vaultHub,
        "ResumedExpected",
      );
    });

    it("reverts when amount is zero", async () => {
      await expect(vaultHub.connect(vaultOwner).rebalance(vaultAddress, 0n)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });

    it("reverts when called by non-owner", async () => {
      await expect(vaultHub.connect(stranger).rebalance(vaultAddress, ether("1"))).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });

    it("rebalances vault successfully", async () => {
      const rebalanceAmount = ether("0.1");
      const liabilitySharesBefore = await vaultHub.liabilityShares(vaultAddress);

      await expect(vaultHub.connect(vaultOwner).rebalance(vaultAddress, rebalanceAmount))
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(vaultAddress, rebalanceAmount, rebalanceAmount); // 1:1 share rate

      const liabilitySharesAfter = await vaultHub.liabilityShares(vaultAddress);
      expect(liabilitySharesBefore - liabilitySharesAfter).to.equal(rebalanceAmount);
    });

    it("rebalance with share rate < 1", async () => {
      const totalPooledEther = await lido.getTotalPooledEther();
      const totalShares = await lido.getTotalShares();

      if (totalPooledEther >= totalShares) {
        const sharesToMint = totalPooledEther - totalShares + ether("1");
        await lido.connect(accounting).mintShares(stranger, sharesToMint);
      }

      const externalSharesBeforeRebalance = await lido.getExternalShares();
      const liabilitySharesBeforeRebalance = await vaultHub.liabilityShares(vaultAddress);
      expect(externalSharesBeforeRebalance).to.equal(liabilitySharesBeforeRebalance);

      const totalPooledEtherAfterMint = await lido.getTotalPooledEther();
      const totalSharesAfterMint = await lido.getTotalShares();
      expect(totalPooledEtherAfterMint).to.lessThan(totalSharesAfterMint);

      const rebalanceAmountShares = ether("0.1");
      const eth = (rebalanceAmountShares * totalPooledEtherAfterMint - 1n) / totalSharesAfterMint + 1n; // roundUp
      await expect(vaultHub.connect(vaultOwner).rebalance(vaultAddress, rebalanceAmountShares))
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(vaultAddress, rebalanceAmountShares, eth);

      const externalSharesAfterRebalance = await lido.getExternalShares();
      const liabilitySharesAfterRebalance = await vaultHub.liabilityShares(vaultAddress);

      expect(externalSharesAfterRebalance).to.equal(liabilitySharesAfterRebalance);
    });
  });

  describe("pauseBeaconChainDeposits", () => {
    it("pauses beacon chain deposits", async () => {
      expect(await vault.beaconChainDepositsPaused()).to.be.false;

      await expect(vaultHub.connect(vaultOwner).pauseBeaconChainDeposits(vaultAddress))
        .to.emit(vaultHub, "BeaconChainDepositsPauseIntentSet")
        .withArgs(vaultAddress, true)
        .and.to.emit(vault, "Mock__BeaconChainDepositsPaused");

      expect(await vault.beaconChainDepositsPaused()).to.be.true;
    });

    it("reverts when already paused", async () => {
      await vaultHub.connect(vaultOwner).pauseBeaconChainDeposits(vaultAddress);

      await expect(vaultHub.connect(vaultOwner).pauseBeaconChainDeposits(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "PauseIntentAlreadySet",
      );
    });

    it("reverts when called by non-owner", async () => {
      await expect(vaultHub.connect(stranger).pauseBeaconChainDeposits(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });
  });

  describe("resumeBeaconChainDeposits", () => {
    beforeEach(async () => {
      await vaultHub.connect(vaultOwner).pauseBeaconChainDeposits(vaultAddress);
      await reportVault({ totalValue: ether("1") });
    });

    it("reverts when called by non-owner", async () => {
      await expect(vaultHub.connect(stranger).resumeBeaconChainDeposits(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });

    it("reverts when report is stale", async () => {
      await advanceChainTime(days(3n));

      await expect(vaultHub.connect(vaultOwner).resumeBeaconChainDeposits(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "VaultReportStale",
      );
    });

    it("reverts when already resumed", async () => {
      await vaultHub.connect(vaultOwner).resumeBeaconChainDeposits(vaultAddress);

      await expect(vaultHub.connect(vaultOwner).resumeBeaconChainDeposits(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "PauseIntentAlreadyUnset",
      );
    });

    it("resumes beacon chain deposits", async () => {
      expect(await vault.beaconChainDepositsPaused()).to.be.true;

      await expect(vaultHub.connect(vaultOwner).resumeBeaconChainDeposits(vaultAddress))
        .to.emit(vaultHub, "BeaconChainDepositsPauseIntentSet")
        .withArgs(vaultAddress, false)
        .to.emit(vault, "Mock__BeaconChainDepositsResumed");

      expect(await vault.beaconChainDepositsPaused()).to.be.false;
    });

    it("only resets the manual pause flag when vault is unhealthy", async () => {
      // Make vault unhealthy
      await vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("10") });
      await reportVault({ totalValue: ether("11") });
      await vaultHub.connect(vaultOwner).mintShares(vaultAddress, vaultOwner, ether("8.5"));
      // Report lower value to make vault unhealthy: 8.5 shares vs 10 total value
      // With forced rebalance threshold of 18%, vault is unhealthy when shares > 8.2 ether
      await reportVault({ totalValue: ether("10"), liabilityShares: ether("8.5") });

      await expect(vaultHub.connect(vaultOwner).resumeBeaconChainDeposits(vaultAddress))
        .to.emit(vaultHub, "BeaconChainDepositsPauseIntentSet")
        .withArgs(vaultAddress, false)
        .and.not.to.emit(vault, "Mock__BeaconChainDepositsResumed");

      // Check that the manual pause flag is reset
      const connection = await vaultHub.vaultConnection(vaultAddress);
      expect(connection.beaconChainDepositsPauseIntent).to.be.false;

      expect(await vault.beaconChainDepositsPaused()).to.be.true;

      // Check that the deposits are automatically resumed after vault becomes healthy
      await reportVault({ totalValue: ether("11"), liabilityShares: ether("8.5") });

      expect(await vault.beaconChainDepositsPaused()).to.be.false;
    });

    it("only resets the manual pause flag when vault has redemption obligations", async () => {
      await vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("10") });
      await vaultHub.connect(vaultOwner).mintShares(vaultAddress, vaultOwner, ether("8.5"));

      await vaultHub.connect(deployer).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), vaultOwner);
      await vaultHub.connect(vaultOwner).setLiabilitySharesTarget(vaultAddress, 0n);

      await expect(vaultHub.connect(vaultOwner).resumeBeaconChainDeposits(vaultAddress))
        .to.emit(vaultHub, "BeaconChainDepositsPauseIntentSet")
        .withArgs(vaultAddress, false)
        .and.not.to.emit(vault, "Mock__BeaconChainDepositsResumed");

      // Check that the manual pause flag is reset
      const connection = await vaultHub.vaultConnection(vaultAddress);
      expect(connection.beaconChainDepositsPauseIntent).to.be.false;

      expect(await vault.beaconChainDepositsPaused()).to.be.true;

      // Check that the deposits are automatically resumed after vault becomes healthy
      await vaultHub.connect(vaultOwner).forceRebalance(vaultAddress);

      expect(await vault.beaconChainDepositsPaused()).to.be.false;
    });

    it("only resets the manual pause flag when vault has unsettled lido fees equal to minimum beacon deposit", async () => {
      await reportVault({ totalValue: ether("10"), cumulativeLidoFees: ether("1") });

      await expect(vaultHub.connect(vaultOwner).resumeBeaconChainDeposits(vaultAddress))
        .to.emit(vaultHub, "BeaconChainDepositsPauseIntentSet")
        .withArgs(vaultAddress, false)
        .and.not.to.emit(vault, "Mock__BeaconChainDepositsResumed");

      // Check that the manual pause flag is reset
      const connection = await vaultHub.vaultConnection(vaultAddress);
      expect(connection.beaconChainDepositsPauseIntent).to.be.false;

      expect(await vault.beaconChainDepositsPaused()).to.be.true;

      // Check that the deposits are automatically resumed after vault becomes healthy
      await vaultHub.connect(vaultOwner).settleLidoFees(vaultAddress);

      expect(await vault.beaconChainDepositsPaused()).to.be.false;
    });
  });

  describe("requestValidatorExit", () => {
    const SAMPLE_PUBKEY = "0x" + "01".repeat(48);

    it("requests validator exit", async () => {
      // The function just calls through to the vault
      await expect(vaultHub.connect(vaultOwner).requestValidatorExit(vaultAddress, SAMPLE_PUBKEY))
        .to.emit(vault, "Mock__ValidatorExitRequested")
        .withArgs(SAMPLE_PUBKEY);
    });

    it("reverts when called by non-owner", async () => {
      await expect(
        vaultHub.connect(stranger).requestValidatorExit(vaultAddress, SAMPLE_PUBKEY),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("handles multiple pubkeys", async () => {
      const pubkeys = "0x" + "01".repeat(48) + "02".repeat(48);

      await expect(vaultHub.connect(vaultOwner).requestValidatorExit(vaultAddress, pubkeys))
        .to.emit(vault, "Mock__ValidatorExitRequested")
        .withArgs(pubkeys);
    });
  });

  describe("triggerValidatorWithdrawals", () => {
    const SAMPLE_PUBKEY = "0x" + "01".repeat(48);
    const FEE = ether("0.01");
    const MAX_UINT256 = (1n << 256n) - 1n;
    const MAX_UINT64 = (1n << 64n) - 1n;

    function generateTriggerValidatorWithdrawalsData(pubkey: string, amount: bigint, refundTo: HardhatEthersSigner) {
      const iface = new ethers.Interface(["function triggerValidatorWithdrawals(address,bytes,uint64[],address)"]);
      const selector = iface.getFunction("triggerValidatorWithdrawals")?.selector;
      const payloadArgs = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "bytes", "uint256[]", "address"],
        [vaultAddress, pubkey, [amount], refundTo.address],
      );
      return selector + payloadArgs.slice(2);
    }

    it("triggers validator withdrawal", async () => {
      await expect(
        vaultHub.connect(vaultOwner).triggerValidatorWithdrawals(
          vaultAddress,
          SAMPLE_PUBKEY,
          [0n], // Full withdrawal
          recipient,
          { value: FEE },
        ),
      )
        .to.emit(vault, "ValidatorWithdrawalsTriggered")
        .withArgs(SAMPLE_PUBKEY, [0n], recipient);
    });

    it("reverts when called by non-owner", async () => {
      await expect(
        vaultHub
          .connect(stranger)
          .triggerValidatorWithdrawals(vaultAddress, SAMPLE_PUBKEY, [0n], recipient, { value: FEE }),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("reverts for partial withdrawals when vault is in bad debt", async () => {
      // Make vault in bad debt
      await vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("10") });
      await reportVault({ totalValue: ether("11") });
      const totalValue = ether("8.5");
      const liabilityShares = ether("8.5") + 1n;
      await vaultHub.connect(vaultOwner).mintShares(vaultAddress, vaultOwner, liabilityShares);
      await reportVault({ totalValue, liabilityShares });

      await expect(
        vaultHub
          .connect(vaultOwner)
          .triggerValidatorWithdrawals(vaultAddress, SAMPLE_PUBKEY, [1n], recipient, { value: FEE }),
      ).to.be.revertedWithCustomError(vaultHub, "PartialValidatorWithdrawalNotAllowed");
    });

    it("reverts for uint64 overflow attack", async function () {
      await reportVault({ totalValue: ether("10") });

      const OVERFLOW256 = MAX_UINT256 - MAX_UINT64 + 1n;

      const data = generateTriggerValidatorWithdrawalsData(SAMPLE_PUBKEY, OVERFLOW256, recipient);
      await expect(vaultOwner.sendTransaction({ to: vaultHub, data, value: ether("1") })).to.be.reverted;
    });

    it("works for uint64 max value", async function () {
      await reportVault({ totalValue: ether("10") });

      const data = generateTriggerValidatorWithdrawalsData(SAMPLE_PUBKEY, MAX_UINT64, recipient);
      await expect(vaultOwner.sendTransaction({ to: vaultHub, data, value: ether("1") }))
        .to.emit(vault, "ValidatorWithdrawalsTriggered")
        .withArgs(SAMPLE_PUBKEY, [MAX_UINT64], recipient);
    });

    it("reverts for partial withdrawals when vault is unhealthy and partial withdrawal is not enough to cover rebalance shortfall", async () => {
      // Make vault unhealthy
      await vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("10") });
      await reportVault({ totalValue: ether("11") });
      await vaultHub.connect(vaultOwner).mintShares(vaultAddress, vaultOwner, ether("8.5"));
      await reportVault({ totalValue: ether("10"), liabilityShares: ether("8.5") });

      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.be.false;

      await setBalance(vaultAddress, 0n); // simulate vault total value is on Beacon Chain

      const healthShortfallShares = await vaultHub.healthShortfallShares(vaultAddress);
      const rebalanceShortfallValue = await lido.getPooledEthBySharesRoundUp(healthShortfallShares);
      const amount = rebalanceShortfallValue / ONE_GWEI - 1n; // 1 gwei less than rebalance shortfall

      await expect(
        vaultHub
          .connect(vaultOwner)
          .triggerValidatorWithdrawals(vaultAddress, SAMPLE_PUBKEY, [amount], recipient, { value: FEE }),
      ).to.be.revertedWithCustomError(vaultHub, "PartialValidatorWithdrawalNotAllowed");
    });

    it("allows partial withdrawals when vault is unhealthy and has enough balance to cover rebalance shortfall", async () => {
      // Make vault unhealthy
      await vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("10") });
      await reportVault({ totalValue: ether("11") });
      await vaultHub.connect(vaultOwner).mintShares(vaultAddress, vaultOwner, ether("8.5"));
      await reportVault({ totalValue: ether("10"), liabilityShares: ether("8.5") });

      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.be.false;
      await expect(
        vaultHub
          .connect(vaultOwner)
          .triggerValidatorWithdrawals(vaultAddress, SAMPLE_PUBKEY, [1n], recipient, { value: FEE }),
      ).to.not.be.reverted;
    });

    it("allows partial withdrawals when vault is unhealthy and requested amount is enough to cover rebalance shortfall", async () => {
      // Make vault unhealthy
      await vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("10") });
      await reportVault({ totalValue: ether("11") });
      await vaultHub.connect(vaultOwner).mintShares(vaultAddress, vaultOwner, ether("8.5"));
      await reportVault({ totalValue: ether("10"), liabilityShares: ether("8.5") });

      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.be.false;

      await setBalance(vaultAddress, 0n); // simulate vault total value is on Beacon Chain

      const healthShortfallShares = await vaultHub.healthShortfallShares(vaultAddress);
      const rebalanceShortfallValue = await lido.getPooledEthBySharesRoundUp(healthShortfallShares);
      const amount = ceilDiv(rebalanceShortfallValue, ONE_GWEI);

      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.be.false;
      await expect(
        vaultHub
          .connect(vaultOwner)
          .triggerValidatorWithdrawals(vaultAddress, SAMPLE_PUBKEY, [amount], recipient, { value: FEE }),
      ).to.not.be.reverted;
    });

    it("allows full withdrawals when vault is unhealthy", async () => {
      // Make vault unhealthy
      await vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("10") });
      await reportVault({ totalValue: ether("11") });
      await vaultHub.connect(vaultOwner).mintShares(vaultAddress, vaultOwner, ether("8.5"));
      // Report lower value to make vault unhealthy: 8.5 shares vs 10 total value > 82% threshold
      await reportVault({ totalValue: ether("10"), liabilityShares: ether("8.5") });

      // Full withdrawal (amount = 0) should be allowed
      await expect(
        vaultHub
          .connect(vaultOwner)
          .triggerValidatorWithdrawals(vaultAddress, SAMPLE_PUBKEY, [0n], recipient, { value: FEE }),
      ).to.not.be.reverted;
    });

    it("reverts when on partial withdrawal with stale report", async () => {
      await expect(
        vaultHub
          .connect(vaultOwner)
          .triggerValidatorWithdrawals(vaultAddress, SAMPLE_PUBKEY, [1n], recipient, { value: FEE }),
      ).to.be.revertedWithCustomError(vaultHub, "VaultReportStale");
    });
  });

  describe("transferVaultOwnership", () => {
    it("transfers vault ownership", async () => {
      await expect(vaultHub.connect(vaultOwner).transferVaultOwnership(vaultAddress, newOwner))
        .to.emit(vaultHub, "VaultOwnershipTransferred")
        .withArgs(vaultAddress, newOwner, vaultOwner);

      const connection = await vaultHub.vaultConnection(vaultAddress);
      expect(connection.owner).to.equal(newOwner);
    });

    it("reverts when new owner is zero address", async () => {
      await expect(
        vaultHub.connect(vaultOwner).transferVaultOwnership(vaultAddress, ZeroAddress),
      ).to.be.revertedWithCustomError(vaultHub, "ZeroAddress");
    });

    it("reverts when called by non-owner", async () => {
      await expect(
        vaultHub.connect(stranger).transferVaultOwnership(vaultAddress, newOwner),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("new owner can operate the vault", async () => {
      await vaultHub.connect(vaultOwner).transferVaultOwnership(vaultAddress, newOwner);

      // Old owner should not be able to operate
      await expect(
        vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("1") }),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");

      // New owner should be able to operate
      await expect(vaultHub.connect(newOwner).fund(vaultAddress, { value: ether("1") })).to.not.be.reverted;
    });
  });

  describe("edge cases and invariants", () => {
    it("maintains correct totalValue after operations", async () => {
      const initialTotal = await vaultHub.totalValue(vaultAddress);

      // Fund
      const fundAmount = ether("5");
      await vaultHub.connect(vaultOwner).fund(vaultAddress, { value: fundAmount });
      expect(await vaultHub.totalValue(vaultAddress)).to.equal(initialTotal + fundAmount);

      // Withdraw
      await reportVault({});
      const withdrawAmount = ether("2");
      await vaultHub.connect(vaultOwner).withdraw(vaultAddress, recipient, withdrawAmount);
      expect(await vaultHub.totalValue(vaultAddress)).to.equal(initialTotal + fundAmount - withdrawAmount);
    });

    it("prevents minting when vault is disconnecting", async () => {
      await reportVault({});
      await vaultHub.connect(vaultOwner).voluntaryDisconnect(vaultAddress);

      await expect(vaultHub.connect(vaultOwner).mintShares(vaultAddress, recipient, ether("1")))
        .to.be.revertedWithCustomError(vaultHub, "VaultIsDisconnecting")
        .withArgs(vaultAddress);
    });

    it("allows operations after reconnecting", async () => {
      await reportVault({});

      // Disconnect
      await vaultHub.connect(vaultOwner).voluntaryDisconnect(vaultAddress);

      // Complete disconnect
      await lazyOracle.mock__report(vaultHub, vault, await getCurrentBlockTimestamp(), 0n, 0n, 0n, 0n, 0n, 0n);

      // Reconnect
      await vault.connect(vaultOwner).acceptOwnership();
      await vault.connect(vaultOwner).fund({ value: CONNECT_DEPOSIT });
      await vault.connect(vaultOwner).transferOwnership(vaultHub);
      await vaultHub.connect(vaultOwner).connectVault(vaultAddress);

      // Should be able to operate again
      await expect(vaultHub.connect(vaultOwner).fund(vaultAddress, { value: ether("1") })).to.not.be.reverted;
    });
  });
});
