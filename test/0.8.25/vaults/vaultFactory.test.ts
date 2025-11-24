import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Dashboard,
  DepositContract__MockForBeaconChainDepositor,
  LazyOracle__MockForNodeOperatorFee,
  LidoLocator,
  OperatorGrid,
  PredepositGuarantee__HarnessForFactory,
  StakingVault,
  StakingVault__HarnessForTestUpgrade,
  StETH__HarnessForVaultHub,
  UpgradeableBeacon,
  VaultFactory,
  VaultHub,
  WstETH__Harness,
} from "typechain-types";

import { days, ether, GENESIS_FORK_VERSION, randomAddress } from "lib";
import { createVaultProxy } from "lib/protocol/helpers";
import { createVaultProxyWithoutConnectingToVaultHub } from "lib/protocol/helpers/vaults";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot, VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

describe("VaultFactory.sol", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let vaultOwner1: HardhatEthersSigner;
  let vaultOwner2: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let beacon: UpgradeableBeacon;
  let vaultHub: VaultHub;
  let vaultImpl: StakingVault;
  let vaultImplUpgrade: StakingVault__HarnessForTestUpgrade;
  let dashboardImpl: Dashboard;

  let vaultFactory: VaultFactory;

  let steth: StETH__HarnessForVaultHub;
  let wsteth: WstETH__Harness;

  let locator: LidoLocator;
  let operatorGrid: OperatorGrid;
  let operatorGridImpl: OperatorGrid;
  let lazyOracle: LazyOracle__MockForNodeOperatorFee;
  let predepositGuarantee: PredepositGuarantee__HarnessForFactory;

  let originalState: string;

  before(async () => {
    [deployer, admin, holder, operator, stranger, vaultOwner1, vaultOwner2] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [holder], {
      value: ether("10.0"),
      from: deployer,
    });
    wsteth = await ethers.deployContract("WstETH__Harness", [steth]);

    //predeposit guarantee
    predepositGuarantee = await ethers.deployContract("PredepositGuarantee__HarnessForFactory", [
      GENESIS_FORK_VERSION,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      0,
    ]);

    lazyOracle = await ethers.deployContract("LazyOracle__MockForNodeOperatorFee");

    locator = await deployLidoLocator({
      lido: steth,
      wstETH: wsteth,
      predepositGuarantee: predepositGuarantee,
      lazyOracle,
    });

    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);

    // OperatorGrid
    operatorGridImpl = await ethers.deployContract("OperatorGrid", [locator], { from: deployer });
    const operatorGridProxy = await ethers.deployContract(
      "OssifiableProxy",
      [operatorGridImpl, deployer, new Uint8Array()],
      deployer,
    );
    operatorGrid = await ethers.getContractAt("OperatorGrid", operatorGridProxy, deployer);

    const defaultTierParams = {
      shareLimit: ether("1"),
      reserveRatioBP: 2000n,
      forcedRebalanceThresholdBP: 1800n,
      infraFeeBP: 500n,
      liquidityFeeBP: 400n,
      reservationFeeBP: 100n,
    };
    await operatorGrid.initialize(admin, defaultTierParams);
    await operatorGrid.connect(admin).grantRole(await operatorGrid.REGISTRY_ROLE(), admin);

    // Accounting
    const vaultHubImpl = await ethers.deployContract("VaultHub", [
      locator,
      steth,
      randomAddress(),
      VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP,
    ]);
    const vaultHubProxy = await ethers.deployContract(
      "OssifiableProxy",
      [vaultHubImpl, admin, new Uint8Array()],
      admin,
    );
    vaultHub = await ethers.getContractAt("VaultHub", vaultHubProxy, deployer);
    await vaultHub.initialize(admin);

    //vault implementation
    vaultImpl = await ethers.deployContract("StakingVault", [depositContract]);
    vaultImplUpgrade = await ethers.deployContract("StakingVault__HarnessForTestUpgrade", [depositContract]);

    //beacon
    beacon = await ethers.deployContract("UpgradeableBeacon", [vaultImpl, admin]);

    dashboardImpl = await ethers.deployContract("Dashboard", [steth, wsteth, vaultHub, locator]);
    vaultFactory = await ethers.deployContract("VaultFactory", [locator, beacon, dashboardImpl, ZeroAddress]);

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultHub, operatorGrid, vaultFactory });

    //the initialize() function cannot be called on a contract
    await expect(vaultImpl.initialize(stranger, operator, predepositGuarantee)).to.revertedWithCustomError(
      vaultImpl,
      "InvalidInitialization",
    );
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    context("UpgradeableBeacon", () => {
      it("reverts if `_owner` is zero address", async () => {
        await expect(ethers.deployContract("UpgradeableBeacon", [ZeroAddress, admin], { from: deployer }))
          .to.be.revertedWithCustomError(beacon, "BeaconInvalidImplementation")
          .withArgs(ZeroAddress);
      });

      it("reverts if `_owner` is zero address", async () => {
        await expect(ethers.deployContract("UpgradeableBeacon", [vaultImpl, ZeroAddress], { from: deployer }))
          .to.be.revertedWithCustomError(beacon, "OwnableInvalidOwner")
          .withArgs(ZeroAddress);
      });

      it("works and emit `OwnershipTransferred`, `Upgraded` events", async () => {
        const tx = beacon.deploymentTransaction();

        await expect(tx)
          .to.emit(beacon, "OwnershipTransferred")
          .withArgs(ZeroAddress, await admin.getAddress());
        await expect(tx)
          .to.emit(beacon, "Upgraded")
          .withArgs(await vaultImpl.getAddress());
      });
    });

    context("VaultFactory", () => {
      it("reverts if `_lidoLocator` is zero address", async () => {
        await expect(
          ethers.deployContract("VaultFactory", [ZeroAddress, beacon, dashboardImpl, ZeroAddress], { from: deployer }),
        )
          .to.be.revertedWithCustomError(vaultFactory, "ZeroArgument")
          .withArgs("_lidoLocator");
      });

      it("reverts if `_beacon` is zero address", async () => {
        await expect(
          ethers.deployContract("VaultFactory", [locator, ZeroAddress, dashboardImpl, ZeroAddress], {
            from: deployer,
          }),
        )
          .to.be.revertedWithCustomError(vaultFactory, "ZeroArgument")
          .withArgs("_beacon");
      });

      it("reverts if `_dashboard` is zero address", async () => {
        await expect(
          ethers.deployContract("VaultFactory", [locator, beacon, ZeroAddress, ZeroAddress], { from: deployer }),
        )
          .to.be.revertedWithCustomError(vaultFactory, "ZeroArgument")
          .withArgs("_dashboardImpl");
      });
    });
  });

  context("getters", () => {
    it("returns the addresses of the LidoLocator, Beacon, DashboardImpl, and PreviousFactory", async () => {
      expect(await vaultFactory.LIDO_LOCATOR()).to.eq(await locator.getAddress());
      expect(await vaultFactory.BEACON()).to.eq(await beacon.getAddress());
      expect(await vaultFactory.DASHBOARD_IMPL()).to.eq(await dashboardImpl.getAddress());
      expect(await vaultFactory.PREVIOUS_FACTORY()).to.eq(ZeroAddress);
    });
  });

  context("deployedVaults()", () => {
    let vault: StakingVault;
    beforeEach(async () => {
      ({ vault } = await createVaultProxy(vaultOwner1, vaultFactory, vaultOwner1, operator));
    });

    it("returns true if the vault was deployed by this factory", async () => {
      expect(await vaultFactory.deployedVaults(vault)).to.be.true;
    });

    it("newFactory returns true if the vault was deployed by the previous factory", async () => {
      const newFactory = await ethers.deployContract("VaultFactory", [locator, beacon, dashboardImpl, vaultFactory]);
      expect(await newFactory.deployedVaults(vault)).to.be.true;

      const { vault: anotherVault } = await createVaultProxyWithoutConnectingToVaultHub(
        vaultOwner1,
        newFactory,
        vaultOwner1,
        operator,
      );
      expect(await newFactory.deployedVaults(anotherVault)).to.be.true;
    });
  });

  context("createVaultWithDashboard", () => {
    it("reverts if no value is sent", async () => {
      await expect(
        vaultFactory.connect(vaultOwner1).createVaultWithDashboard(vaultOwner1, operator, operator, 200n, days(7n), []),
      ).to.revertedWithCustomError(vaultFactory, "InsufficientFunds");
    });

    it("reverts if trying to assign a role that is not a sub-role of the DEFAULT_ADMIN_ROLE", async () => {
      await expect(
        createVaultProxy(vaultOwner1, vaultFactory, vaultOwner1, operator, operator, 200n, days(7n), [
          { role: await dashboardImpl.NODE_OPERATOR_FEE_EXEMPT_ROLE(), account: vaultOwner1.address },
        ]),
      ).to.revertedWithCustomError(dashboardImpl, "AccessControlUnauthorizedAccount");
    });

    it("works with empty `roleAssignments`", async () => {
      const { tx, vault, dashboard } = await createVaultProxy(vaultOwner1, vaultFactory, vaultOwner1, operator);

      await expect(tx)
        .to.emit(vaultFactory, "VaultCreated")
        .withArgs(vault)
        .and.to.emit(vaultFactory, "DashboardCreated")
        .withArgs(dashboard, vault, vaultOwner1);

      expect(await vaultFactory.deployedVaults(vault)).to.be.true;
      expect((await vaultHub.vaultConnection(vault)).owner).to.eq(dashboard);
    });

    it("check `version()`", async () => {
      const { vault } = await createVaultProxy(vaultOwner1, vaultFactory, vaultOwner1, operator);
      expect(await vaultFactory.deployedVaults(vault)).to.be.true;
      expect(await vault.version()).to.eq(1);
    });
  });

  context("upgradeability", () => {
    it("vaults can be upgraded", async () => {
      const vaultsBefore = await vaultHub.vaultsCount();
      expect(vaultsBefore).to.eq(0);

      //create vaults
      const {
        vault: vault1,
        proxy: proxy1,
        dashboard: dashboard1,
      } = await createVaultProxy(vaultOwner1, vaultFactory, vaultOwner1, operator, operator, 200n, days(7n), []);
      const { vault: vault2, dashboard: dashboard2 } = await createVaultProxy(
        vaultOwner2,
        vaultFactory,
        vaultOwner2,
        operator,
        operator,
        200n,
        days(7n),
        [],
      );

      const vaultConnection1 = await vaultHub.vaultConnection(vault1);
      const vaultConnection2 = await vaultHub.vaultConnection(vault2);

      //owner of vault is delegator
      expect(await dashboard1.getAddress()).to.eq(vaultConnection1.owner);
      expect(await dashboard2.getAddress()).to.eq(vaultConnection2.owner);

      const vaultsAfter = await vaultHub.vaultsCount();
      expect(vaultsAfter).to.eq(2);

      const version1Before = await vault1.version();
      const version2Before = await vault2.version();

      const proxy1ImplBefore = await proxy1.implementation();

      const implBefore = await beacon.implementation();
      expect(implBefore).to.eq(await vaultImpl.getAddress());
      expect(proxy1ImplBefore).to.eq(await vaultImpl.getAddress());

      //upgrade beacon to new implementation
      await beacon.connect(admin).upgradeTo(vaultImplUpgrade);

      const implAfter = await beacon.implementation();
      expect(implAfter).to.eq(await vaultImplUpgrade.getAddress());

      //create new vault with new implementation
      const { vault: vault3 } = await createVaultProxy(
        vaultOwner1,
        vaultFactory,
        vaultOwner1,
        operator,
        operator,
        200n,
        days(7n),
        [],
      );

      const proxy1ImplAfter = await proxy1.implementation();
      expect(proxy1ImplAfter).to.eq(await vaultImplUpgrade.getAddress());

      const vault1WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault1, deployer);
      const vault2WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault2, deployer);
      const vault3WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault3, deployer);

      //finalize first vault
      await vault1WithNewImpl.finalizeUpgrade_v2();

      //try to initialize the second vault
      await expect(vault2WithNewImpl.initialize(admin, operator, predepositGuarantee)).to.revertedWithCustomError(
        vault2WithNewImpl,
        "VaultAlreadyInitialized",
      );

      const version1After = await vault1WithNewImpl.version();
      const version2After = await vault2WithNewImpl.version();
      const version3After = await vault3WithNewImpl.version();

      const version1AfterV2 = await vault1WithNewImpl.getInitializedVersion();
      const version2AfterV2 = await vault2WithNewImpl.getInitializedVersion();
      const version3AfterV2 = await vault3WithNewImpl.getInitializedVersion();

      expect(version1Before).to.eq(1);
      expect(version1After).to.eq(2);
      expect(version1AfterV2).to.eq(2);

      expect(version2Before).to.eq(1);
      expect(version2After).to.eq(2);
      expect(version2AfterV2).to.eq(1);

      expect(version3After).to.eq(2);
      expect(version3AfterV2).to.eq(2);
    });
  });

  context("After upgrade", () => {
    it("exists vaults - init not works, finalize works ", async () => {
      const { vault: vault1 } = await createVaultProxy(vaultOwner1, vaultFactory, vaultOwner1, operator);

      await beacon.connect(admin).upgradeTo(vaultImplUpgrade);

      const vault1WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault1, deployer);

      await expect(vault1.initialize(ZeroAddress, ZeroAddress, ZeroAddress)).to.revertedWithCustomError(
        vault1WithNewImpl,
        "VaultAlreadyInitialized",
      );
      await expect(vault1WithNewImpl.finalizeUpgrade_v2()).to.emit(vault1WithNewImpl, "InitializedV2");
    });

    it("new vaults - init works, finalize not works ", async () => {
      await beacon.connect(admin).upgradeTo(vaultImplUpgrade);

      const { vault: vault2 } = await createVaultProxy(vaultOwner1, vaultFactory, vaultOwner1, operator);

      const vault2WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault2, deployer);

      await expect(vault2.initialize(ZeroAddress, ZeroAddress, ZeroAddress)).to.revertedWithCustomError(
        vault2WithNewImpl,
        "InvalidInitialization",
      );
      await expect(vault2WithNewImpl.finalizeUpgrade_v2()).to.revertedWithCustomError(
        vault2WithNewImpl,
        "InvalidInitialization",
      );
    });
  });

  context("createVaultWithDashboardWithoutConnectingToVaultHub", () => {
    it("works with roles assigned by node operator manager", async () => {
      const { vault, dashboard } = await createVaultProxyWithoutConnectingToVaultHub(
        vaultOwner1,
        vaultFactory,
        vaultOwner1,
        operator,
        operator,
        200n,
        days(7n),
        [
          {
            role: await dashboardImpl.NODE_OPERATOR_FEE_EXEMPT_ROLE(),
            account: stranger,
          },
        ],
      );

      expect(await vaultFactory.deployedVaults(vault)).to.be.true;
      expect(await dashboard.feeRecipient()).to.eq(operator);
      expect(await vaultHub.isVaultConnected(vault)).to.be.false;
    });

    it("works with empty roles", async () => {
      const { vault, dashboard } = await createVaultProxyWithoutConnectingToVaultHub(
        operator,
        vaultFactory,
        vaultOwner1,
        operator,
      );

      expect(await dashboard.hasRole(await dashboard.DEFAULT_ADMIN_ROLE(), vaultOwner1)).to.eq(true);
      expect(await vaultFactory.deployedVaults(vault)).to.be.true;
      expect(await dashboard.feeRecipient()).to.eq(operator);
      expect(await vaultHub.isVaultConnected(vault)).to.be.false;
    });

    it("reverts if node operator manager try to assign default admin sub-role", async () => {
      await expect(
        createVaultProxyWithoutConnectingToVaultHub(
          vaultOwner1,
          vaultFactory,
          vaultOwner1,
          operator,
          operator,
          200n,
          days(7n),
          [
            {
              role: await dashboardImpl.WITHDRAW_ROLE(),
              account: operator,
            },
          ],
        ),
      ).to.revertedWithCustomError(dashboardImpl, "AccessControlUnauthorizedAccount");
    });
  });
});
