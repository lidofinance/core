import { expect } from "chai";
import { Signer, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import {
  Initializable__Mock,
  Initializable__Mock__factory,
  OssifiableProxy,
  OssifiableProxy__factory,
} from "typechain-types";

import { Snapshot } from "test/suite";

describe("OssifiableProxy", () => {
  let admin: Signer;
  let stranger: Signer;
  let currentImpl: Initializable__Mock;
  let proxy: OssifiableProxy;
  let snapshot: string;
  let initPayload: string;
  let initializableContract: Initializable__Mock__factory;
  let ossifiableProxy: OssifiableProxy__factory;

  async function takeSnapshot() {
    snapshot = await Snapshot.take();
  }

  async function rollback() {
    await Snapshot.restore(snapshot);
  }

  beforeEach(async () => {
    [admin, stranger] = await ethers.getSigners();
    initializableContract = await ethers.getContractFactory("Initializable__Mock");
    ossifiableProxy = await ethers.getContractFactory("OssifiableProxy");

    currentImpl = await initializableContract.deploy();
    proxy = await ossifiableProxy.deploy(await currentImpl.getAddress(), await admin.getAddress(), "0x");

    initPayload = currentImpl.interface.encodeFunctionData("initialize", [1]);
  });

  before(takeSnapshot);
  after(rollback);

  describe("deploy", () => {
    it("with empty calldata", async () => {
      currentImpl = await initializableContract.deploy();
      proxy = await ossifiableProxy.deploy(await currentImpl.getAddress(), await admin.getAddress(), "0x");

      const tx = proxy.deploymentTransaction();
      const implInterfaceOnProxyAddr = currentImpl.attach(await proxy.getAddress()) as Initializable__Mock;

      await expect(tx)
        .to.emit(proxy, "Upgraded")
        .withArgs(await currentImpl.getAddress());

      expect(await implInterfaceOnProxyAddr.version()).to.equal(0);
    });

    it("with calldata", async () => {
      currentImpl = await initializableContract.deploy();
      proxy = await ossifiableProxy.deploy(await currentImpl.getAddress(), await admin.getAddress(), initPayload);

      const tx = proxy.deploymentTransaction();
      const implInterfaceOnProxyAddr = currentImpl.attach(await proxy.getAddress()) as Initializable__Mock;

      await expect(tx)
        .to.emit(proxy, "Upgraded")
        .withArgs(await currentImpl.getAddress())
        .and.to.emit(implInterfaceOnProxyAddr, "Initialized")
        .withArgs(1);

      expect(await implInterfaceOnProxyAddr.version()).to.equal(1);
    });
  });

  describe("getters", () => {
    it("proxy__getAdmin()", async () => {
      expect(await proxy.proxy__getAdmin()).to.equal(await admin.getAddress());
    });

    it("proxy__getImplementation()", async () => {
      expect(await proxy.proxy__getImplementation()).to.equal(await currentImpl.getAddress());
    });

    it("proxy__getIsOssified()", async () => {
      expect(await proxy.proxy__getIsOssified()).to.be.false;
    });
  });

  describe("proxy__ossify()", () => {
    it("should ossify the proxy when called by admin", async () => {
      await expect(proxy.connect(admin).proxy__ossify()).to.emit(proxy, "ProxyOssified");
      expect(await proxy.proxy__getIsOssified()).to.be.true;
    });

    it("should fail to ossify the proxy when called by a stranger", async () => {
      await expect(proxy.connect(stranger).proxy__ossify()).to.be.revertedWithCustomError(proxy, "NotAdmin()");
    });

    it("ossifies proxy", async () => {
      await expect(proxy.connect(admin).proxy__ossify())
        .to.emit(proxy, "ProxyOssified")
        .and.to.emit(proxy, "AdminChanged")
        .withArgs(admin.getAddress(), ZeroAddress);

      expect(await proxy.proxy__getIsOssified()).to.be.true;
      expect(await proxy.proxy__getAdmin()).to.be.equal(ZeroAddress);
    });
  });

  describe("proxy__changeAdmin()", () => {
    it("should fail to change admin when called by a stranger", async () => {
      const newAdmin = stranger;
      await expect(
        proxy.connect(stranger).proxy__changeAdmin(await newAdmin.getAddress()),
      ).to.be.revertedWithCustomError(proxy, "NotAdmin()");
    });

    it("should fail to change admin if proxy is ossified", async () => {
      await proxy.connect(admin).proxy__ossify();
      const newAdmin = stranger;
      await expect(proxy.connect(admin).proxy__changeAdmin(await newAdmin.getAddress())).to.be.revertedWithCustomError(
        proxy,
        "ProxyIsOssified()",
      );
    });

    it("should change admin when called by current admin", async () => {
      const newAdmin = stranger;
      await expect(proxy.connect(admin).proxy__changeAdmin(await newAdmin.getAddress()))
        .to.emit(proxy, "AdminChanged")
        .withArgs(await admin.getAddress(), await newAdmin.getAddress());

      expect(await proxy.proxy__getAdmin()).to.equal(await newAdmin.getAddress());

      await expect(proxy.connect(admin).proxy__changeAdmin(admin.getAddress())).to.be.revertedWithCustomError(
        proxy,
        "NotAdmin()",
      );
    });

    it("should fail to change admin to zero address", async () => {
      const newAdmin = ZeroAddress;
      await expect(proxy.connect(admin).proxy__changeAdmin(newAdmin)).to.be.revertedWith(
        "ERC1967: new admin is the zero address",
      );
    });
  });

  describe("proxy__upgradeTo()", () => {
    it('reverts with error "NotAdmin()" called by stranger', async () => {
      await expect(
        proxy.connect(stranger).proxy__upgradeTo(await currentImpl.getAddress()),
      ).to.be.revertedWithCustomError(proxy, "NotAdmin()");
    });

    it('reverts with error "ProxyIsOssified()" when called on ossified proxy', async () => {
      await proxy.connect(admin).proxy__ossify();

      expect(await proxy.proxy__getIsOssified()).to.be.true;

      await expect(proxy.connect(admin).proxy__upgradeTo(await currentImpl.getAddress())).to.be.revertedWithCustomError(
        proxy,
        "ProxyIsOssified()",
      );
    });

    it("upgrades proxy to new implementation", async () => {
      const NewImplementation = await ethers.getContractFactory("Initializable__Mock", admin);
      const newImpl = await NewImplementation.deploy();

      const tx = await proxy.connect(admin).proxy__upgradeTo(await newImpl.getAddress());

      await expect(tx)
        .to.emit(proxy, "Upgraded")
        .withArgs(await newImpl.getAddress());

      expect(await proxy.proxy__getImplementation()).to.equal(await newImpl.getAddress());
    });
  });

  describe("proxy__upgradeToAndCall()", () => {
    it('reverts with error "NotAdmin()" when called by stranger', async () => {
      await expect(
        proxy.connect(stranger).proxy__upgradeToAndCall(await currentImpl.getAddress(), initPayload, false),
      ).to.be.revertedWithCustomError(proxy, "NotAdmin()");
    });

    it('reverts with error "ProxyIsOssified()" when called on ossified proxy', async () => {
      await proxy.connect(admin).proxy__ossify();

      expect(await proxy.proxy__getIsOssified()).to.be.true;

      await expect(
        proxy.connect(admin).proxy__upgradeToAndCall(await currentImpl.getAddress(), initPayload, false),
      ).to.be.revertedWithCustomError(proxy, "ProxyIsOssified()");
    });

    it("upgrades proxy to new implementation when forceCall is false", async () => {
      const NewImplementation = await ethers.getContractFactory("Initializable__Mock", admin);
      const newImpl = await NewImplementation.deploy();
      await newImpl.waitForDeployment();

      const tx = await proxy.connect(admin).proxy__upgradeToAndCall(await newImpl.getAddress(), initPayload, false);
      const implInterfaceOnProxyAddr = newImpl.attach(await proxy.getAddress()) as Initializable__Mock;

      await tx.wait();

      await expect(tx)
        .to.emit(proxy, "Upgraded")
        .withArgs(await newImpl.getAddress())
        .and.to.emit(implInterfaceOnProxyAddr, "Initialized")
        .withArgs(1);

      expect(await proxy.proxy__getImplementation()).to.equal(await newImpl.getAddress());
      expect(await implInterfaceOnProxyAddr.version()).to.equal(1);
    });

    it("upgrades proxy to new implementation when forceCall is true", async () => {
      const NewImplementation = await ethers.getContractFactory("Initializable__Mock", admin);
      const newImpl = await NewImplementation.deploy();

      await newImpl.waitForDeployment();

      const tx = await proxy.connect(admin).proxy__upgradeToAndCall(await newImpl.getAddress(), "0x", true);
      const implInterfaceOnProxyAddr = newImpl.attach(await proxy.getAddress()) as Initializable__Mock;

      await tx.wait();
      await expect(tx)
        .to.emit(proxy, "Upgraded")
        .withArgs(await newImpl.getAddress())
        .and.to.emit(implInterfaceOnProxyAddr, "ReceiveCalled");

      expect(await proxy.proxy__getImplementation()).to.equal(await newImpl.getAddress());
      expect(await implInterfaceOnProxyAddr.version()).to.equal(0);
    });
  });
});
