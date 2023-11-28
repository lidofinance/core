import { HardhatEthersProvider } from "@nomicfoundation/hardhat-ethers/internal/hardhat-ethers-provider";
import { ethers } from "hardhat";

export default class Snapshot {
  private static provider: HardhatEthersProvider = ethers.provider;

  public static async take() {
    return Snapshot.provider.send("evm_snapshot", []);
  }

  public static async restore(snapshot: string) {
    Snapshot.provider.send("evm_revert", [snapshot]);
  }
}
