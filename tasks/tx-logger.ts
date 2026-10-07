import { definePlugin } from "hardhat/plugins";

// Prints every sent transaction with its decoded call when LOG_LEVEL is debug or all
export const txLoggerPlugin = definePlugin({
  id: "lido:tx-logger",
  hookHandlers: {
    network: () => import("./tx-logger-hooks.js"),
  },
});
