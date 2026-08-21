import { Contract, Log, LogDescription, Signer } from "ethers";
import { ethers } from "hardhat";

import { readNetworkState, Sk } from "lib/state-file";

export const DELEGATION_FACTORY_ABI = [
  "function deploy(address owner, address delegate, uint256 cooldown) returns (address instance)",
  "event DelegationContractDeployed(address indexed instance, address indexed owner, address indexed delegate, uint256 cooldown)",
];

export const DELEGATION_CONTRACT_ABI = [
  "function owner() view returns (address)",
  "function getDelegate() view returns (address)",
  "function getCooldown() view returns (uint256)",
  "function isTerminated() view returns (bool)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function nominateDelegate(address delegate)",
  "function revokeDelegate()",
  "function terminate()",
  "function execute(address target, bytes data) payable returns (bytes result)",
  "error NotDelegate()",
  "error ContractTerminated()",
];

export type DeployedDelegationContract = {
  address: string;
  contract: Contract;
};

export const getDelegationFactory = () => {
  const factoryAddress = readNetworkState()[Sk.delegationFactory]?.address;
  if (!factoryAddress) throw new Error("DelegationFactory address is missing in deployment state");
  return new ethers.Contract(factoryAddress, DELEGATION_FACTORY_ABI, ethers.provider);
};

export const deployDelegationContract = async (
  owner: Signer,
  delegate: string,
  cooldown: bigint = 0n,
): Promise<DeployedDelegationContract> => {
  const factory = getDelegationFactory().connect(owner) as Contract;
  const ownerAddress = await owner.getAddress();
  const tx = await factory.deploy(ownerAddress, delegate, cooldown);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("DelegationFactory deploy transaction has no receipt");

  const deploymentEvent = receipt.logs
    .map((log: Log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((event: LogDescription | null) => event?.name === "DelegationContractDeployed");
  if (!deploymentEvent) throw new Error("DelegationContractDeployed event was not emitted");

  const address = ethers.getAddress(deploymentEvent.args.instance);
  if ((await ethers.provider.getCode(address)) === "0x") {
    throw new Error(`DelegationContract at ${address} has no bytecode`);
  }

  return {
    address,
    contract: new ethers.Contract(address, DELEGATION_CONTRACT_ABI, ethers.provider),
  };
};
