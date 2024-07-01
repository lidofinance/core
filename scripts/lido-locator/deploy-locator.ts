import { ethers } from "hardhat";

import { deployImplementation, Sk } from "lib";

async function main() {
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!);

  const postTokenRebaseReceiverNew = "TBD";

  const config = {
    accountingOracle: "0x852deD011285fe67063a08005c71a85690503Cee",
    depositSecurityModule: "0xC77F8768774E1c9244BEed705C4354f2113CFc09",
    elRewardsVault: "0x388C818CA8B9251b393131C08a736A67ccB19297",
    legacyOracle: "0x442af784A788A5bd6F42A01Ebe9F287a871243fb",
    lido: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
    oracleReportSanityChecker: "0x9305c1Dbfe22c12c66339184C0025d7006f0f1cC",
    postTokenRebaseReceiver: postTokenRebaseReceiverNew,
    burner: "0xD15a672319Cf0352560eE76d9e89eAB0889046D3",
    stakingRouter: "0xFdDf38947aFB03C621C71b06C9C70bce73f12999",
    treasury: "0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c",
    validatorsExitBusOracle: "0x0De4Ea0184c2ad0BacA7183356Aea5B8d5Bf5c6e",
    withdrawalQueue: "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1",
    withdrawalVault: "0xB9D7934878B5FB9610B3fE8A5e441e8fad7E293f",
    oracleDaemonConfig: "0xbf05A929c3D7885a6aeAd833a992dA6E5ac23b09",
  };

  const lidoLocatorImpl = await deployImplementation(Sk.lidoLocator, "LidoLocator", wallet.address, [
    Object.values(config),
  ]);

  console.log("Deployer:", wallet.address);
  console.log("Contract deployed to address:", lidoLocatorImpl.address);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
