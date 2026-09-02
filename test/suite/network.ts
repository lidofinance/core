import hre from "hardhat";

// One connection per process; `getOrCreate` returns the same instance to lib/ and the deploy helpers
export const { ethers, networkHelpers, networkConfig } = await hre.network.getOrCreate();
