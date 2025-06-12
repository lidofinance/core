import { expect } from "chai";
import { getBigInt, MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Dashboard,
  DepositContract__MockForStakingVault,
  ERC721__MockForDashboard,
  LidoLocator,
  OperatorGrid,
  OssifiableProxy,
  Permissions,
  StakingVault,
  StETHPermit__HarnessForDashboard,
  UpgradeableBeacon,
  VaultFactory,
  VaultHub,
  VaultHub__MockForDashboard,
  WETH9__MockForVault,
  WstETH__HarnessForVault,
} from "typechain-types";

import {
  certainAddress,
  days,
  deployEIP7002WithdrawalRequestContract,
  EIP7002_MIN_WITHDRAWAL_REQUEST_FEE,
  ether,
  findEvents,
  impersonate,
  randomValidatorPubkey,
} from "lib";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot } from "test/suite";

const VAULT_CONNECTION_DEPOSIT = ether("1");

describe("Dashboard.sol", () => {
  let deployer: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let steth: StETHPermit__HarnessForDashboard;
  let weth: WETH9__MockForVault;
  let erc721: ERC721__MockForDashboard;
  let wsteth: WstETH__HarnessForVault;
  let hub: VaultHub__MockForDashboard;
  let depositContract: DepositContract__MockForStakingVault;

  let lidoLocator: LidoLocator;

  let dashboardImpl: Dashboard;
  let vaultImpl: StakingVault;
  let beacon: UpgradeableBeacon;
  let factory: VaultFactory;

  let vault: StakingVault;
  let dashboard: Dashboard;
  let operatorGrid: OperatorGrid;
  let operatorGridImpl: OperatorGrid;
  let proxy: OssifiableProxy;

  const nodeOperatorFeeBP = 0n;
  const confirmExpiry = days(7n);

  let originalState: string;

  const BP_BASE = 10_000n;

  const DEFAULT_TIER_SHARE_LIMIT = 1000;
  const RESERVE_RATIO = 2000;
  const FORCED_REBALANCE_THRESHOLD = 1800;
  const INFRA_FEE = 500;
  const LIQUIDITY_FEE = 400;
  const RESERVATION_FEE = 100;

  const record: Readonly<VaultHub.VaultRecordStruct> = {
    report: {
      totalValue: 1000n,
      inOutDelta: 1000n,
    },
    liabilityShares: 555n,
    locked: 1000n,
    reportTimestamp: 2122n,
    inOutDelta: 1000n,
    feeSharesCharged: 1n,
  };

  const connection: Readonly<VaultHub.VaultConnectionStruct> = {
    owner: ZeroAddress,
    shareLimit: 100000n,
    vaultIndex: 0n,
    pendingDisconnect: false,
    reserveRatioBP: 1000n,
    forcedRebalanceThresholdBP: 800n,
    infraFeeBP: 1000n,
    liquidityFeeBP: 400n,
    reservationFeeBP: 100n,
  };

  const setup = async ({
    reserveRatioBP,
    shareLimit,
    totalValue,
    liabilityShares,
    locked,
  }: Partial<VaultHub.VaultRecordStruct & VaultHub.VaultConnectionStruct & VaultHub.ReportStruct> = {}) => {
    await hub.mock__setVaultConnection(vault, {
      ...connection,
      reserveRatioBP: reserveRatioBP ?? connection.reserveRatioBP,
      shareLimit: shareLimit ?? connection.shareLimit,
    });

    await hub.mock__setVaultRecord(vault, {
      ...record,
      report: { ...record.report, totalValue: totalValue ?? record.report.totalValue },
      liabilityShares: liabilityShares ?? record.liabilityShares,
      locked: locked ?? record.locked,
    });
  };

  before(async () => {
    [deployer, vaultOwner, nodeOperator, stranger] = await ethers.getSigners();

    await deployEIP7002WithdrawalRequestContract(EIP7002_MIN_WITHDRAWAL_REQUEST_FEE);

    steth = await ethers.deployContract("StETHPermit__HarnessForDashboard");
    await steth.mock__setTotalShares(ether("1000000"));
    await steth.mock__setTotalPooledEther(ether("1400000"));

    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);

    lidoLocator = await deployLidoLocator({ lido: steth, wstETH: wsteth });

    erc721 = await ethers.deployContract("ERC721__MockForDashboard");
    weth = await ethers.deployContract("WETH9__MockForVault");

    depositContract = await ethers.deployContract("DepositContract__MockForStakingVault");

    hub = await ethers.deployContract("VaultHub__MockForDashboard", [steth, lidoLocator]);

    // OperatorGrid
    operatorGridImpl = await ethers.deployContract("OperatorGrid", [lidoLocator], { from: deployer });
    proxy = await ethers.deployContract("OssifiableProxy", [operatorGridImpl, deployer, new Uint8Array()], deployer);
    operatorGrid = await ethers.getContractAt("OperatorGrid", proxy, deployer);

    const defaultTierParams = {
      shareLimit: DEFAULT_TIER_SHARE_LIMIT,
      reserveRatioBP: RESERVE_RATIO,
      forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD,
      infraFeeBP: INFRA_FEE,
      liquidityFeeBP: LIQUIDITY_FEE,
      reservationFeeBP: RESERVATION_FEE,
    };
    await operatorGrid.initialize(deployer, defaultTierParams);
    await operatorGrid.grantRole(await operatorGrid.REGISTRY_ROLE(), deployer);

    // Register group and tiers
    const shareLimit = 1000;
    await operatorGrid.connect(deployer).registerGroup(nodeOperator, shareLimit);
    await operatorGrid.connect(deployer).registerTiers(nodeOperator, [
      {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        infraFeeBP: 500,
        liquidityFeeBP: 400,
        reservationFeeBP: 100,
      },
    ]);

    await updateLidoLocatorImplementation(await lidoLocator.getAddress(), {
      vaultHub: hub.getAddress(),
      operatorGrid: operatorGrid.getAddress(),
    });

    dashboardImpl = await ethers.deployContract("Dashboard", [steth, wsteth, hub, lidoLocator]);
    vaultImpl = await ethers.deployContract("StakingVault", [depositContract]);
    beacon = await ethers.deployContract("UpgradeableBeacon", [vaultImpl, deployer]);

    factory = await ethers.deployContract("VaultFactory", [lidoLocator, beacon, dashboardImpl]);
    const createVaultTx = await factory
      .connect(vaultOwner)
      .createVaultWithDashboard(vaultOwner, nodeOperator, nodeOperator, nodeOperatorFeeBP, confirmExpiry, [], {
        value: VAULT_CONNECTION_DEPOSIT,
      });
    const createVaultReceipt = (await createVaultTx.wait())!;

    const vaultCreatedEvent = findEvents(createVaultReceipt, "VaultCreated")[0];
    const vaultAddress = vaultCreatedEvent.args.vault;
    vault = await ethers.getContractAt("StakingVault", vaultAddress);

    const dashboardCreatedEvent = findEvents(createVaultReceipt, "DashboardCreated")[0];
    const dashboardAddress = dashboardCreatedEvent.args.dashboard;
    dashboard = await ethers.getContractAt("Dashboard", dashboardAddress, vaultOwner);

    originalState = await Snapshot.take();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("sets the stETH, wstETH, VAULT_HUB, and LIDO_LOCATOR addresses", async () => {
      expect(await dashboardImpl.STETH()).to.equal(steth);
      expect(await dashboardImpl.WSTETH()).to.equal(wsteth);
      expect(await dashboardImpl.VAULT_HUB()).to.equal(hub);
      expect(await dashboardImpl.LIDO_LOCATOR()).to.equal(lidoLocator);
    });

    it("reverts if steth is zero address", async () => {
      await expect(ethers.deployContract("Dashboard", [ethers.ZeroAddress, wsteth, hub, lidoLocator]))
        .to.be.revertedWithCustomError(dashboardImpl, "ZeroArgument")
        .withArgs("_stETH");
    });

    it("reverts if wsteth is zero address", async () => {
      await expect(ethers.deployContract("Dashboard", [steth, ethers.ZeroAddress, hub, lidoLocator]))
        .to.be.revertedWithCustomError(dashboardImpl, "ZeroArgument")
        .withArgs("_wstETH");
    });

    it("reverts if vaultHub is zero address", async () => {
      await expect(ethers.deployContract("Dashboard", [steth, wsteth, ethers.ZeroAddress, lidoLocator]))
        .to.be.revertedWithCustomError(dashboardImpl, "ZeroArgument")
        .withArgs("_vaultHub");
    });

    it("reverts if lidoLocator is zero address", async () => {
      await expect(ethers.deployContract("Dashboard", [steth, wsteth, hub, ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(dashboardImpl, "ZeroArgument")
        .withArgs("_lidoLocator");
    });
  });

  context("initialize", () => {
    it("Check immutable variables", async () => {
      expect(await dashboard.STETH()).to.equal(steth);
      expect(await dashboard.WSTETH()).to.equal(wsteth);
      expect(await dashboard.VAULT_HUB()).to.equal(hub);
      expect(await dashboard.LIDO_LOCATOR()).to.equal(lidoLocator);
    });

    it("reverts if already initialized", async () => {
      await expect(
        dashboard.initialize(vaultOwner, nodeOperator, nodeOperatorFeeBP, confirmExpiry),
      ).to.be.revertedWithCustomError(dashboard, "AlreadyInitialized");
    });

    it("reverts if called on the implementation", async () => {
      await expect(
        dashboardImpl.initialize(vaultOwner, nodeOperator, nodeOperatorFeeBP, confirmExpiry),
      ).to.be.revertedWithCustomError(dashboardImpl, "NonProxyCallsForbidden");
    });
  });

  context("confirmingRoles", () => {
    it("returns the array of roles", async () => {
      const confirmingRoles = await dashboard.confirmingRoles();
      expect(confirmingRoles).to.deep.equal([
        await dashboard.DEFAULT_ADMIN_ROLE(),
        await dashboard.NODE_OPERATOR_MANAGER_ROLE(),
      ]);
    });
  });

  context("initialized state", () => {
    it("post-initialization state is correct", async () => {
      // vault state
      expect(await dashboard.initialized()).to.equal(true);
      expect(await dashboard.stakingVault()).to.equal(vault);
      expect(await dashboard.VAULT_HUB()).to.equal(hub);
      expect(await dashboard.STETH()).to.equal(steth);
      expect(await dashboard.WSTETH()).to.equal(wsteth);
      expect(await dashboard.LIDO_LOCATOR()).to.equal(lidoLocator);
      // dashboard roles
      expect(await dashboard.hasRole(await dashboard.DEFAULT_ADMIN_ROLE(), vaultOwner)).to.be.true;
      expect(await dashboard.getRoleMemberCount(await dashboard.DEFAULT_ADMIN_ROLE())).to.equal(1);
      expect(await dashboard.getRoleMember(await dashboard.DEFAULT_ADMIN_ROLE(), 0)).to.equal(vaultOwner);
      // dashboard allowance
      expect(await steth.allowance(dashboard, wsteth)).to.equal(MaxUint256);
    });
  });

  context("vaultRecord views", () => {
    before(async () => {
      await hub.mock__setVaultRecord(vault, record);
    });

    it("liabilityShares", async () => {
      const liabilityShares = await dashboard.liabilityShares();
      expect(liabilityShares).to.equal(record.liabilityShares);
    });

    it("latestReport", async () => {
      const latestReport = await dashboard.latestReport();
      expect(latestReport).to.deep.equal([record.report.totalValue, record.report.inOutDelta]);
    });

    it("locked", async () => {
      const locked = await dashboard.locked();
      expect(locked).to.equal(record.locked);
    });

    it("totalValue", async () => {
      const totalValue = await dashboard.totalValue();
      expect(totalValue).to.equal(await hub.totalValue(vault));
    });
  });

  context("vaultConnection views", () => {
    before(async () => {
      await hub.mock__setVaultConnection(vault, connection);
    });

    it("returns the correct vault connection data", async () => {
      const connection_ = await dashboard.vaultConnection();
      expect(connection_).to.deep.equal(Object.values(connection));
    });

    it("shareLimit", async () => {
      const shareLimit = await dashboard.shareLimit();
      expect(shareLimit).to.equal(connection.shareLimit);
    });

    it("reserveRatioBP", async () => {
      const reserveRatioBP = await dashboard.reserveRatioBP();
      expect(reserveRatioBP).to.equal(connection.reserveRatioBP);
    });

    it("forcedRebalanceThresholdBP", async () => {
      const forcedRebalanceThresholdBP = await dashboard.forcedRebalanceThresholdBP();
      expect(forcedRebalanceThresholdBP).to.equal(connection.forcedRebalanceThresholdBP);
    });

    it("infraFeeBP", async () => {
      const infraFeeBP = await dashboard.infraFeeBP();
      expect(infraFeeBP).to.equal(connection.infraFeeBP);
    });

    it("liquidityFeeBP", async () => {
      const liquidityFeeBP = await dashboard.liquidityFeeBP();
      expect(liquidityFeeBP).to.equal(connection.liquidityFeeBP);
    });

    it("reservationFeeBP", async () => {
      const reservationFeeBP = await dashboard.reservationFeeBP();
      expect(reservationFeeBP).to.equal(connection.reservationFeeBP);
    });
  });

  context("connection+record views", () => {
    context("totalMintingCapacityShares", () => {
      it("returns mintable shares if totalValue is 0", async () => {
        await setup({ totalValue: 0n });
        const maxShares = await dashboard.totalMintingCapacityShares();

        expect(maxShares).to.equal(0n);
      });

      it("returns correct max mintable shares with no fees = 0 and unbounded shareLimit", async () => {
        const totalValue = 1000n;
        await setup({ totalValue });

        const maxStETHMinted = (totalValue * (BP_BASE - getBigInt(connection.reserveRatioBP))) / BP_BASE;
        const maxSharesMinted = await steth.getSharesByPooledEth(maxStETHMinted);

        const maxMintableShares = await dashboard.totalMintingCapacityShares();

        expect(maxMintableShares).to.equal(maxSharesMinted);
      });

      it("returns correct max mintable shares when bound by shareLimit", async () => {
        await setup({ shareLimit: 100n });

        const availableMintableShares = await dashboard.totalMintingCapacityShares();

        expect(availableMintableShares).to.equal(100n);
      });

      it("returns zero when reserve ratio is does not allow mint", async () => {
        await setup({ reserveRatioBP: 10_000n });

        const availableMintableShares = await dashboard.totalMintingCapacityShares();

        expect(availableMintableShares).to.equal(0n);
      });

      it("returns funded amount when reserve ratio is zero", async () => {
        await setup({ reserveRatioBP: 0n, totalValue: 1000n });

        const availableMintableShares = await dashboard.totalMintingCapacityShares();

        const toShares = await steth.getSharesByPooledEth(1000n);
        expect(availableMintableShares).to.equal(toShares);
      });

      // todo: add node operator fee tests
    });

    context("remainingMintingCapacityShares", () => {
      it("0 remaining capacity if no total value and no liability shares", async () => {
        await setup({ totalValue: 0n, liabilityShares: 0n });
        const canMint = await dashboard.remainingMintingCapacityShares(0n);
        expect(canMint).to.equal(0n);
      });

      it("remaining capacity is the same as total capacity if no shares minted", async () => {
        await setup({ totalValue: 1000n, liabilityShares: 0n });

        const remainingCapacity = await dashboard.remainingMintingCapacityShares(0n);
        const totalCapacity = await dashboard.totalMintingCapacityShares();

        expect(remainingCapacity).to.equal(totalCapacity);
      });

      it("remaining capacity with funding works as expected", async () => {
        await setup({ totalValue: 1000n, liabilityShares: 0n });

        const funding = 1000n;

        const preFundCanMint = await dashboard.remainingMintingCapacityShares(funding);
        await setup({ totalValue: 2000n, liabilityShares: 0n }); // fund 1000n

        const maxStETHMinted = (2000n * (BP_BASE - getBigInt(connection.reserveRatioBP))) / BP_BASE;
        const maxSharesMinted = await steth.getSharesByPooledEth(maxStETHMinted);

        const canMint = await dashboard.remainingMintingCapacityShares(0n);
        expect(canMint).to.equal(preFundCanMint);
        expect(canMint).to.equal(maxSharesMinted);
      });

      it("remaining capacity is 0 if liability shares is maxxed out", async () => {
        const totalValue = 1000n;
        const liability = (totalValue * (BP_BASE - getBigInt(connection.reserveRatioBP))) / BP_BASE;
        const liabilityShares = await steth.getSharesByPooledEth(liability);
        await setup({ totalValue, liabilityShares });

        const canMint = await dashboard.remainingMintingCapacityShares(0n);
        expect(canMint).to.equal(0n);

        const funding = 1000n;
        const canMintIfFunded = await dashboard.remainingMintingCapacityShares(funding);

        const mintableStETH = ((funding + totalValue) * (BP_BASE - getBigInt(connection.reserveRatioBP))) / BP_BASE;
        const mintableShares = await steth.getSharesByPooledEth(mintableStETH);

        expect(canMintIfFunded).to.equal(mintableShares - liabilityShares);
      });

      it("remaining capacity is 0 if liabilityShares is over total capacity", async () => {
        await setup({ totalValue: 0, liabilityShares: 10000n, shareLimit: 10000000n });

        const funding = 1000n;

        expect(await dashboard.remainingMintingCapacityShares(0n)).to.equal(0n);
        expect(await dashboard.remainingMintingCapacityShares(funding)).to.equal(0n);
      });

      it("remaining capacity is 0 if liabilityShares is over shareLimit", async () => {
        await setup({ totalValue: 1000n, liabilityShares: 100n, shareLimit: 11n });

        const funding = 1000n;

        expect(await dashboard.remainingMintingCapacityShares(0n)).to.equal(0n);
        expect(await dashboard.remainingMintingCapacityShares(funding)).to.equal(0n);
      });

      it("remaining capacity is working as expected", async () => {
        const totalValue = 1000n;
        await setup({ totalValue, liabilityShares: 100n });

        const funding = 1000n;
        const preFundCanMint = await dashboard.remainingMintingCapacityShares(funding);
        await setup({ totalValue: totalValue + funding, liabilityShares: 100n }); // fund

        const maxSharesMintable = await dashboard.totalMintingCapacityShares();

        const canMint = await dashboard.remainingMintingCapacityShares(0n);
        expect(canMint).to.equal(maxSharesMintable - 100n);
        expect(canMint).to.equal(preFundCanMint);
      });
    });

    context("withdrawableValue", () => {
      it("returns the trivial amount can withdraw ether", async () => {
        await setup({ totalValue: 0n, locked: 0n });

        expect(await dashboard.withdrawableValue()).to.equal(0n);
      });

      it("returns totalValue if balance > totalValue and locked = 0", async () => {
        await setBalance(await vault.getAddress(), ether("100"));
        const amount = ether("1");
        await setup({ totalValue: amount, locked: 0n });

        expect(await dashboard.withdrawableValue()).to.equal(amount);
      });

      it("returns totalValue - locked if balance > totalValue and locked > 0", async () => {
        await setBalance(await vault.getAddress(), ether("100"));
        const amount = ether("1");
        await setup({ totalValue: amount, locked: amount / 2n });

        expect(await dashboard.withdrawableValue()).to.equal(amount / 2n);
      });

      it("returns balance if balance < totalValue and locked = 0", async () => {
        const amount = ether("1");
        await setBalance(await vault.getAddress(), amount - 1n);
        await setup({ totalValue: amount, locked: 0n });
        expect(await dashboard.withdrawableValue()).to.equal(amount - 1n);
      });

      it("returns balance if balance < totalValue and locked <= (totalValue - balance)", async () => {
        const amount = ether("1");
        await setBalance(await vault.getAddress(), amount - 2n);
        await setup({ totalValue: amount, locked: 1n });
        expect(await dashboard.withdrawableValue()).to.equal(amount - 2n);
      });

      it("returns 0 if no balance, even if totalValue > locked", async () => {
        await setBalance(await vault.getAddress(), 0n);
        const amount = ether("1");
        await setup({ totalValue: amount, locked: amount / 2n });

        expect(await dashboard.withdrawableValue()).to.equal(0n);
      });
    });
  });

  context("transferStVaultOwnership", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).transferVaultOwnership(vaultOwner)).to.be.revertedWithCustomError(
        dashboard,
        "SenderNotMember",
      );
    });

    it("invokes the transferVaultOwnership function on the vault hub if confirmed", async () => {
      const newOwner = certainAddress("dashboard:test:new-owner");
      await dashboard.connect(vaultOwner).transferVaultOwnership(newOwner);
      await expect(dashboard.connect(nodeOperator).transferVaultOwnership(newOwner))
        .to.emit(hub, "Mock__VaultOwnershipTransferred")
        .withArgs(vault, newOwner);
    });
  });

  context("connectAndAcceptTier", () => {
    let newVault: StakingVault;
    let newDashboard: Dashboard;

    beforeEach(async () => {
      const defaultAdminRoles = await Promise.all([
        { role: await dashboard.NODE_OPERATOR_REWARDS_ADJUST_ROLE(), account: nodeOperator.address },
      ]);

      // Create a new vault without hub connection
      const createVaultTx = await factory.createVaultWithDashboardWithoutConnectingToVaultHub(
        vaultOwner.address,
        nodeOperator.address,
        nodeOperator.address,
        nodeOperatorFeeBP,
        confirmExpiry,
        defaultAdminRoles,
      );
      const createVaultReceipt = await createVaultTx.wait();
      if (!createVaultReceipt) throw new Error("Vault creation receipt not found");

      const vaultCreatedEvents = findEvents(createVaultReceipt, "VaultCreated");
      expect(vaultCreatedEvents.length).to.equal(1);

      const newVaultAddress = vaultCreatedEvents[0].args.vault;
      newVault = await ethers.getContractAt("StakingVault", newVaultAddress, vaultOwner);

      const dashboardCreatedEvents = findEvents(createVaultReceipt, "DashboardCreated");
      expect(dashboardCreatedEvents.length).to.equal(1);

      const newDashboardAddress = dashboardCreatedEvents[0].args.dashboard;
      newDashboard = await ethers.getContractAt("Dashboard", newDashboardAddress, vaultOwner);
    });

    it("reverts if called by a non-admin", async () => {
      await expect(newDashboard.connect(stranger).connectAndAcceptTier(1, 1n)).to.be.revertedWithCustomError(
        newDashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if change tier is not confirmed by node operator", async () => {
      await expect(newDashboard.connect(vaultOwner).connectAndAcceptTier(1, 1n)).to.be.revertedWithCustomError(
        newDashboard,
        "TierChangeNotConfirmed",
      );
    });

    it("works", async () => {
      await operatorGrid.connect(nodeOperator).changeTier(newVault, 1, 1n);
      await expect(newDashboard.connect(vaultOwner).connectAndAcceptTier(1, 1n)).to.emit(hub, "Mock__VaultConnected");
    });

    it("works with connection deposit", async () => {
      const connectDeposit = await hub.CONNECT_DEPOSIT();

      await operatorGrid.connect(nodeOperator).changeTier(newVault, 1, 1n);
      await expect(newDashboard.connect(vaultOwner).connectAndAcceptTier(1, 1n, { value: connectDeposit }))
        .to.emit(hub, "Mock__VaultConnected")
        .withArgs(newVault);
    });
  });

  context("voluntaryDisconnect", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).voluntaryDisconnect())
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.VOLUNTARY_DISCONNECT_ROLE());
    });

    it("invokes the voluntaryDisconnect function on the vault hub", async () => {
      await dashboard.connect(vaultOwner).grantRole(await dashboard.VOLUNTARY_DISCONNECT_ROLE(), vaultOwner);
      await expect(dashboard.voluntaryDisconnect()).to.emit(hub, "Mock__VaultDisconnectInitiated").withArgs(vault);
    });
  });

  context("fund", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).fund()).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("invokes the fund function on the vault hub", async () => {
      const amount = ether("1");
      await expect(dashboard.connect(vaultOwner).fund({ value: amount }))
        .to.emit(hub, "Mock__Funded")
        .withArgs(vault, amount);
    });
  });

  context("withdraw", () => {
    beforeEach(async () => {
      await setup({ totalValue: ether("1"), locked: 0n });
      await setBalance(await vault.getAddress(), ether("1"));
    });

    it("reverts if called by a non-admin", async () => {
      await dashboard.connect(vaultOwner).fund({ value: ether("1") });

      await expect(dashboard.connect(stranger).withdraw(vaultOwner, ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("invokes the withdraw function on the vault hub", async () => {
      const amount = ether("1");
      await expect(dashboard.connect(vaultOwner).withdraw(stranger, amount))
        .to.emit(hub, "Mock__Withdrawn")
        .withArgs(vault, stranger, amount);
    });

    it("reverts if the amount is greater than withdrawable ether", async () => {
      await expect(dashboard.connect(vaultOwner).withdraw(stranger, ether("2"))).to.be.revertedWithCustomError(
        dashboard,
        "WithdrawalExceedsWithdrawableValue",
      );
    });
  });

  context("mintShares", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).mintShares(vaultOwner, ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("invokes the mintShares function on the vault hub", async () => {
      const amountShares = ether("1");
      await expect(dashboard.mintShares(vaultOwner, amountShares))
        .to.emit(hub, "Mock__MintedShares")
        .withArgs(vault, vaultOwner, amountShares);
    });

    it("fundable", async () => {
      const amountShares = ether("1");
      const amountFunded = ether("2");
      await expect(dashboard.mintShares(vaultOwner, amountShares, { value: amountFunded }))
        .to.emit(hub, "Mock__Funded")
        .withArgs(vault, amountFunded)
        .and.to.emit(hub, "Mock__MintedShares")
        .withArgs(vault, vaultOwner, amountShares);
    });
  });

  context("burnShares", () => {
    it("reverts if called by a non-admin", async () => {
      const amountShares = ether("1");
      await steth.mintExternalShares(stranger, amountShares);
      await steth.connect(stranger).approve(dashboard, await steth.getPooledEthByShares(amountShares));

      await expect(dashboard.connect(stranger).burnShares(ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("invokes the burnShares function on the vault hub", async () => {
      const amountShares = ether("1");
      await steth.mintExternalShares(vaultOwner, amountShares);
      await steth.connect(vaultOwner).approve(dashboard, await steth.getPooledEthByShares(amountShares));

      await expect(dashboard.burnShares(amountShares)).to.emit(hub, "Mock__BurnedShares").withArgs(vault, amountShares);
    });
  });

  context("mintSteth", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).mintStETH(vaultOwner, ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("invokes the mintStETH function on the vault hub", async () => {
      const amountOfStETH = ether("1");
      await expect(dashboard.mintStETH(vaultOwner, amountOfStETH))
        .to.emit(hub, "Mock__MintedShares")
        .withArgs(vault, vaultOwner, await steth.getSharesByPooledEth(amountOfStETH));
    });

    it("fundable", async () => {
      const amountOfStETH = ether("1");
      const amountFunded = ether("2");
      await expect(dashboard.mintStETH(vaultOwner, amountOfStETH, { value: amountFunded }))
        .to.emit(hub, "Mock__Funded")
        .withArgs(vault, amountFunded)
        .and.to.emit(hub, "Mock__MintedShares")
        .withArgs(vault, vaultOwner, await steth.getSharesByPooledEth(amountOfStETH));
    });

    it("reverts if the amount is less than 1 share", async () => {
      await expect(dashboard.mintStETH(vaultOwner, 1n)).to.be.revertedWithCustomError(hub, "ZeroArgument");
    });
  });

  context("mintWstETH", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).mintWstETH(vaultOwner, ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("invokes the mintShares function on the vault hub", async () => {
      const amountOfwstETH = ether("1");
      await expect(dashboard.mintWstETH(vaultOwner, ether("1")))
        .to.emit(hub, "Mock__MintedShares")
        .withArgs(vault, dashboard, amountOfwstETH)
        .and.to.emit(steth, "Transfer")
        .withArgs(dashboard, wsteth, await steth.getPooledEthBySharesRoundUp(amountOfwstETH))
        .and.to.emit(wsteth, "Transfer")
        .withArgs(dashboard, vaultOwner, amountOfwstETH);

      expect(await wsteth.balanceOf(vaultOwner)).to.equal(amountOfwstETH);
    });

    it("fundable", async () => {
      const amountOfwstETH = ether("1");
      const amountFunded = ether("2");
      await expect(dashboard.mintWstETH(vaultOwner, amountOfwstETH, { value: amountFunded }))
        .to.emit(hub, "Mock__Funded")
        .withArgs(vault, amountFunded)
        .and.to.emit(hub, "Mock__MintedShares")
        .withArgs(vault, dashboard, amountOfwstETH);
      expect(await wsteth.balanceOf(vaultOwner)).to.equal(amountOfwstETH);
    });

    it("reverts if the amount is 0", async () => {
      await expect(dashboard.mintWstETH(vaultOwner, 0n)).to.be.revertedWithCustomError(hub, "ZeroArgument");
    });

    for (let weiWsteth = 1n; weiWsteth <= 3n; weiWsteth++) {
      it(`low amounts of wsteth (${weiWsteth} wei )`, async () => {
        await expect(dashboard.mintWstETH(vaultOwner, weiWsteth))
          .to.emit(hub, "Mock__MintedShares")
          .withArgs(vault, dashboard, weiWsteth);
        expect(await wsteth.balanceOf(vaultOwner)).to.equal(weiWsteth);
      });
    }
  });

  context("burnStETH", () => {
    const amountShares = ether("1");
    let amountSteth: bigint;

    beforeEach(async () => {
      amountSteth = await steth.getPooledEthByShares(amountShares);
      await dashboard.fund({ value: amountSteth });
      await dashboard.mintStETH(vaultOwner, amountSteth);
    });

    it("reverts if called by a non-admin", async () => {
      await steth.mintExternalShares(stranger, amountShares);
      await steth.connect(stranger).approve(dashboard, amountSteth);

      await expect(dashboard.connect(stranger).burnStETH(amountSteth)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("burns steth backed by the vault", async () => {
      expect(await steth.balanceOf(vaultOwner)).to.equal(amountSteth);

      await expect(steth.connect(vaultOwner).approve(dashboard, amountSteth))
        .to.emit(steth, "Approval")
        .withArgs(vaultOwner, dashboard, amountSteth);
      expect(await steth.allowance(vaultOwner, dashboard)).to.equal(amountSteth);

      await expect(dashboard.burnStETH(amountSteth))
        .to.emit(steth, "Transfer") // transfer from owner to hub
        .withArgs(vaultOwner, hub, amountSteth)
        .and.to.emit(steth, "TransferShares") // transfer shares to hub
        .withArgs(vaultOwner, hub, amountShares)
        .and.to.emit(steth, "SharesBurnt") // burn
        .withArgs(hub, amountSteth, amountSteth, amountShares);
      expect(await steth.balanceOf(vaultOwner)).to.equal(0);
    });

    it("does not allow to burn 1 wei stETH", async () => {
      await expect(dashboard.burnStETH(1n)).to.be.revertedWithCustomError(hub, "ZeroArgument");
    });
  });

  context("burnWstETH", () => {
    const amountWsteth = ether("1");

    beforeEach(async () => {
      // mint shares to the vault owner for the burn
      const amountSteth = await steth.getPooledEthByShares(amountWsteth);
      await dashboard.fund({ value: amountSteth });
      await dashboard.mintShares(vaultOwner, amountWsteth);
    });

    it("reverts if called by a non-admin", async () => {
      // get steth
      await steth.mintExternalShares(stranger, amountWsteth + 1000n);
      const amountSteth = await steth.getPooledEthByShares(amountWsteth);
      // get wsteth
      await steth.connect(stranger).approve(wsteth, amountSteth);
      await wsteth.connect(stranger).wrap(amountSteth);
      // burn
      await wsteth.connect(stranger).approve(dashboard, amountWsteth);
      await expect(dashboard.connect(stranger).burnWstETH(amountWsteth)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("burns shares backed by the vault", async () => {
      const amountSteth = await steth.getPooledEthBySharesRoundUp(amountWsteth);
      // approve for wsteth wrap
      await steth.connect(vaultOwner).approve(wsteth, amountSteth);
      // wrap steth to wsteth to get the amount of wsteth for the burn
      await wsteth.connect(vaultOwner).wrap(amountSteth);

      // user flow

      const wstethBalanceBefore = await wsteth.balanceOf(vaultOwner);
      const stethBalanceBefore = await steth.balanceOf(vaultOwner);
      // approve wsteth to dashboard contract
      await wsteth.connect(vaultOwner).approve(dashboard, amountWsteth);

      const result = await dashboard.burnWstETH(amountWsteth);

      await expect(result).to.emit(wsteth, "Transfer").withArgs(vaultOwner, dashboard, amountWsteth); // transfer wsteth to dashboard
      await expect(result).to.emit(steth, "Transfer").withArgs(wsteth, dashboard, amountSteth); // unwrap wsteth to steth
      await expect(result).to.emit(wsteth, "Transfer").withArgs(dashboard, ZeroAddress, amountWsteth); // burn wsteth

      await expect(result).to.emit(steth, "Transfer").withArgs(dashboard, hub, amountSteth); // transfer steth to hub
      await expect(result).to.emit(steth, "TransferShares").withArgs(dashboard, hub, amountWsteth); // transfer shares to hub
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, amountSteth, amountSteth, amountWsteth); // burn steth (mocked event data)

      expect(await steth.balanceOf(vaultOwner)).to.equal(stethBalanceBefore);
      expect(await wsteth.balanceOf(vaultOwner)).to.equal(wstethBalanceBefore - amountWsteth);
    });

    it("reverts on zero burn", async () => {
      await expect(dashboard.burnWstETH(0n)).to.be.revertedWith("wstETH: zero amount unwrap not allowed");
    });

    it(`burns 1-10 wei wsteth with different share rate `, async () => {
      const baseTotalEther = ether("1000000");
      await steth.mock__setTotalPooledEther(baseTotalEther);
      await steth.mock__setTotalShares(baseTotalEther);

      const wstethContract = wsteth.connect(vaultOwner);

      const totalEtherStep = baseTotalEther / 10n;
      const totalEtherMax = baseTotalEther * 2n;

      for (let totalEther = baseTotalEther; totalEther <= totalEtherMax; totalEther += totalEtherStep) {
        for (let weiShare = 1n; weiShare <= 10n; weiShare++) {
          await steth.mock__setTotalPooledEther(totalEther);

          // this is only used for correct steth value when wrapping to receive share==wsteth
          const weiStethUp = await steth.getPooledEthBySharesRoundUp(weiShare);
          // steth value actually used by wsteth inside the contract
          const weiStethDown = await steth.getPooledEthByShares(weiShare);
          // this share amount that is returned from wsteth on unwrap
          // because wsteth eats 1 share due to "rounding" (being a hungry-hungry wei gobler)
          const weiShareDown = await steth.getSharesByPooledEth(weiStethDown);
          // steth value occurring only in events when rounding down from weiShareDown
          const weiStethDownDown = await steth.getPooledEthByShares(weiShareDown);

          // approve for wsteth wrap
          await steth.connect(vaultOwner).approve(wsteth, weiStethUp);
          // wrap steth to wsteth to get the amount of wsteth for the burn
          await wstethContract.wrap(weiStethUp);

          expect(await wsteth.balanceOf(vaultOwner)).to.equal(weiShare);
          const stethBalanceBefore = await steth.balanceOf(vaultOwner);

          // approve wsteth to dashboard contract
          await wstethContract.approve(dashboard, weiShare);

          // reverts when rounding to zero
          // this condition is excessive but illustrative
          if (weiShareDown === 0n && weiShare == 1n) {
            await expect(dashboard.burnWstETH(weiShare)).to.be.revertedWithCustomError(hub, "ZeroArgument");
            // clean up wsteth
            await wstethContract.transfer(stranger, await wstethContract.balanceOf(vaultOwner));
            continue;
          }

          const result = await dashboard.burnWstETH(weiShare);

          // transfer wsteth from sender
          await expect(result).to.emit(wsteth, "Transfer").withArgs(vaultOwner, dashboard, weiShare); // transfer wsteth to dashboard
          // unwrap wsteth to steth
          await expect(result).to.emit(steth, "Transfer").withArgs(wsteth, dashboard, weiStethDown); // unwrap wsteth to steth
          await expect(result).to.emit(wsteth, "Transfer").withArgs(dashboard, ZeroAddress, weiShare); // burn wsteth
          // transfer shares to hub
          await expect(result).to.emit(steth, "Transfer").withArgs(dashboard, hub, weiStethDownDown);
          await expect(result).to.emit(steth, "TransferShares").withArgs(dashboard, hub, weiShareDown);
          // burn shares in the hub
          await expect(result)
            .to.emit(steth, "SharesBurnt")
            .withArgs(hub, weiStethDownDown, weiStethDownDown, weiShareDown);

          expect(await steth.balanceOf(vaultOwner)).to.equal(stethBalanceBefore);

          // no dust left over
          expect(await wsteth.balanceOf(vaultOwner)).to.equal(0n);
        }
      }
    });
  });

  context("rebalanceVault", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).rebalanceVault(ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("invokes the rebalance function on the vault hub", async () => {
      const amount = ether("1");
      await expect(dashboard.rebalanceVault(amount)).to.emit(hub, "Mock__Rebalanced").withArgs(vault, amount);
    });

    it("fundable", async () => {
      const amount = ether("1");
      await expect(dashboard.rebalanceVault(amount, { value: amount }))
        .to.emit(hub, "Mock__Funded")
        .withArgs(vault, amount)
        .and.to.emit(hub, "Mock__Rebalanced")
        .withArgs(vault, amount);
    });
  });

  context("proveUnknownValidatorsToPDG", () => {
    const witnesses = [
      {
        proof: ["0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
        pubkey: "0x",
        validatorIndex: 0n,
        childBlockTimestamp: 0n,
        slot: 0n,
        proposerIndex: 0n,
      },
    ];

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).proveUnknownValidatorsToPDG(witnesses)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("proves unknown validators to PDG", async () => {
      await expect(dashboard.proveUnknownValidatorsToPDG(witnesses)).to.emit(hub, "Mock__ValidatorProvedToPDG");
    });
  });

  context("compensateDisprovenPredepositFromPDG", () => {
    let pdgWithdrawalSigner: HardhatEthersSigner;

    beforeEach(async () => {
      pdgWithdrawalSigner = await impersonate(certainAddress("pdg-withdrawal-signer"), ether("1"));
      await dashboard.grantRole(await dashboard.PDG_COMPENSATE_PREDEPOSIT_ROLE(), pdgWithdrawalSigner);
    });

    it("reverts if called not by a PDG_COMPENSATE_PREDEPOSIT_ROLE", async () => {
      await expect(
        dashboard.connect(stranger).compensateDisprovenPredepositFromPDG(new Uint8Array(), vaultOwner),
      ).to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");
    });

    it("calls the PDG contract to compensate the disproven predeposit", async () => {
      const pubkey = new Uint8Array(32);
      pubkey[0] = 1;

      await expect(
        dashboard.connect(pdgWithdrawalSigner).compensateDisprovenPredepositFromPDG(pubkey, pdgWithdrawalSigner),
      )
        .to.emit(hub, "Mock__CompensatedDisprovenPredepositFromPDG")
        .withArgs(vault, pubkey, pdgWithdrawalSigner);
    });
  });

  context("recover", async () => {
    const amount = ether("1");

    beforeEach(async () => {
      const wethContract = weth.connect(vaultOwner);
      await wethContract.deposit({ value: amount });
      await wethContract.transfer(dashboard, amount);
      await erc721.mint(dashboard, 0);
      await dashboard.grantRole(await dashboard.RECOVER_ASSETS_ROLE(), vaultOwner);

      expect(await wethContract.balanceOf(dashboard)).to.equal(amount);
      expect(await erc721.ownerOf(0)).to.equal(dashboard);
    });

    it("allows only RECOVER_ASSETS_ROLE to recover", async () => {
      await expect(dashboard.connect(stranger).recoverERC20(ZeroAddress, vaultOwner, 1n)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
      await expect(
        dashboard.connect(stranger).recoverERC721(erc721.getAddress(), 0, vaultOwner),
      ).to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");
    });

    it("does not allow zero arguments for erc20 recovery", async () => {
      await expect(dashboard.recoverERC20(ZeroAddress, vaultOwner, 1n)).to.be.revertedWithCustomError(
        dashboard,
        "ZeroArgument",
      );
      await expect(dashboard.recoverERC20(weth, ZeroAddress, 1n)).to.be.revertedWithCustomError(
        dashboard,
        "ZeroArgument",
      );
      await expect(dashboard.recoverERC20(weth, vaultOwner, 0n)).to.be.revertedWithCustomError(
        dashboard,
        "ZeroArgument",
      );
    });

    it("does not allow zero arguments for erc721 recovery", async () => {
      await expect(dashboard.recoverERC721(ZeroAddress, 0n, ZeroAddress))
        .to.be.revertedWithCustomError(dashboard, "ZeroArgument")
        .withArgs("_token");

      await expect(dashboard.recoverERC721(erc721.getAddress(), 0n, ZeroAddress))
        .to.be.revertedWithCustomError(dashboard, "ZeroArgument")
        .withArgs("_recipient");
    });

    it("recovers all weth", async () => {
      const preBalance = await weth.balanceOf(vaultOwner);
      const tx = await dashboard.recoverERC20(weth.getAddress(), vaultOwner, amount);

      await expect(tx)
        .to.emit(dashboard, "ERC20Recovered")
        .withArgs(tx.from, await weth.getAddress(), amount);
      expect(await weth.balanceOf(dashboard)).to.equal(0);
      expect(await weth.balanceOf(vaultOwner)).to.equal(preBalance + amount);
    });

    it("does not allow zero token address for erc721 recovery", async () => {
      await expect(dashboard.recoverERC721(ZeroAddress, 0, vaultOwner)).to.be.revertedWithCustomError(
        dashboard,
        "ZeroArgument",
      );
    });

    it("recovers erc721", async () => {
      const tx = await dashboard.recoverERC721(erc721.getAddress(), 0, vaultOwner);

      await expect(tx)
        .to.emit(dashboard, "ERC721Recovered")
        .withArgs(tx.from, await erc721.getAddress(), 0);

      expect(await erc721.ownerOf(0)).to.equal(vaultOwner.address);
    });
  });

  context("fallback/receive behavior", () => {
    const amount = ether("1");

    it("does not allow fallback behavior", async () => {
      const tx = vaultOwner.sendTransaction({ to: dashboard, data: "0x111111111111", value: amount });
      await expect(tx).to.be.revertedWithoutReason();
    });

    it("receive funds the vault", async () => {
      const tx = vaultOwner.sendTransaction({ to: dashboard, value: amount });
      await expect(tx).to.emit(hub, "Mock__Funded").withArgs(vault, amount);
    });
  });

  context("pauseBeaconChainDeposits", () => {
    it("reverts if the caller is not a curator", async () => {
      await expect(dashboard.connect(stranger).pauseBeaconChainDeposits()).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("pauses the beacon deposits", async () => {
      await expect(dashboard.pauseBeaconChainDeposits()).to.emit(hub, "Mock__BeaconChainDepositsPaused");
    });
  });

  context("resumeBeaconChainDeposits", () => {
    it("reverts if the caller is not a curator", async () => {
      await expect(dashboard.connect(stranger).resumeBeaconChainDeposits()).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("resumes the beacon deposits", async () => {
      await expect(dashboard.resumeBeaconChainDeposits()).to.emit(hub, "Mock__BeaconChainDepositsResumed");
    });
  });

  context("requestValidatorExit", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).requestValidatorExit("0x")).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("signals the requested exit of a validator", async () => {
      await expect(dashboard.requestValidatorExit("0x")).to.emit(hub, "Mock__ValidatorExitRequested");
    });
  });

  context("triggerValidatorWithdrawal", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(
        dashboard.connect(stranger).triggerValidatorWithdrawals("0x", [0n], vaultOwner),
      ).to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");
    });

    it("requests a full validator withdrawal", async () => {
      const validatorPublicKeys = randomValidatorPubkey();
      const amounts = [0n]; // 0 amount means full withdrawal

      await expect(
        dashboard.triggerValidatorWithdrawals(validatorPublicKeys, amounts, vaultOwner, {
          value: EIP7002_MIN_WITHDRAWAL_REQUEST_FEE,
        }),
      ).to.emit(hub, "Mock__ValidatorWithdrawalsTriggered");
    });

    it("requests a partial validator withdrawal", async () => {
      const validatorPublicKeys = randomValidatorPubkey();
      const amounts = [ether("0.1")];

      await expect(
        dashboard.triggerValidatorWithdrawals(validatorPublicKeys, amounts, vaultOwner, {
          value: EIP7002_MIN_WITHDRAWAL_REQUEST_FEE,
        }),
      ).to.emit(hub, "Mock__ValidatorWithdrawalsTriggered");
    });
  });

  context("role management", () => {
    let assignments: Permissions.RoleAssignmentStruct[];

    beforeEach(async () => {
      assignments = [
        { role: await dashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(), account: vaultOwner.address },
        { role: await dashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(), account: vaultOwner.address },
      ];
    });

    context("grantRoles", () => {
      it("reverts when assignments array is empty", async () => {
        await expect(dashboard.grantRoles([])).to.be.revertedWithCustomError(dashboard, "ZeroArgument");
      });

      it("grants roles to multiple accounts", async () => {
        await dashboard.grantRoles(assignments);

        for (const assignment of assignments) {
          expect(await dashboard.hasRole(assignment.role, assignment.account)).to.be.true;
        }
      });
    });

    context("revokeRoles", () => {
      beforeEach(async () => {
        await dashboard.grantRoles(assignments);
      });

      it("reverts when assignments array is empty", async () => {
        await expect(dashboard.revokeRoles([])).to.be.revertedWithCustomError(dashboard, "ZeroArgument");
      });

      it("revokes roles from multiple accounts", async () => {
        await dashboard.revokeRoles(assignments);

        for (const assignment of assignments) {
          expect(await dashboard.hasRole(assignment.role, assignment.account)).to.be.false;
        }
      });
    });
  });
});
