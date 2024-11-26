import { ethers } from "hardhat";

import { HardhatEthersProvider } from "@nomicfoundation/hardhat-ethers/internal/hardhat-ethers-provider";

export class Snapshot {
  private static provider: HardhatEthersProvider = ethers.provider;

  public static async take() {
    return Snapshot.provider.send("evm_snapshot", []);
  }

  public static async restore(snapshot: string) {
    const result = await Snapshot.provider.send("evm_revert", [snapshot]);
    if (!result) {
      throw new Error("`evm_revert` failed.");
    }
  }

  public static async refresh(snapshot: string) {
    if (snapshot) {
      await Snapshot.restore(snapshot);
    }

    return Snapshot.take();
  }
}

export function resetState(suite: Mocha.Suite) {
  let suiteStartState: string;

  suite.beforeAll(async function () {
    suiteStartState = await Snapshot.take();
  });

  suite.afterAll(async function () {
    await Snapshot.restore(suiteStartState);
  });
}
