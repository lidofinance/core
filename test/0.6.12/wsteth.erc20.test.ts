import { ethers } from "hardhat";

import { Steth__MinimalMock__factory, WstETH__factory } from "typechain-types";

import { ether } from "lib/units";

import { testERC20Compliance } from "../common/erc20.test";

testERC20Compliance({
  tokenName: "wstETH",
  deploy: async () => {
    const signers = await ethers.getSigners();
    const [deployer, holder, recipient, spender] = signers;
    const totalSupply = ether("10.0");

    const stethFactory = new Steth__MinimalMock__factory(deployer);
    const steth = await stethFactory.deploy(holder, { value: totalSupply });

    const wstethFactory = new WstETH__factory(deployer);
    const wsteth = await wstethFactory.deploy(await steth.getAddress());

    await steth.connect(holder).approve(await wsteth.getAddress(), totalSupply);
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
