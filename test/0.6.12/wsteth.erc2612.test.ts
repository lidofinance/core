import { ethers, network } from "hardhat";

import { Steth__MockForLidoMiscMinimal__factory, WstETH__factory } from "typechain-types";

import { ether } from "lib/units";

import { testERC2612Compliance } from "../common/erc2612.test";

testERC2612Compliance({
  tokenName: "wstETH",
  deploy: async () => {
    const [deployer, owner] = await ethers.getSigners();
    const totalSupply = ether("10.0");

    const stethFactory = new Steth__MockForLidoMiscMinimal__factory(deployer);
    const steth = await stethFactory.deploy(owner, { value: totalSupply });

    const wstethFactory = new WstETH__factory(deployer);
    const wsteth = await wstethFactory.deploy(await steth.getAddress());

    await steth.connect(owner).approve(await wsteth.getAddress(), totalSupply);
    await wsteth.connect(owner).wrap(totalSupply);

    return {
      token: wsteth,
      domain: {
        name: "Wrapped liquid staked Ether 2.0",
        version: "1",
        chainId: network.config.chainId!,
        verifyingContract: await wsteth.getAddress(),
      },
      owner: owner.address,
      signer: owner,
    };
  },
});
