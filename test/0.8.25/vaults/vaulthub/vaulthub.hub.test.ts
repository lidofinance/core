import { expect } from "chai";
import { ContractTransactionReceipt, keccak256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ACL,
  DepositContract__MockForVaultHub,
  Lido,
  LidoLocator,
  PredepositGuarantee_HarnessForFactory,
  StakingVault__MockForVaultHub,
  VaultFactory__MockForVaultHub,
  VaultHub,
} from "typechain-types";

import { BigIntMath, ether, findEvents, getCurrentBlockTimestamp, impersonate, MAX_UINT256, randomAddress } from "lib";

import { deployLidoDao, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot, VAULTS_RELATIVE_SHARE_LIMIT_BP, ZERO_HASH } from "test/suite";

const ZERO_BYTES32 = "0x" + Buffer.from(ZERO_HASH).toString("hex");

const SHARE_LIMIT = ether("1");
const RESERVE_RATIO_BP = 10_00n;
const RESERVE_RATIO_THRESHOLD_BP = 8_00n;
const TREASURY_FEE_BP = 5_00n;

const TOTAL_BASIS_POINTS = 100_00n; // 100%
const CONNECT_DEPOSIT = ether("1");

describe("VaultHub.sol:hub", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let whale: HardhatEthersSigner;

  let predepositGuarantee: PredepositGuarantee_HarnessForFactory;
  let locator: LidoLocator;
  let vaultHub: VaultHub;
  let depositContract: DepositContract__MockForVaultHub;
  let vaultFactory: VaultFactory__MockForVaultHub;
  let lido: Lido;
  let acl: ACL;

  let codehash: string;

  let originalState: string;

  async function createVault(factory: VaultFactory__MockForVaultHub) {
    const vaultCreationTx = (await factory
      .createVault(user, user, predepositGuarantee)
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const events = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = events[0];

    return await ethers.getContractAt("StakingVault__MockForVaultHub", vaultCreatedEvent.args.vault, user);
  }

  async function createAndConnectVault(
    factory: VaultFactory__MockForVaultHub,
    options?: {
      shareLimit?: bigint;
      reserveRatioBP?: bigint;
      rebalanceThresholdBP?: bigint;
      treasuryFeeBP?: bigint;
    },
  ) {
    const vault = await createVault(factory);
    await vault.connect(user).fund({ value: CONNECT_DEPOSIT });
    await vault.connect(user).lock(CONNECT_DEPOSIT);

    await vaultHub
      .connect(user)
      .connectVault(
        await vault.getAddress(),
        options?.shareLimit ?? SHARE_LIMIT,
        options?.reserveRatioBP ?? RESERVE_RATIO_BP,
        options?.rebalanceThresholdBP ?? RESERVE_RATIO_THRESHOLD_BP,
        options?.treasuryFeeBP ?? TREASURY_FEE_BP,
      );

    const count = await vaultHub.vaultsCount();
    const valuations = [];
    const inOutDeltas = [];
    const locked = [];
    const treasuryFees = [];

    for (let i = 0; i < count; i++) {
      const vaultAddr = await vaultHub.vault(i);
      const vaultContract = await ethers.getContractAt("StakingVault__MockForVaultHub", vaultAddr);
      valuations.push(await vaultContract.valuation());
      inOutDeltas.push(await vaultContract.inOutDelta());
      locked.push(await vaultContract.locked());
      treasuryFees.push(0n);
    }

    // const accountingSigner = await impersonate(await locator.accounting(), ether("100"));
    // await vaultHub.connect(accountingSigner).updateVaults(valuations, inOutDeltas, locked, treasuryFees);

    return vault;
  }

  before(async () => {
    [deployer, user, stranger, whale] = await ethers.getSigners();

    predepositGuarantee = await ethers.deployContract("PredepositGuarantee_HarnessForFactory", [
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      0,
    ]);

    ({ lido, acl } = await deployLidoDao({
      rootAccount: deployer,
      initialized: true,
      locatorConfig: { predepositGuarantee },
    }));

    locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), deployer);

    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.STAKING_CONTROL_ROLE(), deployer);

    await lido.connect(user).resume();
    await lido.connect(user).setMaxExternalRatioBP(TOTAL_BASIS_POINTS);

    await lido.connect(whale).submit(deployer, { value: ether("1000.0") });

    depositContract = await ethers.deployContract("DepositContract__MockForVaultHub");

    const vaultHubImpl = await ethers.deployContract("VaultHub", [
      locator,
      await locator.lido(),
      VAULTS_RELATIVE_SHARE_LIMIT_BP,
    ]);

    const proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);

    const vaultHubAdmin = await ethers.getContractAt("VaultHub", proxy);
    await vaultHubAdmin.initialize(deployer);

    vaultHub = await ethers.getContractAt("VaultHub", proxy, user);
    await vaultHubAdmin.grantRole(await vaultHub.PAUSE_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.RESUME_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.VAULT_MASTER_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.VAULT_REGISTRY_ROLE(), user);

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultHub, predepositGuarantee });

    const stakingVaultImpl = await ethers.deployContract("StakingVault__MockForVaultHub", [vaultHub, depositContract]);

    vaultFactory = await ethers.deployContract("VaultFactory__MockForVaultHub", [await stakingVaultImpl.getAddress()]);
    const vault = await createVault(vaultFactory);

    codehash = keccak256(await ethers.provider.getCode(await vault.getAddress()));
    await vaultHub.connect(user).addVaultProxyCodehash(codehash);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constants", () => {
    it("returns the STETH address", async () => {
      expect(await vaultHub.LIDO()).to.equal(await lido.getAddress());
    });
  });

  context("initialState", () => {
    it("returns the initial state", async () => {
      expect(await vaultHub.vaultsCount()).to.equal(0);
    });
  });

  context("addVaultProxyCodehash", () => {
    it("reverts if called by non-VAULT_REGISTRY_ROLE", async () => {
      await expect(vaultHub.connect(stranger).addVaultProxyCodehash(ZERO_BYTES32))
        .to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await vaultHub.VAULT_REGISTRY_ROLE());
    });

    it("reverts if codehash is zero", async () => {
      await expect(vaultHub.connect(user).addVaultProxyCodehash(ZERO_BYTES32)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });

    it("reverts if codehash is already added", async () => {
      await expect(vaultHub.connect(user).addVaultProxyCodehash(codehash))
        .to.be.revertedWithCustomError(vaultHub, "AlreadyExists")
        .withArgs(codehash);
    });

    it("adds the codehash", async () => {
      const newCodehash = codehash.slice(0, -10) + "0000000000";
      await expect(vaultHub.addVaultProxyCodehash(newCodehash))
        .to.emit(vaultHub, "VaultProxyCodehashAdded")
        .withArgs(newCodehash);
    });
  });

  context("vaultsCount", () => {
    it("returns the number of connected vaults", async () => {
      expect(await vaultHub.vaultsCount()).to.equal(0);

      await createAndConnectVault(vaultFactory);

      expect(await vaultHub.vaultsCount()).to.equal(1);
    });
  });

  context("vault", () => {
    it("reverts if index is out of bounds", async () => {
      await expect(vaultHub.vault(100n)).to.be.reverted;
    });

    it("returns the vault", async () => {
      const vault = await createAndConnectVault(vaultFactory);
      const lastVaultId = (await vaultHub.vaultsCount()) - 1n;
      const lastVaultAddress = await vaultHub.vault(lastVaultId);

      expect(lastVaultAddress).to.equal(await vault.getAddress());
    });
  });

  context("vaultSocket(uint256)", () => {
    it("reverts if index is out of bounds", async () => {
      await expect(vaultHub["vaultSocket(uint256)"](100n)).to.be.reverted;
    });

    it("returns the vault socket by index", async () => {
      const vault = await createAndConnectVault(vaultFactory);
      const lastVaultId = (await vaultHub.vaultsCount()) - 1n;
      expect(lastVaultId).to.equal(0n);

      const lastVaultSocket = await vaultHub["vaultSocket(uint256)"](lastVaultId);

      expect(lastVaultSocket.vault).to.equal(await vault.getAddress());
      expect(lastVaultSocket.sharesMinted).to.equal(0n);
      expect(lastVaultSocket.shareLimit).to.equal(SHARE_LIMIT);
      expect(lastVaultSocket.reserveRatioBP).to.equal(RESERVE_RATIO_BP);
      expect(lastVaultSocket.rebalanceThresholdBP).to.equal(RESERVE_RATIO_THRESHOLD_BP);
      expect(lastVaultSocket.treasuryFeeBP).to.equal(TREASURY_FEE_BP);
      expect(lastVaultSocket.pendingDisconnect).to.equal(false);
    });
  });

  context("vaultSocket(address)", () => {
    it("returns empty vault socket data if vault was never connected", async () => {
      const address = await randomAddress();
      const vaultSocket = await vaultHub["vaultSocket(address)"](address);

      expect(vaultSocket.vault).to.equal(ZeroAddress);
      expect(vaultSocket.sharesMinted).to.equal(0n);
      expect(vaultSocket.shareLimit).to.equal(0n);
      expect(vaultSocket.reserveRatioBP).to.equal(0n);
      expect(vaultSocket.rebalanceThresholdBP).to.equal(0n);
      expect(vaultSocket.treasuryFeeBP).to.equal(0n);
      expect(vaultSocket.pendingDisconnect).to.equal(false);
    });

    it("returns the vault socket for a vault that was connected", async () => {
      const vault = await createAndConnectVault(vaultFactory);
      const vaultAddress = await vault.getAddress();
      const vaultSocket = await vaultHub["vaultSocket(address)"](vaultAddress);

      expect(vaultSocket.vault).to.equal(vaultAddress);
      expect(vaultSocket.sharesMinted).to.equal(0n);
      expect(vaultSocket.shareLimit).to.equal(SHARE_LIMIT);
      expect(vaultSocket.reserveRatioBP).to.equal(RESERVE_RATIO_BP);
      expect(vaultSocket.rebalanceThresholdBP).to.equal(RESERVE_RATIO_THRESHOLD_BP);
      expect(vaultSocket.treasuryFeeBP).to.equal(TREASURY_FEE_BP);
      expect(vaultSocket.pendingDisconnect).to.equal(false);
    });
  });

  context("batchVaultsInfo", () => {
    it("returns the vault info", async () => {
      const vault1 = await createAndConnectVault(vaultFactory);
      const vault2 = await createAndConnectVault(vaultFactory);
      const vaultAddress1 = await vault1.getAddress();
      const vaultAddress2 = await vault2.getAddress();
      const vaults = await vaultHub.batchVaultsInfo(0n, 2n);

      expect(vaults.length).to.equal(2);

      const vaultInfo = vaults[0];
      expect(vaultInfo.vault).to.equal(vaultAddress1);
      expect(vaultInfo.balance).to.equal(CONNECT_DEPOSIT);
      expect(vaultInfo.inOutDelta).to.equal(CONNECT_DEPOSIT);
      expect(vaultInfo.withdrawalCredentials).to.equal(ZERO_BYTES32);

      const vaultInfo2 = vaults[1];
      expect(vaultInfo2.vault).to.equal(vaultAddress2);
      expect(vaultInfo2.balance).to.equal(CONNECT_DEPOSIT);
      expect(vaultInfo2.inOutDelta).to.equal(CONNECT_DEPOSIT);
      expect(vaultInfo2.withdrawalCredentials).to.equal(ZERO_BYTES32);
    });

    it("returns the vault info with pagination", async () => {
      const vault1 = await createAndConnectVault(vaultFactory);
      const vault2 = await createAndConnectVault(vaultFactory);
      const vault3 = await createAndConnectVault(vaultFactory);
      const vaultAddress1 = await vault1.getAddress();
      const vaultAddress2 = await vault2.getAddress();
      const vaultAddress3 = await vault3.getAddress();

      const vaults1 = await vaultHub.batchVaultsInfo(0n, 1n);
      expect(vaults1.length).to.equal(1);
      expect(vaults1[0].vault).to.equal(vaultAddress1);

      const vaults2 = await vaultHub.batchVaultsInfo(1n, 1n);
      expect(vaults2.length).to.equal(1);
      expect(vaults2[0].vault).to.equal(vaultAddress2);

      const vaults3 = await vaultHub.batchVaultsInfo(0n, 4n);
      expect(vaults3.length).to.equal(3);
      expect(vaults3[0].vault).to.equal(vaultAddress1);
      expect(vaults3[1].vault).to.equal(vaultAddress2);
      expect(vaults3[2].vault).to.equal(vaultAddress3);

      const vaults4 = await vaultHub.batchVaultsInfo(1n, 3n);
      expect(vaults4.length).to.equal(2);
      expect(vaults4[0].vault).to.equal(vaultAddress2);
      expect(vaults4[1].vault).to.equal(vaultAddress3);

      const vaults5 = await vaultHub.batchVaultsInfo(0n, 0n);
      expect(vaults5.length).to.equal(0);

      const vaults6 = await vaultHub.batchVaultsInfo(3n, 1n);
      expect(vaults6.length).to.equal(0);
    });
  });

  context("isVaultHealthyAsOfLatestReport", () => {
    it("reverts if vault is not connected", async () => {
      await expect(vaultHub.isVaultHealthyAsOfLatestReport(randomAddress())).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
    });

    it("returns true if the vault has no shares minted", async () => {
      const vault = await createAndConnectVault(vaultFactory);
      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("1") });

      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(true);
    });

    // Looks like fuzzing but it's not [:}
    it("returns correct value for various parameters", async () => {
      const tbi = (n: number | bigint, min: number = 1) => BigInt(Math.floor(Math.random() * Number(n)) + min);

      for (let i = 0; i < 50; i++) {
        const snapshot = await Snapshot.take();
        const rebalanceThresholdBP = tbi(10000);
        const reserveRatioBP = BigIntMath.min(rebalanceThresholdBP + tbi(1000), TOTAL_BASIS_POINTS);

        const valuationEth = tbi(100);
        const valuation = ether(valuationEth.toString());

        const mintable = (valuation * (TOTAL_BASIS_POINTS - reserveRatioBP)) / TOTAL_BASIS_POINTS;

        const isSlashing = Math.random() < 0.5;
        const slashed = isSlashing ? ether(tbi(valuationEth).toString()) : 0n;
        const threshold = ((valuation - slashed) * (TOTAL_BASIS_POINTS - rebalanceThresholdBP)) / TOTAL_BASIS_POINTS;
        const expectedHealthy = threshold >= mintable;

        const vault = await createAndConnectVault(vaultFactory, {
          shareLimit: ether("100"), // just to bypass the share limit check
          reserveRatioBP: reserveRatioBP,
          rebalanceThresholdBP: rebalanceThresholdBP,
        });

        const vaultAddress = await vault.getAddress();

        await vault.fund({ value: valuation });

        if (mintable > 0n) {
          const sharesToMint = await lido.getSharesByPooledEth(mintable);
          await vault.lock(valuation);
          await vaultHub.connect(user).mintShares(vaultAddress, user, sharesToMint);
        }

        await vault.report(0n, valuation - slashed, valuation, BigIntMath.max(mintable, ether("1")));

        const actualHealthy = await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress);
        try {
          expect(actualHealthy).to.equal(expectedHealthy);
        } catch (error) {
          console.log(`Test failed with parameters:
            Rebalance Threshold: ${rebalanceThresholdBP}
            Reserve Ratio: ${reserveRatioBP}
            Valuation: ${valuation} ETH
            Minted: ${mintable} stETH
            Slashed: ${slashed} ETH
            Threshold: ${threshold} stETH
            Expected Healthy: ${expectedHealthy}
          `);
          throw error;
        }

        await Snapshot.restore(snapshot);
      }
    });

    it("returns correct value close to the threshold border cases", async () => {
      const vault = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        rebalanceThresholdBP: 50_00n, // 50%
      });

      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("1") });
      await vaultHub.connect(user).mintShares(vaultAddress, user, ether("0.25"));

      await vault.report(0n, ether("1"), ether("1"), ether("1")); // normal report
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(true);

      await vault.report(0n, ether("0.5") + 1n, ether("1"), ether("1")); // above the threshold
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(true);

      await vault.report(0n, ether("0.5"), ether("1"), ether("1")); // at the threshold
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(true);

      await vault.report(0n, ether("0.5") - 1n, ether("1"), ether("1")); // below the threshold
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(false);
    });

    it("returns correct value for different share rates", async () => {
      const vault = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        rebalanceThresholdBP: 50_00n, // 50%
      });

      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("1") });
      const mintingEth = ether("0.5");
      const sharesToMint = await lido.getSharesByPooledEth(mintingEth);
      await vaultHub.connect(user).mintShares(vaultAddress, user, sharesToMint);

      await vault.report(0n, ether("1"), ether("1"), ether("1")); // normal report
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(true); // valuation is enough

      // Burn some shares to make share rate fractional
      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("100"));
      await lido.connect(burner).burnShares(ether("100"));

      await vault.report(0n, ether("1"), ether("1"), ether("1")); // normal report
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(false); // old valuation is not enough

      const lockedEth = await lido.getPooledEthBySharesRoundUp(sharesToMint);
      // For 50% reserve ratio, we need valuation to be 2x of locked ETH to be healthy
      const report = lockedEth * 2n;

      await vault.report(0n, report - 1n, ether("1"), ether("1")); // below the threshold
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(false);

      await vault.report(0n, report, ether("1"), ether("1")); // at the threshold
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(true);

      await vault.report(0n, report + 1n, ether("1"), ether("1")); // above the threshold
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(true);
    });

    it("returns correct value for smallest possible reserve ratio", async () => {
      const vault = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 1n, // 0.01%
        rebalanceThresholdBP: 1n, // 0.01%
      });

      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("1") });

      const mintingEth = ether("0.9999"); // 99.99% of the valuation
      const sharesToMint = await lido.getSharesByPooledEth(mintingEth);
      await vaultHub.connect(user).mintShares(vaultAddress, user, sharesToMint);

      await vault.report(0n, ether("1"), ether("1"), ether("1")); // normal report
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(true); // valuation is enough

      // Burn some shares to make share rate fractional
      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("100"));
      await lido.connect(burner).burnShares(ether("100"));

      const lockedEth = await lido.getPooledEthBySharesRoundUp(sharesToMint);
      // if lockedEth is 99.99% of the valuation we need to report 100.00% of the valuation to be healthy
      const report = (lockedEth * 10000n) / 9999n;

      await vault.report(0n, report - 1n, ether("1"), ether("1")); // below the threshold
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(false);

      await vault.report(0n, report, ether("1"), ether("1")); // at the threshold
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(false); // XXX: rounding issue, should be true

      await vault.report(0n, report + 1n, ether("1"), ether("1")); // above the threshold
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(true);
    });

    it("returns correct value for minimal shares amounts", async () => {
      const vault = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"),
        reserveRatioBP: 50_00n, // 50%
        rebalanceThresholdBP: 50_00n, // 50%
      });

      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("1") });
      await vaultHub.connect(user).mintShares(vaultAddress, user, 1n);

      await vault.report(0n, ether("1"), ether("1"), ether("1"));
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(true);

      await vault.report(0n, 2n, ether("1"), ether("1")); // Minimal valuation to be healthy with 1 share (50% reserve ratio)
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(true);

      await vault.report(0n, 1n, ether("1"), ether("1")); // Below minimal required valuation
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(false);

      await lido.connect(user).transferShares(await locator.vaultHub(), 1n);
      await vaultHub.connect(user).burnShares(vaultAddress, 1n);

      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(true); // Should be healthy with no shares
    });
  });

  context("rebalanceShortfall", () => {
    it("does not revert when vault address is correct", async () => {
      const vault = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 10_00n, // 10%
        rebalanceThresholdBP: 10_00n, // 10%
      });

      const vaultAddress = await vault.getAddress();
      await expect(vaultHub.rebalanceShortfall(vaultAddress)).not.to.be.reverted;
    });

    it("reverts when vault address is ZeroAddress", async () => {
      const zeroAddress = ethers.ZeroAddress;
      await expect(vaultHub.rebalanceShortfall(zeroAddress))
        .to.be.revertedWithCustomError(vaultHub, "ZeroArgument")
        .withArgs("_vault");
    });

    it("returns 0 when stETH was not minted", async () => {
      const vault = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        rebalanceThresholdBP: 50_00n, // 50%
      });

      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("50") });
      await vault.lock(ether("5"));
      await vault.report(0n, ether("50"), ether("50"), ether("5"));

      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("1"));
      await lido.connect(burner).burnShares(ether("1"));

      expect(await vaultHub.rebalanceShortfall(vaultAddress)).to.equal(ether("0"));
    });

    it("returns 0 when minted small amount of stETH and vault is healthy", async () => {
      const vault = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 10_00n, // 10%
        rebalanceThresholdBP: 9_00n, // 9%
      });

      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("50") });
      const mintingEth = ether("1");
      const sharesToMint = await lido.getSharesByPooledEth(mintingEth);
      await vault.lock(ether("5"));
      await vaultHub.connect(user).mintShares(vaultAddress, user, sharesToMint);

      await vault.report(0n, ether("50"), ether("50"), ether("5"));

      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("1"));
      await lido.connect(burner).burnShares(ether("1"));

      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(true);
      expect(await vaultHub.rebalanceShortfall(vaultAddress)).to.equal(0n);
    });

    it("different cases when vault is healthy, unhealthy and minted > valuation", async () => {
      const vault = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        rebalanceThresholdBP: 50_00n, // 50%
      });

      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("1") });
      await vaultHub.connect(user).mintShares(vaultAddress, user, ether("0.25"));

      await vault.report(0n, ether("0.5"), ether("1"), ether("1")); // at the threshold
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(true);
      expect(await vaultHub.rebalanceShortfall(vaultAddress)).to.equal(0n);

      await vault.report(0n, ether("0.5") - 1n, ether("1"), ether("1")); // below the threshold
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(false);
      expect(await vaultHub.rebalanceShortfall(vaultAddress)).to.equal(1n);

      await vault.report(0n, ether("0.5") - ether("0.5"), ether("1"), ether("1")); // minted > valuation
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(vaultAddress)).to.equal(false);
      expect(await vaultHub.rebalanceShortfall(vaultAddress)).to.equal(MAX_UINT256);
    });

    it("returns correct value for rebalance vault", async () => {
      const vault = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        rebalanceThresholdBP: 50_00n, // 50%
      });

      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("50") });
      const mintingEth = ether("25");
      const sharesToMint = await lido.getSharesByPooledEth(mintingEth);
      await vault.lock(ether("50"));
      await vaultHub.connect(user).mintShares(vaultAddress, user, sharesToMint);

      const timestamp = await getCurrentBlockTimestamp();
      await vault.report(timestamp, ether("50"), ether("50"), ether("5"));

      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("1"));
      await lido.connect(burner).burnShares(ether("1"));

      expect(await vaultHub.rebalanceShortfall(vaultAddress)).to.equal(ether("50") / 1000n);
    });

    it("returns same value as calculated at another way", async () => {
      const vault = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        rebalanceThresholdBP: 50_00n, // 50%
      });

      const vaultAddress = await vault.getAddress();
      expect(await vaultHub.rebalanceShortfall(vaultAddress)).to.equal(0n);

      await vault.fund({ value: ether("50") });
      await vault.lock(ether("50"));
      const mintingEth = ether("25");
      const sharesToMint = await lido.getSharesByPooledEth(mintingEth);
      await vaultHub.connect(user).mintShares(vaultAddress, user, sharesToMint);

      const timestamp = await getCurrentBlockTimestamp();
      await vault.report(timestamp, ether("50"), ether("50"), ether("5"));

      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("1"));
      await lido.connect(burner).burnShares(ether("1"));

      const vaultSocket_2 = await vaultHub["vaultSocket(address)"](vaultAddress);
      const mintedStETH_2 = await lido.getPooledEthByShares(vaultSocket_2.sharesMinted);
      const maxMintableRatio_2 = TOTAL_BASIS_POINTS - vaultSocket_2.reserveRatioBP;
      const vaultValuation_2 = await vault.valuation();
      const localGap_2 =
        (mintedStETH_2 * TOTAL_BASIS_POINTS - vaultValuation_2 * maxMintableRatio_2) / vaultSocket_2.reserveRatioBP;

      expect(await vaultHub.rebalanceShortfall(vaultAddress)).to.equal(localGap_2);
    });
  });

  context("connectVault", () => {
    let vault: StakingVault__MockForVaultHub;
    let vaultAddress: string;

    before(async () => {
      vault = await createVault(vaultFactory);
      vaultAddress = await vault.getAddress();
    });

    it("reverts if called by non-VAULT_MASTER_ROLE", async () => {
      await expect(
        vaultHub
          .connect(stranger)
          .connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP),
      ).to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount");
    });

    it("reverts if vault address is zero", async () => {
      await expect(
        vaultHub
          .connect(user)
          .connectVault(ZeroAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP),
      ).to.be.revertedWithCustomError(vaultHub, "ZeroArgument");
    });

    it("reverts if reserve ratio BP is zero", async () => {
      await expect(
        vaultHub.connect(user).connectVault(vaultAddress, 0n, 0n, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP),
      ).to.be.revertedWithCustomError(vaultHub, "ZeroArgument");
    });

    it("reverts if reserve ratio is too high", async () => {
      const tooHighReserveRatioBP = TOTAL_BASIS_POINTS + 1n;
      await expect(
        vaultHub
          .connect(user)
          .connectVault(vaultAddress, SHARE_LIMIT, tooHighReserveRatioBP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP),
      )
        .to.be.revertedWithCustomError(vaultHub, "ReserveRatioTooHigh")
        .withArgs(vaultAddress, tooHighReserveRatioBP, TOTAL_BASIS_POINTS);
    });

    it("reverts if rebalance threshold BP is zero", async () => {
      await expect(
        vaultHub.connect(user).connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, 0n, TREASURY_FEE_BP),
      ).to.be.revertedWithCustomError(vaultHub, "ZeroArgument");
    });

    it("reverts if rebalance threshold BP is higher than reserve ratio BP", async () => {
      await expect(
        vaultHub
          .connect(user)
          .connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_BP + 1n, TREASURY_FEE_BP),
      )
        .to.be.revertedWithCustomError(vaultHub, "RebalanceThresholdTooHigh")
        .withArgs(vaultAddress, RESERVE_RATIO_BP + 1n, RESERVE_RATIO_BP);
    });

    it("reverts if treasury fee is too high", async () => {
      const tooHighTreasuryFeeBP = TOTAL_BASIS_POINTS + 1n;
      await expect(
        vaultHub
          .connect(user)
          .connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, tooHighTreasuryFeeBP),
      ).to.be.revertedWithCustomError(vaultHub, "TreasuryFeeTooHigh");
    });

    it("reverts if vault is already connected", async () => {
      const connectedVault = await createAndConnectVault(vaultFactory);
      const connectedVaultAddress = await connectedVault.getAddress();

      await expect(
        vaultHub
          .connect(user)
          .connectVault(
            connectedVaultAddress,
            SHARE_LIMIT,
            RESERVE_RATIO_BP,
            RESERVE_RATIO_THRESHOLD_BP,
            TREASURY_FEE_BP,
          ),
      ).to.be.revertedWithCustomError(vaultHub, "AlreadyConnected");
    });

    it("reverts if proxy codehash is not added", async () => {
      const stakingVault2Impl = await ethers.deployContract("StakingVault__MockForVaultHub", [
        vaultHub,
        await depositContract.getAddress(),
      ]);
      const vault2Factory = await ethers.deployContract("VaultFactory__MockForVaultHub", [
        await stakingVault2Impl.getAddress(),
      ]);
      const vault2 = await createVault(vault2Factory);

      await expect(
        vaultHub
          .connect(user)
          .connectVault(
            await vault2.getAddress(),
            SHARE_LIMIT,
            RESERVE_RATIO_BP,
            RESERVE_RATIO_THRESHOLD_BP,
            TREASURY_FEE_BP,
          ),
      ).to.be.revertedWithCustomError(vaultHub, "VaultProxyNotAllowed");
    });

    it("connects the vault", async () => {
      const vaultCountBefore = await vaultHub.vaultsCount();

      const vaultSocketBefore = await vaultHub["vaultSocket(address)"](vaultAddress);
      expect(vaultSocketBefore.vault).to.equal(ZeroAddress);
      expect(vaultSocketBefore.pendingDisconnect).to.be.false;

      await vault.connect(user).fund({ value: ether("1") });
      await vault.connect(user).lock(ether("1"));

      await expect(
        vaultHub
          .connect(user)
          .connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP),
      )
        .to.emit(vaultHub, "VaultConnected")
        .withArgs(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP);

      expect(await vaultHub.vaultsCount()).to.equal(vaultCountBefore + 1n);

      const vaultSocketAfter = await vaultHub["vaultSocket(address)"](vaultAddress);
      expect(vaultSocketAfter.vault).to.equal(vaultAddress);
      expect(vaultSocketAfter.pendingDisconnect).to.be.false;

      expect(await vault.locked()).to.equal(CONNECT_DEPOSIT);
    });

    it("allows to connect the vault with 0 share limit", async () => {
      await vault.connect(user).fund({ value: ether("1") });
      await vault.connect(user).lock(ether("1"));

      await expect(
        vaultHub
          .connect(user)
          .connectVault(vaultAddress, 0n, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP),
      )
        .to.emit(vaultHub, "VaultConnected")
        .withArgs(vaultAddress, 0n, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP);
    });

    it("allows to connect the vault with 0 treasury fee", async () => {
      await vault.connect(user).fund({ value: ether("1") });
      await vault.connect(user).lock(ether("1"));

      await expect(
        vaultHub
          .connect(user)
          .connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, 0n),
      )
        .to.emit(vaultHub, "VaultConnected")
        .withArgs(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, 0n);
    });
  });

  context("updateShareLimit", () => {
    let vault: StakingVault__MockForVaultHub;
    let vaultAddress: string;

    before(async () => {
      vault = await createAndConnectVault(vaultFactory);
      vaultAddress = await vault.getAddress();
    });

    it("reverts if called by non-VAULT_MASTER_ROLE", async () => {
      await expect(
        vaultHub.connect(stranger).updateShareLimit(vaultAddress, SHARE_LIMIT),
      ).to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount");
    });

    it("reverts if vault address is zero", async () => {
      await expect(vaultHub.connect(user).updateShareLimit(ZeroAddress, SHARE_LIMIT)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });

    it("reverts if share limit exceeds the maximum vault limit", async () => {
      const insaneLimit = ether("1000000000000000000000000");
      const totalShares = await lido.getTotalShares();
      const relativeShareLimitBP = VAULTS_RELATIVE_SHARE_LIMIT_BP;
      const relativeShareLimitPerVault = (totalShares * relativeShareLimitBP) / TOTAL_BASIS_POINTS;

      await expect(vaultHub.connect(user).updateShareLimit(vaultAddress, insaneLimit))
        .to.be.revertedWithCustomError(vaultHub, "ShareLimitTooHigh")
        .withArgs(vaultAddress, insaneLimit, relativeShareLimitPerVault);
    });

    it("updates the share limit", async () => {
      const newShareLimit = SHARE_LIMIT * 2n;

      await expect(vaultHub.connect(user).updateShareLimit(vaultAddress, newShareLimit))
        .to.emit(vaultHub, "ShareLimitUpdated")
        .withArgs(vaultAddress, newShareLimit);

      const vaultSocket = await vaultHub["vaultSocket(address)"](vaultAddress);
      expect(vaultSocket.shareLimit).to.equal(newShareLimit);
    });
  });

  context("disconnect", () => {
    let vault: StakingVault__MockForVaultHub;
    let vaultAddress: string;

    before(async () => {
      vault = await createAndConnectVault(vaultFactory);
      vaultAddress = await vault.getAddress();
    });

    it("reverts if called by non-VAULT_MASTER_ROLE", async () => {
      await expect(vaultHub.connect(stranger).disconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if vault address is zero", async () => {
      await expect(vaultHub.connect(user).disconnect(ZeroAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });

    it("reverts if vault is not connected", async () => {
      await expect(vaultHub.connect(user).disconnect(randomAddress())).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
    });

    it("reverts if vault has shares minted", async () => {
      await vault.fund({ value: ether("1") });
      await vaultHub.connect(user).mintShares(vaultAddress, user.address, 1n);

      await expect(vaultHub.connect(user).disconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NoMintedSharesShouldBeLeft",
      );
    });

    it("disconnects the vault", async () => {
      await expect(vaultHub.connect(user).disconnect(vaultAddress))
        .to.emit(vaultHub, "VaultDisconnected")
        .withArgs(vaultAddress);

      const vaultSocket = await vaultHub["vaultSocket(address)"](vaultAddress);
      expect(vaultSocket.pendingDisconnect).to.be.true;
    });
  });

  context("voluntaryDisconnect", () => {
    let vault: StakingVault__MockForVaultHub;
    let vaultAddress: string;

    before(async () => {
      vault = await createAndConnectVault(vaultFactory);
      vaultAddress = await vault.getAddress();
    });

    it("reverts if minting paused", async () => {
      await vaultHub.connect(user).pauseFor(1000n);

      await expect(vaultHub.connect(user).voluntaryDisconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "ResumedExpected",
      );
    });

    it("reverts if vault is zero address", async () => {
      await expect(vaultHub.connect(user).voluntaryDisconnect(ZeroAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });

    it("reverts if called as non-vault owner", async () => {
      await expect(vaultHub.connect(stranger).voluntaryDisconnect(vaultAddress))
        .to.be.revertedWithCustomError(vaultHub, "NotAuthorized")
        .withArgs("disconnect", stranger);
    });

    it("reverts if vault is not connected", async () => {
      await vaultHub.connect(user).disconnect(vaultAddress);

      await expect(vaultHub.connect(user).voluntaryDisconnect(vaultAddress))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(vaultAddress);
    });

    it("reverts if vault has shares minted", async () => {
      await vault.fund({ value: ether("1") });
      await vaultHub.connect(user).mintShares(vaultAddress, user.address, 1n);

      await expect(vaultHub.connect(user).disconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NoMintedSharesShouldBeLeft",
      );
    });

    it("disconnects the vault", async () => {
      await expect(vaultHub.connect(user).disconnect(vaultAddress))
        .to.emit(vaultHub, "VaultDisconnected")
        .withArgs(vaultAddress);

      const vaultSocket = await vaultHub["vaultSocket(address)"](vaultAddress);
      expect(vaultSocket.pendingDisconnect).to.be.true;
    });
  });
});
