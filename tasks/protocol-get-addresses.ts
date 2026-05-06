import { task } from "hardhat/config";

task("protocol:get-addresses", "Get deployed protocol contract addresses").setAction(async () => {
  const { readNetworkState } = await import("lib/state-file");
  const state = readNetworkState();
  console.log(JSON.stringify(state, null, 2));
});
