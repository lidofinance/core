import hre from "hardhat";

import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";

import type { ERC721 } from "typechain-types/index.js";

import { ether } from "lib/units.js";

import { deployWithdrawalQueue } from "test/deploy/index.js";

import { testERC721Compliance } from "../common/erc721.test.js";

let ethers: HardhatEthers;

testERC721Compliance({
  tokenName: "unstETH NFT",
  deploy: async () => {
    ({ ethers } = await hre.network.getOrCreate());

    const signers = await ethers.getSigners();
    const owner = signers[signers.length - 1];

    const initialStEth = ether("1.0");
    const ownerStEth = ether("99.0");

    const deployed = await deployWithdrawalQueue({
      stEthSettings: { initialStEth, owner: owner, ownerStEth },
      queueAdmin: owner,
    });

    const { queue, queueAddress, stEth } = deployed;

    await stEth.connect(owner).approve(queueAddress, ownerStEth);
    await queue.connect(owner).requestWithdrawals([ownerStEth], owner);

    const holderTokenId = await queue.getLastRequestId();

    return {
      token: queue as unknown as ERC721,
      name: deployed.name,
      symbol: deployed.symbol,
      holder: owner,
      holderTokenId,
    };
  },
});
