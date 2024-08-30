import { expect } from "chai";
import { Signer, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { Initializable__Mock, OssifiableProxy } from "typechain-types";

import { Snapshot } from "test/suite";

describe("OssifiableProxy.sol", () => {
  let admin: Signer;
  let stranger: Signer;
  let currentImpl: Initializable__Mock;
  let proxy: OssifiableProxy;
  let initPayload: string;

  let originalState: string;

  before(async () => {
    [admin, stranger] = await ethers.getSigners();

    currentImpl = await ethers.deployContract("Initializable__Mock");
    proxy = await ethers.deployContract("OssifiableProxy", [currentImpl, admin, "0x"]);

    initPayload = currentImpl.interface.encodeFunctionData("initialize", [1]);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  describe("deploy", () => {
    it("with empty calldata", async () => {
      const impl = await ethers.deployContract("Initializable__Mock");
      const newProxy = await ethers.deployContract("OssifiableProxy", [impl, admin, "0x"]);

      const tx = newProxy.deploymentTransaction();
      const implInterfaceOnProxyAddr = impl.attach(await newProxy.getAddress()) as Initializable__Mock;

      await expect(tx)
        .to.emit(newProxy, "Upgraded")
        .withArgs(await impl.getAddress());

      expect(await implInterfaceOnProxyAddr.version()).to.equal(0);
    });

    it("with calldata", async () => {
      const impl = await ethers.deployContract("Initializable__Mock");
      const badProxy = await ethers.deployContract("OssifiableProxy", [impl, admin, initPayload]);

      const tx = badProxy.deploymentTransaction();
      const implInterfaceOnProxyAddr = impl.attach(await badProxy.getAddress()) as Initializable__Mock;

      await expect(tx)
        .to.emit(badProxy, "Upgraded")
        .withArgs(await impl.getAddress())
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
      expect(await proxy.proxy__getAdmin()).to.equal(ZeroAddress);
    });
  });

  describe("proxy__changeAdmin()", () => {
    it("should fail to change admin when called by a stranger", async () => {
      await expect(
        proxy.connect(stranger).proxy__changeAdmin(await stranger.getAddress()),
      ).to.be.revertedWithCustomError(proxy, "NotAdmin()");
    });

    it("should fail to change admin if proxy is ossified", async () => {
      await proxy.connect(admin).proxy__ossify();
      await expect(proxy.connect(admin).proxy__changeAdmin(await stranger.getAddress())).to.be.revertedWithCustomError(
        proxy,
        "ProxyIsOssified()",
      );
    });

    it("should change admin when called by current admin", async () => {
      await expect(proxy.connect(admin).proxy__changeAdmin(await stranger.getAddress()))
        .to.emit(proxy, "AdminChanged")
        .withArgs(await admin.getAddress(), await stranger.getAddress());

      expect(await proxy.proxy__getAdmin()).to.equal(await stranger.getAddress());

      await expect(proxy.connect(admin).proxy__changeAdmin(admin.getAddress())).to.be.revertedWithCustomError(
        proxy,
        "NotAdmin()",
      );
    });

    it("should fail to change admin to zero address", async () => {
      await expect(proxy.connect(admin).proxy__changeAdmin(ZeroAddress)).to.be.revertedWith(
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
      const newImpl = await ethers.deployContract("Initializable__Mock", admin);

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
      const newImpl = await ethers.deployContract("Initializable__Mock", admin);
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
      const newImpl = await ethers.deployContract("Initializable__Mock", admin);
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
