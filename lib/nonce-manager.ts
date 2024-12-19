import { NonceManager } from "ethers";
import { ethers } from "hardhat";

let cachedNonceManager: NonceManager;

export const getNonceManagerWithDeployer = async () => {
  if (cachedNonceManager) {
    return cachedNonceManager;
  }
  const [deployer] = await ethers.getSigners();

  const nonceManager = new ethers.NonceManager(deployer);
  cachedNonceManager = nonceManager;

  return nonceManager;
};
