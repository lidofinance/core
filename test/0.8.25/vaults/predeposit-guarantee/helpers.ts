import { hexlify, parseUnits, randomBytes } from "ethers";
import { ethers } from "hardhat";

import { IStakingVault, SSZHelpers, SSZMerkleTree } from "typechain-types";
import { BLS } from "typechain-types/contracts/0.8.25/vaults/predeposit_guarantee/PredepositGuarantee";

import { ether, impersonate } from "lib";

export const randomBytes32 = (): string => hexlify(randomBytes(32));
export const randomValidatorPubkey = (): string => hexlify(randomBytes(48));

export const randomInt = (max: number): number => Math.floor(Math.random() * max);

export const generateValidator = (customWC?: string, customPukey?: string): SSZHelpers.ValidatorStruct => {
  return {
    pubkey: customPukey ?? randomValidatorPubkey(),
    withdrawalCredentials: customWC ?? randomBytes32(),
    effectiveBalance: parseUnits(randomInt(32).toString(), "gwei"),
    slashed: false,
    activationEligibilityEpoch: randomInt(343300),
    activationEpoch: randomInt(343300),
    exitEpoch: randomInt(343300),
    withdrawableEpoch: randomInt(343300),
  };
};

export const generatePredeposit = (
  validator: SSZHelpers.ValidatorStruct,
): { deposit: IStakingVault.DepositStruct; depositY: BLS.DepositYStruct } => {
  return {
    deposit: {
      pubkey: validator.pubkey,
      amount: ether("1"),
      signature: randomBytes(96),
      depositDataRoot: randomBytes32(),
    },
    depositY: {
      pubkeyY: {
        a: randomBytes32(),
        b: randomBytes32(),
      },
      signatureY: {
        c0_a: randomBytes32(),
        c0_b: randomBytes32(),
        c1_a: randomBytes32(),
        c1_b: randomBytes32(),
      },
    },
  };
};

export const generatePostDeposit = (
  validator: SSZHelpers.ValidatorStruct,
  amount = ether("31"),
): IStakingVault.DepositStruct => {
  return {
    pubkey: validator.pubkey,
    amount,
    signature: randomBytes(96),
    depositDataRoot: randomBytes32(),
  };
};

export const generateBeaconHeader = (stateRoot: string) => {
  return {
    slot: randomInt(1743359),
    proposerIndex: randomInt(1337),
    parentRoot: randomBytes32(),
    stateRoot,
    bodyRoot: randomBytes32(),
  };
};

export const setBeaconBlockRoot = async (root: string) => {
  const systemSigner = await impersonate("0xfffffffffffffffffffffffffffffffffffffffe", 999999999999999999999999999n);
  const BEACON_ROOTS = "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02";
  const block = await systemSigner
    .sendTransaction({
      to: BEACON_ROOTS,
      value: 0,
      data: root,
    })
    .then((tx) => tx.getBlock());
  if (!block) throw new Error("ivariant");
  return block.timestamp;
};

export const prepareLocalMerkleTree = async () => {
  const sszMerkleTree: SSZMerkleTree = await ethers.deployContract("SSZMerkleTree", {});
  await sszMerkleTree.addValidatorLeaf(generateValidator());
  const gIFirstValidator = await sszMerkleTree.getGeneralizedIndex(0n);
  return { sszMerkleTree, gIFirstValidator };
};
