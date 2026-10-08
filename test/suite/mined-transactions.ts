import type { EthereumProvider } from "hardhat/types";

const wrappedProviders = new WeakSet<EthereumProvider>();

/**
 * Integration tests and Hardhat's Chai matchers expect a submitted transaction
 * to have been mined before the next RPC call. Anvil's automining is asynchronous:
 * eth_sendTransaction can return while its receipt and state changes are pending.
 * Preserve that test convention on external nodes without changing production
 * providers or forcing blocks. Submission errors and receipt statuses remain
 * available to the transaction matchers.
 */
export function waitForMinedTransactions(provider: EthereumProvider, timeoutMs = 60_000) {
  if (wrappedProviders.has(provider)) throw new Error("Transaction confirmation wrapper is already installed");
  wrappedProviders.add(provider);
  const originalRequest = provider.request;
  const originalSend = provider.send;
  const originalSendAsync = provider.sendAsync;
  provider.request = async (args) => {
    const result = await originalRequest.call(provider, args);
    if (args.method === "eth_sendTransaction" || args.method === "eth_sendRawTransaction") {
      const deadline = Date.now() + timeoutMs;
      let lastPollError: unknown;
      for (;;) {
        try {
          if (await originalRequest.call(provider, { method: "eth_getTransactionReceipt", params: [result] })) break;
        } catch (error) {
          // The transaction was already submitted. Retry observation, never submission.
          lastPollError = error;
        }
        if (Date.now() >= deadline) {
          const error = new Error(
            `Transaction ${result} was not mined within ${timeoutMs}ms; already submitted, do not resend`,
          );
          Object.assign(error, { transactionHash: result, cause: lastPollError });
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return result;
  };
  // Hardhat's ethers plugin uses send(), whose lazy adapter bypasses request().
  provider.send = (method, params) => provider.request({ method, params });

  provider.sendAsync = (payload, callback) => {
    void provider.request({ method: payload.method, params: payload.params }).then(
      (result) => callback(null, { id: payload.id, jsonrpc: "2.0", result }),
      (rejection: unknown) => {
        const error = rejection instanceof Error ? rejection : new Error(String(rejection));
        const code = (rejection as { code?: unknown } | null | undefined)?.code;
        // Preserve Hardhat's legacy JSON-RPC error envelope.
        if (code !== undefined) {
          const rpcError = rejection as { message: string; stack?: string; name?: string };
          callback(null, {
            id: payload.id,
            jsonrpc: "2.0",
            error: {
              code: code ? Number(code) : -1,
              message: rpcError.message,
              data: { stack: rpcError.stack, name: rpcError.name },
            },
          });
        } else {
          callback(error, { id: payload.id, jsonrpc: "2.0" });
        }
      },
    );
  };

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    wrappedProviders.delete(provider);
    provider.request = originalRequest;
    provider.send = originalSend;
    provider.sendAsync = originalSendAsync;
  };
}
