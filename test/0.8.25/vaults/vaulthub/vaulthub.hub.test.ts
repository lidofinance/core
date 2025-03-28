import { expect } from "chai";
import { ContractTransactionReceipt, keccak256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ACL,
  DepositContract__MockForVaultHub,
  Lido,
  LidoLocator,
  OperatorGrid,
  OssifiableProxy,
  PredepositGuarantee_HarnessForFactory,
  StakingVault__MockForVaultHub,
  VaultFactory__MockForVaultHub,
  VaultHub,
} from "typechain-types";

import { BigIntMath, ether, findEvents, impersonate, randomAddress } from "lib";

import { deployLidoDao, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot, VAULTS_RELATIVE_SHARE_LIMIT_BP, ZERO_HASH } from "test/suite";

const ZERO_BYTES32 = "0x" + Buffer.from(ZERO_HASH).toString("hex");

const SHARE_LIMIT = ether("1");
const RESERVE_RATIO_BP = 10_00n;
const RESERVE_RATIO_THRESHOLD_BP = 8_00n;
const TREASURY_FEE_BP = 5_00n;

const TOTAL_BASIS_POINTS = 100_00n; // 100%
const CONNECT_DEPOSIT = ether("1");

const VAULTS_CONNECTED_VAULTS_LIMIT = 5; // Low limit to test the overflow

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
  let operatorGrid: OperatorGrid;
  let operatorGridImpl: OperatorGrid;
  let proxy: OssifiableProxy;

  let codehash: string;

  let originalState: string;

  async function createVault(factory: VaultFactory__MockForVaultHub) {
    const vaultCreationTx = (await factory
      .createVault(await user.getAddress(), await user.getAddress())
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const events = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = events[0];

    const vault = await ethers.getContractAt("StakingVault__MockForVaultHub", vaultCreatedEvent.args.vault, user);
    return vault;
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
    await registerVaultWithTier(vault, options);
    const tx = await vaultHub.connect(user).connectVault(vault);

    return { vault, tx };
  }

  async function registerVaultWithTier(
    vault: StakingVault__MockForVaultHub,
    options?: {
      shareLimit?: bigint;
      reserveRatioBP?: bigint;
      rebalanceThresholdBP?: bigint;
      treasuryFeeBP?: bigint;
    },
  ) {
    const groupId = 1;
    const tiersCount = (await operatorGrid.group(groupId)).tiersCount;
    const nextTierId = tiersCount + 1n;

    await operatorGrid
      .connect(user)
      .registerTier(
        groupId,
        nextTierId,
        options?.shareLimit ?? SHARE_LIMIT,
        options?.reserveRatioBP ?? RESERVE_RATIO_BP,
        options?.rebalanceThresholdBP ?? RESERVE_RATIO_THRESHOLD_BP,
        options?.treasuryFeeBP ?? TREASURY_FEE_BP,
      );

    await operatorGrid.connect(user).registerVault(vault);
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

    // OperatorGrid
    operatorGridImpl = await ethers.deployContract("OperatorGrid", [locator], { from: deployer });
    proxy = await ethers.deployContract("OssifiableProxy", [operatorGridImpl, deployer, new Uint8Array()], deployer);
    operatorGrid = await ethers.getContractAt("OperatorGrid", proxy, deployer);

    await operatorGrid.initialize(user);

    const vaultHubImpl = await ethers.deployContract("VaultHub", [
      locator,
      await locator.lido(),
      operatorGrid,
      VAULTS_CONNECTED_VAULTS_LIMIT,
      VAULTS_RELATIVE_SHARE_LIMIT_BP,
    ]);

    proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);

    const vaultHubAdmin = await ethers.getContractAt("VaultHub", proxy);
    await vaultHubAdmin.initialize(deployer);

    vaultHub = await ethers.getContractAt("VaultHub", proxy, user);
    await vaultHubAdmin.grantRole(await vaultHub.PAUSE_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.RESUME_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.VAULT_MASTER_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.VAULT_REGISTRY_ROLE(), user);

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultHub, predepositGuarantee });

    const stakingVaultImpl = await ethers.deployContract("StakingVault__MockForVaultHub", [
      vaultHub,
      predepositGuarantee,
      depositContract,
    ]);

    vaultFactory = await ethers.deployContract("VaultFactory__MockForVaultHub", [await stakingVaultImpl.getAddress()]);
    const vault = await createVault(vaultFactory);

    codehash = keccak256(await ethers.provider.getCode(await vault.getAddress()));
    await vaultHub.connect(user).addVaultProxyCodehash(codehash);

    await operatorGrid.connect(user).grantRole(await operatorGrid.REGISTRY_ROLE(), user);
    await operatorGrid.connect(user).registerGroup(1, ether("100"));
    await operatorGrid.connect(user)["registerOperator(address)"](user);
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
      const { vault } = await createAndConnectVault(vaultFactory);
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
      const { vault } = await createAndConnectVault(vaultFactory);
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
      const { vault } = await createAndConnectVault(vaultFactory);
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

  context("isVaultHealthy", () => {
    it("reverts if vault is not connected", async () => {
      await expect(vaultHub.isVaultHealthy(randomAddress())).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
    });

    it("returns true if the vault has no shares minted", async () => {
      const { vault } = await createAndConnectVault(vaultFactory);
      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("1") });

      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(true);
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

        const { vault } = await createAndConnectVault(vaultFactory, {
          shareLimit: ether("100"),
          reserveRatioBP: reserveRatioBP,
          rebalanceThresholdBP: rebalanceThresholdBP,
        });

        const vaultAddress = await vault.getAddress();

        await vault.fund({ value: valuation });

        if (mintable > 0n) {
          const sharesToMint = await lido.getSharesByPooledEth(mintable);
          await vaultHub.connect(user).mintShares(vaultAddress, user, sharesToMint);
        }

        await vault.report(valuation - slashed, valuation, BigIntMath.max(mintable, ether("1")));

        const actualHealthy = await vaultHub.isVaultHealthy(vaultAddress);
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
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        rebalanceThresholdBP: 50_00n, // 50%
      });

      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("1") });
      await vaultHub.connect(user).mintShares(vaultAddress, user, ether("0.25"));

      await vault.report(ether("1"), ether("1"), ether("1")); // normal report
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(true);

      await vault.report(ether("0.5") + 1n, ether("1"), ether("1")); // above the threshold
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(true);

      await vault.report(ether("0.5"), ether("1"), ether("1")); // at the threshold
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(true);

      await vault.report(ether("0.5") - 1n, ether("1"), ether("1")); // below the threshold
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(false);
    });

    it("returns correct value for different share rates", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        rebalanceThresholdBP: 50_00n, // 50%
      });

      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("1") });
      const mintingEth = ether("0.5");
      const sharesToMint = await lido.getSharesByPooledEth(mintingEth);
      await vaultHub.connect(user).mintShares(vaultAddress, user, sharesToMint);

      await vault.report(ether("1"), ether("1"), ether("1")); // normal report
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(true); // valuation is enough

      // Burn some shares to make share rate fractional
      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("100"));
      await lido.connect(burner).burnShares(ether("100"));

      await vault.report(ether("1"), ether("1"), ether("1")); // normal report
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(false); // old valuation is not enough

      const lockedEth = await lido.getPooledEthBySharesRoundUp(sharesToMint);
      // For 50% reserve ratio, we need valuation to be 2x of locked ETH to be healthy
      const report = lockedEth * 2n;

      await vault.report(report - 1n, ether("1"), ether("1")); // below the threshold
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(false);

      await vault.report(report, ether("1"), ether("1")); // at the threshold
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(true);

      await vault.report(report + 1n, ether("1"), ether("1")); // above the threshold
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(true);
    });

    it("returns correct value for smallest possible reserve ratio", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 1n, // 0.01%
        rebalanceThresholdBP: 1n, // 0.01%
      });

      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("1") });

      const mintingEth = ether("0.9999"); // 99.99% of the valuation
      const sharesToMint = await lido.getSharesByPooledEth(mintingEth);
      await vaultHub.connect(user).mintShares(vaultAddress, user, sharesToMint);

      await vault.report(ether("1"), ether("1"), ether("1")); // normal report
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(true); // valuation is enough

      // Burn some shares to make share rate fractional
      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("100"));
      await lido.connect(burner).burnShares(ether("100"));

      const lockedEth = await lido.getPooledEthBySharesRoundUp(sharesToMint);
      // if lockedEth is 99.99% of the valuation we need to report 100.00% of the valuation to be healthy
      const report = (lockedEth * 10000n) / 9999n;

      await vault.report(report - 1n, ether("1"), ether("1")); // below the threshold
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(false);

      await vault.report(report, ether("1"), ether("1")); // at the threshold
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(false); // XXX: rounding issue, should be true

      await vault.report(report + 1n, ether("1"), ether("1")); // above the threshold
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(true);
    });

    it("returns correct value for minimal shares amounts", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"),
        reserveRatioBP: 50_00n, // 50%
        rebalanceThresholdBP: 50_00n, // 50%
      });

      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("1") });
      await vaultHub.connect(user).mintShares(vaultAddress, user, 1n);

      await vault.report(ether("1"), ether("1"), ether("1"));
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(true);

      await vault.report(2n, ether("1"), ether("1")); // Minimal valuation to be healthy with 1 share (50% reserve ratio)
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(true);

      await vault.report(1n, ether("1"), ether("1")); // Below minimal required valuation
      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(false);

      await lido.connect(user).transferShares(await locator.vaultHub(), 1n);
      await vaultHub.connect(user).burnShares(vaultAddress, 1n);

      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(true); // Should be healthy with no shares
    });
  });

  context("connectVault", () => {
    let vault: StakingVault__MockForVaultHub;
    let vaultAddress: string;

    before(async () => {
      vault = await createVault(vaultFactory);
      vaultAddress = await vault.getAddress();
    });

    it("reverts if reserve ratio BP is zero", async () => {
      await registerVaultWithTier(vault, {
        shareLimit: 0n,
        reserveRatioBP: 0n,
        rebalanceThresholdBP: RESERVE_RATIO_THRESHOLD_BP,
        treasuryFeeBP: TREASURY_FEE_BP,
      });

      await expect(vaultHub.connect(user).connectVault(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });

    it("reverts if reserve ratio is too high", async () => {
      const tooHighReserveRatioBP = TOTAL_BASIS_POINTS + 1n;

      await registerVaultWithTier(vault, {
        shareLimit: SHARE_LIMIT,
        reserveRatioBP: tooHighReserveRatioBP,
        rebalanceThresholdBP: RESERVE_RATIO_THRESHOLD_BP,
        treasuryFeeBP: TREASURY_FEE_BP,
      });

      await expect(vaultHub.connect(user).connectVault(vaultAddress))
        .to.be.revertedWithCustomError(vaultHub, "ReserveRatioTooHigh")
        .withArgs(vaultAddress, tooHighReserveRatioBP, TOTAL_BASIS_POINTS);
    });

    it("reverts if rebalance threshold BP is zero", async () => {
      await registerVaultWithTier(vault, {
        shareLimit: SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO_BP,
        rebalanceThresholdBP: 0n,
        treasuryFeeBP: TREASURY_FEE_BP,
      });

      await expect(vaultHub.connect(user).connectVault(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });

    it("reverts if rebalance threshold BP is higher than reserve ratio BP", async () => {
      await registerVaultWithTier(vault, {
        shareLimit: SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO_BP,
        rebalanceThresholdBP: RESERVE_RATIO_BP + 1n,
        treasuryFeeBP: TREASURY_FEE_BP,
      });

      await expect(vaultHub.connect(user).connectVault(vaultAddress))
        .to.be.revertedWithCustomError(vaultHub, "RebalanceThresholdTooHigh")
        .withArgs(vaultAddress, RESERVE_RATIO_BP + 1n, RESERVE_RATIO_BP);
    });

    it("reverts if treasury fee is too high", async () => {
      const tooHighTreasuryFeeBP = TOTAL_BASIS_POINTS + 1n;

      await registerVaultWithTier(vault, {
        shareLimit: SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO_BP,
        rebalanceThresholdBP: RESERVE_RATIO_THRESHOLD_BP,
        treasuryFeeBP: tooHighTreasuryFeeBP,
      });

      await expect(vaultHub.connect(user).connectVault(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "TreasuryFeeTooHigh",
      );
    });

    it("reverts if max vault size is exceeded", async () => {
      const vaultsCount = await vaultHub.vaultsCount();
      for (let i = vaultsCount; i < VAULTS_CONNECTED_VAULTS_LIMIT; i++) {
        await createAndConnectVault(vaultFactory);
      }

      await registerVaultWithTier(vault);

      await expect(vaultHub.connect(user).connectVault(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "TooManyVaults",
      );
    });

    it("reverts if vault is already connected", async () => {
      const { vault: connectedVault } = await createAndConnectVault(vaultFactory);
      const connectedVaultAddress = await connectedVault.getAddress();

      await expect(vaultHub.connect(user).connectVault(connectedVaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "AlreadyConnected",
      );
    });

    it("reverts if proxy codehash is not added", async () => {
      const stakingVault2Impl = await ethers.deployContract("StakingVault__MockForVaultHub", [
        await vaultHub.getAddress(),
        await predepositGuarantee.getAddress(),
        await depositContract.getAddress(),
      ]);
      const vault2Factory = await ethers.deployContract("VaultFactory__MockForVaultHub", [
        await stakingVault2Impl.getAddress(),
      ]);

      const vault2 = await createVault(vault2Factory);

      await registerVaultWithTier(vault2);

      await expect(vaultHub.connect(user).connectVault(vault2)).to.be.revertedWithCustomError(
        vaultHub,
        "VaultProxyNotAllowed",
      );
    });

    it("connects the vault", async () => {
      const vaultCountBefore = await vaultHub.vaultsCount();

      const vaultSocketBefore = await vaultHub["vaultSocket(address)"](vaultAddress);
      expect(vaultSocketBefore.vault).to.equal(ZeroAddress);
      expect(vaultSocketBefore.pendingDisconnect).to.be.false;

      const { vault: _vault, tx } = await createAndConnectVault(vaultFactory, {
        shareLimit: SHARE_LIMIT, // just to bypass the share limit check
        reserveRatioBP: RESERVE_RATIO_BP,
        rebalanceThresholdBP: RESERVE_RATIO_THRESHOLD_BP,
        treasuryFeeBP: TREASURY_FEE_BP,
      });

      await expect(tx)
        .to.emit(vaultHub, "VaultConnected")
        .withArgs(_vault, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP);

      expect(await vaultHub.vaultsCount()).to.equal(vaultCountBefore + 1n);

      const vaultSocketAfter = await vaultHub["vaultSocket(address)"](_vault);
      expect(vaultSocketAfter.vault).to.equal(_vault);
      expect(vaultSocketAfter.pendingDisconnect).to.be.false;

      expect(await _vault.locked()).to.equal(CONNECT_DEPOSIT);
    });

    it("allows to connect the vault with 0 share limit", async () => {
      const { vault: _vault, tx } = await createAndConnectVault(vaultFactory, {
        shareLimit: 0n, // just to bypass the share limit check
        reserveRatioBP: RESERVE_RATIO_BP,
        rebalanceThresholdBP: RESERVE_RATIO_THRESHOLD_BP,
        treasuryFeeBP: TREASURY_FEE_BP,
      });

      await expect(tx)
        .to.emit(vaultHub, "VaultConnected")
        .withArgs(_vault, 0n, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP);
    });

    it("allows to connect the vault with 0 treasury fee", async () => {
      const { vault: _vault, tx } = await createAndConnectVault(vaultFactory, {
        shareLimit: SHARE_LIMIT, // just to bypass the share limit check
        reserveRatioBP: RESERVE_RATIO_BP,
        rebalanceThresholdBP: RESERVE_RATIO_THRESHOLD_BP,
        treasuryFeeBP: 0n,
      });

      await expect(tx)
        .to.emit(vaultHub, "VaultConnected")
        .withArgs(_vault, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, 0n);
    });
  });

  context("updateShareLimit", () => {
    let vault: StakingVault__MockForVaultHub;
    let vaultAddress: string;

    before(async () => {
      const { vault: _vault } = await createAndConnectVault(vaultFactory);
      vault = _vault;
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
      const { vault: _vault } = await createAndConnectVault(vaultFactory);
      vault = _vault;
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
      const { vault: _vault } = await createAndConnectVault(vaultFactory);
      vault = _vault;
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
