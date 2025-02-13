import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { BLS__Harness } from "typechain-types";

import { ether } from "lib";

const STATIC_DEPOSIT = {
  pubkey: "0xa1d1ad0714035353258038e964ae9675dc0252ee22cea896825c01458e1807bfad2f9969338798548d9858a571f7425c",
  withdrawalCredentials: "0x0092c20062cee70389f1cb4fa566a2be5e2319ff43965db26dbaa3ce90b9df99",
  amount: ether("1"),
  signature:
    "0x985f365b3459176da437560337cc074d153663f65e3c6bab28197e34cd7f926fa940176ba43484fb5297f679bc869f5d10ee62f64a119d756182005fbb28046c0541f627b430cabfeb3599ebaa1b8efd08de562ec03a8d78c2f9e1b6f01d8aba",
};

describe("Accounting.sol", () => {
  let deployer: HardhatEthersSigner;
  let BLS: BLS__Harness;

  before(async () => {
    [deployer] = await ethers.getSigners();
    BLS = await ethers.deployContract("BLS__Harness", [], deployer);
  });

  it("can verify of static validator", async () => {
    const { pubkey, withdrawalCredentials, amount, signature } = STATIC_DEPOSIT;
    await BLS.verifySignature(pubkey, withdrawalCredentials, amount, signature);
  });
});
