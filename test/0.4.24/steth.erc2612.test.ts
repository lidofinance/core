import { ethers } from "hardhat";

import {
  EIP712StETH__factory,
  ERC1271Wallet__factory,
  StethPermitMockWithEip712Initialization__factory,
} from "typechain-types";

import { ether, stethDomain } from "lib";

import { testERC2612Compliance } from "../common/erc2612.test";

testERC2612Compliance({
  tokenName: "stETH",
  deploy: async () => {
    const [deployer, owner] = await ethers.getSigners();

    const value = ether("1.0");
    const steth = await new StethPermitMockWithEip712Initialization__factory(deployer).deploy(owner, { value });

    const eip712helper = await new EIP712StETH__factory(deployer).deploy(steth);
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
    const steth = await new StethPermitMockWithEip712Initialization__factory(deployer).deploy(owner, { value });

    const eip712helper = await new EIP712StETH__factory(deployer).deploy(steth);
    await steth.initializeEIP712StETH(eip712helper);

    const wallet = await new ERC1271Wallet__factory(deployer).deploy(owner.address);
    await steth.connect(owner).transfer(await wallet.getAddress(), await steth.balanceOf(owner));

    return {
      token: steth,
      domain: await stethDomain(steth),
      owner: await wallet.getAddress(),
      signer: owner,
    };
  },
});
