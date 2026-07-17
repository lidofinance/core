import { expect } from "chai";
import { Contract, Log, LogDescription } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { readNetworkState, Sk } from "lib/state-file";

import { Snapshot } from "test/suite";

const DELEGATION_FACTORY_ABI = [
  "function deploy(address owner, address delegate, uint256 cooldown) returns (address instance)",
  "event DelegationContractDeployed(address indexed instance, address indexed owner, address indexed delegate, uint256 cooldown)",
];

const DELEGATION_CONTRACT_ABI = [
  "function owner() view returns (address)",
  "function getDelegate() view returns (address)",
  "function getCooldown() view returns (uint256)",
  "function isTerminated() view returns (bool)",
  "function execute(address target, bytes data) payable returns (bytes result)",
  "error NotDelegate()",
];

const connectSigner = (contract: Contract, signer: HardhatEthersSigner) => contract.connect(signer) as Contract;

describe("Integration: Execution Delegation Framework", () => {
  const cooldown = 300n;

  let ctx: ProtocolContext;
  let factory: Contract;
  let delegation: Contract;
  let deploymentEvent: LogDescription;
  let delegationAddress: string;

  let owner: HardhatEthersSigner;
  let delegate: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let suiteSnapshot: string;
  let testSnapshot: string;

  before(async function () {
    ctx = await getProtocolContext();
    suiteSnapshot = await Snapshot.take();

    if (!ctx.isScratch) this.skip();

    const factoryAddress = readNetworkState()[Sk.delegationFactory]?.address;
    if (!factoryAddress) {
      throw new Error("DelegationFactory address is missing in scratch deployment state");
    }
    if ((await ethers.provider.getCode(factoryAddress)) === "0x") {
      throw new Error(`DelegationFactory at ${factoryAddress} has no bytecode`);
    }

    [owner, delegate, stranger] = await ethers.getSigners();
    factory = new ethers.Contract(factoryAddress, DELEGATION_FACTORY_ABI, ethers.provider);

    const tx = await connectSigner(factory, owner).deploy(owner.address, delegate.address, cooldown);
    const receipt = await tx.wait();
    if (!receipt) throw new Error("DelegationFactory deploy transaction has no receipt");

    const parsedEvent = receipt.logs
      .map((log: Log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event: LogDescription | null) => event?.name === "DelegationContractDeployed");
    if (!parsedEvent) throw new Error("DelegationContractDeployed event was not emitted");

    deploymentEvent = parsedEvent;
    delegationAddress = ethers.getAddress(deploymentEvent.args.instance);
    delegation = new ethers.Contract(delegationAddress, DELEGATION_CONTRACT_ABI, ethers.provider);
  });

  beforeEach(async () => (testSnapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(testSnapshot));
  after(async () => await Snapshot.restore(suiteSnapshot));

  it("deploys a configured DelegationContract through the external factory", async () => {
    expect(deploymentEvent.args.owner).to.equal(owner.address);
    expect(deploymentEvent.args.delegate).to.equal(delegate.address);
    expect(deploymentEvent.args.cooldown).to.equal(cooldown);
    expect(await ethers.provider.getCode(delegationAddress)).to.not.equal("0x");

    expect(await delegation.owner()).to.equal(owner.address);
    expect(await delegation.getDelegate()).to.equal(delegate.address);
    expect(await delegation.getCooldown()).to.equal(cooldown);
    expect(await delegation.isTerminated()).to.equal(false);
  });

  it("executes a privileged Lido call only through the DelegationContract", async () => {
    const oracleDaemonConfig = ctx.contracts.oracleDaemonConfig;
    const agent = await ctx.getSigner("agent");
    const role = await oracleDaemonConfig.CONFIG_MANAGER_ROLE();
    const key = "EDF_INTEGRATION_TEST";
    const value = "0xdeadbeef";

    await oracleDaemonConfig.connect(agent).grantRole(role, delegationAddress);

    await expect(oracleDaemonConfig.connect(delegate).set(key, value)).to.be.reverted;

    const data = oracleDaemonConfig.interface.encodeFunctionData("set", [key, value]);
    await expect(connectSigner(delegation, delegate).execute(oracleDaemonConfig.address, data))
      .to.emit(oracleDaemonConfig, "ConfigValueSet")
      .withArgs(key, value);

    expect(await oracleDaemonConfig.get(key)).to.equal(value);
  });

  it("rejects execute calls from an account that is not the delegate", async () => {
    const data = ctx.contracts.oracleDaemonConfig.interface.encodeFunctionData("set", ["EDF_STRANGER_TEST", "0x01"]);

    await expect(
      connectSigner(delegation, stranger).execute(ctx.contracts.oracleDaemonConfig.address, data),
    ).to.be.revertedWithCustomError(delegation, "NotDelegate");
  });
});
