import { ethers, networkConfig } from "lib/hardhat.js";
import { ether } from "lib/units.js";

import { testERC2612Compliance } from "../common/erc2612.test.js";

testERC2612Compliance({
  tokenName: "wstETH",
  deploy: async () => {
    const [deployer, owner] = await ethers.getSigners();
    const totalSupply = ether("10.0");

    const steth = await ethers.deployContract("StETH__Harness", [owner], { value: totalSupply, from: deployer });
    const wsteth = await ethers.deployContract("WstETH", [steth], deployer);

    await steth.connect(owner).approve(wsteth, totalSupply);
    await wsteth.connect(owner).wrap(totalSupply);

    return {
      token: wsteth,
      domain: {
        name: "Wrapped liquid staked Ether 2.0",
        version: "1",
        chainId: networkConfig.chainId!,
        verifyingContract: await wsteth.getAddress(),
      },
      owner: owner.address,
      signer: owner,
    };
  },
});
