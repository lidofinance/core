import { task } from "hardhat/config";

export const protocolGetAddressesTask = task("protocol:get-addresses", "Get deployed protocol contract addresses")
  .setInlineAction(async () => {
    // Imported lazily: `lib/state-file.js` imports `hardhat`, which would make this
    // module cyclic with `hardhat.config.ts` (it registers this task).
    const { readNetworkState } = await import("lib/state-file.js");
    const state = await readNetworkState();
    console.log(JSON.stringify(state, null, 2));
  })
  .build();
