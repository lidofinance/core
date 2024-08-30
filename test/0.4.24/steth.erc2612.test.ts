import { ethers } from "hardhat";

import { ether, stethDomain } from "lib";

import { testERC2612Compliance } from "../common/erc2612.test";

testERC2612Compliance({
  tokenName: "stETH",
  deploy: async () => {
    const [deployer, owner] = await ethers.getSigners();

    const value = ether("1.0");
    const steth = await ethers.deployContract("StETHPermit__HarnessWithEip712Initialization", [owner], {
      value,
      from: deployer,
    });

    const eip712helper = await ethers.deployContract("EIP712StETH", [steth], deployer);
    await steth.initializeEIP712StETH(eip712helper);

    return {
      token: steth,
      domain: await stethDomain(steth),
      owner: owner.address,
      signer: owner,
    };
  },
});

testERC2612Compliance({
  tokenName: "stETH (for ERC-1271 wallets)",
  deploy: async () => {
    const [deployer, owner] = await ethers.getSigners();

    const value = ether("1.0");
    const steth = await ethers.deployContract("StETHPermit__HarnessWithEip712Initialization", [owner], {
      value,
      from: deployer,
    });

    const eip712helper = await ethers.deployContract("EIP712StETH", [steth], deployer);
    await steth.initializeEIP712StETH(eip712helper);

    const wallet = await ethers.deployContract("ERC1271Wallet", [owner], deployer);
    await steth.connect(owner).transfer(await wallet.getAddress(), await steth.balanceOf(owner));

    return {
      token: steth,
      domain: await stethDomain(steth),
      owner: await wallet.getAddress(),
      signer: owner,
    };
  },
});
