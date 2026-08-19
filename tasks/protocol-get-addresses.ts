import { task } from "hardhat/config";

export const protocolGetAddressesTask = task("protocol:get-addresses", "Get deployed protocol contract addresses")
  .setInlineAction(async () => {
    // Lazy import: lib/state-file.js imports hardhat, cyclic with hardhat.config.ts
    const { readNetworkState } = await import("lib/state-file.js");
    const state = await readNetworkState();
    console.log(JSON.stringify(state, null, 2));
  })
  .build();
