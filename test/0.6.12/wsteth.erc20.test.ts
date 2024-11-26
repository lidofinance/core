import { ethers } from "hardhat";

import { ether } from "lib/units";

import { testERC20Compliance } from "../common/erc20.test";

testERC20Compliance({
  tokenName: "wstETH",
  deploy: async () => {
    const [deployer, holder, recipient, spender] = await ethers.getSigners();
    const totalSupply = ether("10.0");

    const steth = await ethers.deployContract("StETH__Harness", [holder], { value: totalSupply, from: deployer });
    const wsteth = await ethers.deployContract("WstETH", [steth], deployer);

    await steth.connect(holder).approve(wsteth, totalSupply);
    await wsteth.connect(holder).wrap(totalSupply);

    return {
      token: wsteth.connect(holder),
      name: "Wrapped liquid staked Ether 2.0",
      symbol: "wstETH",
      decimals: 18n,
      totalSupply,
      holder,
      recipient,
      spender,
    };
  },
});
