import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("eip712StETH", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.

  const stethAddress = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
  async function deployEIP712StETH() {
    const EIP712StETH = await ethers.getContractFactory("EIP712StETH");
    const eip712StETH = await EIP712StETH.deploy(stethAddress);

    return { eip712StETH, stethAddress };
  }

  describe("Parameters", function () {
    it("Should have the correct domain separator 4", async function () {
      const { eip712StETH, stethAddress } = await loadFixture(deployEIP712StETH);

      expect(await eip712StETH.domainSeparatorV4(stethAddress)).to.equal(
        "0xe518e03c2b8c3c564939187b49918cce3672e932d69139a8b407d911332c7ee2",
      );
    });
  });
});
