import { expect } from "chai";
import type { EthereumProvider } from "hardhat/types";

import { waitForMinedTransactions } from "test/suite";

// Model a node that accepts a transaction before mining it. No EVM is needed to
// check the adapter's ordering, timeout, and error propagation contracts.
describe("External integration transaction confirmation", () => {
  for (const method of ["eth_sendTransaction", "eth_sendRawTransaction"]) {
    it(`waits for ${method} state changes before returning the hash`, async () => {
      let mined = false;
      const provider = {
        async request({ method: rpcMethod }: { method: string }) {
          if (rpcMethod === method) {
            setTimeout(() => (mined = true), 30);
            return "0x1234";
          }
          if (rpcMethod === "eth_getTransactionReceipt") return mined ? { status: "0x1" } : null;
          return mined;
        },
      } as EthereumProvider;
      const original = provider.request;
      const restore = waitForMinedTransactions(provider);
      expect(await provider.request({ method, params: [] })).to.equal("0x1234");
      expect(await provider.request({ method: "eth_call" })).to.equal(true);
      mined = false;
      expect(await provider.send(method, [])).to.equal("0x1234");
      expect(mined).to.equal(true);
      restore();
      expect(provider.request).to.equal(original);
    });
  }

  it("preserves a reverted receipt for the transaction matchers", async () => {
    const receipt = { status: "0x0" };
    const provider = {
      async request({ method }: { method: string }) {
        return method === "eth_sendTransaction" ? "0x1234" : receipt;
      },
    } as EthereumProvider;
    waitForMinedTransactions(provider);
    expect(await provider.request({ method: "eth_sendTransaction" })).to.equal("0x1234");
    expect(await provider.request({ method: "eth_getTransactionReceipt" })).to.equal(receipt);
  });

  it("propagates submission errors without resending the transaction", async () => {
    const error = new Error("execution reverted");
    let calls = 0;
    const provider = {
      async request() {
        calls++;
        throw error;
      },
    } as unknown as EthereumProvider;
    waitForMinedTransactions(provider);
    let caught: unknown;
    try {
      await provider.request({ method: "eth_sendTransaction" });
    } catch (e) {
      caught = e;
    }
    expect(caught).to.equal(error);
    expect(calls).to.equal(1);
  });

  it("fails with the transaction hash when mining does not complete", async () => {
    const provider = {
      async request({ method }: { method: string }) {
        return method === "eth_sendTransaction" ? "0x1234" : null;
      },
    } as EthereumProvider;
    waitForMinedTransactions(provider, 0);
    let caught: unknown;
    try {
      await provider.request({ method: "eth_sendTransaction" });
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include("Transaction 0x1234 was not mined");
  });
  it("retries receipt transport failures without resubmitting", async () => {
    let submissions = 0;
    let polls = 0;
    const provider = {
      async request({ method }: { method: string }) {
        if (method === "eth_sendTransaction") {
          submissions++;
          return "0x1234";
        }
        if (++polls === 1) throw new Error("ECONNRESET");
        return { status: "0x1" };
      },
    } as EthereumProvider;
    waitForMinedTransactions(provider);
    expect(await provider.send("eth_sendTransaction", [])).to.equal("0x1234");
    expect(submissions).to.equal(1);
    expect(polls).to.equal(2);
  });

  it("retains the submitted hash and poll error when observation times out", async () => {
    const pollError = new Error("ECONNRESET");
    const provider = {
      async request({ method }: { method: string }) {
        if (method === "eth_sendTransaction") return "0x1234";
        throw pollError;
      },
    } as EthereumProvider;
    waitForMinedTransactions(provider, 0);
    let caught: unknown;
    try {
      await provider.send("eth_sendTransaction", []);
    } catch (error) {
      caught = error;
    }
    expect(caught).to.include({ transactionHash: "0x1234", cause: pollError });
  });

  it("waits through sendAsync and restores all entry points", async () => {
    let polls = 0;
    const provider = {
      async request({ method }: { method: string }) {
        if (method === "eth_sendRawTransaction") return "0x1234";
        return ++polls > 1 ? { status: "0x1" } : null;
      },
      async send() {},
      sendAsync() {},
    } as unknown as EthereumProvider;
    const original = { request: provider.request, send: provider.send, sendAsync: provider.sendAsync };
    const restore = waitForMinedTransactions(provider);
    const result = await new Promise((resolve, reject) => {
      provider.sendAsync(
        { id: 42, jsonrpc: "2.0", method: "eth_sendRawTransaction", params: [] },
        (error, response) => {
          if (error) reject(error);
          else resolve(response);
        },
      );
    });
    expect(result).to.deep.equal({ id: 42, jsonrpc: "2.0", result: "0x1234" });
    expect(polls).to.equal(2);
    restore();
    expect(provider).to.include(original);
  });

  it("preserves legacy sendAsync RPC error envelopes", async () => {
    const submissionError = Object.assign(new Error("execution reverted"), { code: -32000 });
    const provider = {
      async request() {
        throw submissionError;
      },
    } as unknown as EthereumProvider;
    waitForMinedTransactions(provider);
    const result = await new Promise((resolve, reject) => {
      provider.sendAsync({ id: 7, jsonrpc: "2.0", method: "eth_sendTransaction", params: [] }, (error, response) => {
        if (error) reject(error);
        else resolve(response);
      });
    });
    expect(result).to.deep.equal({
      id: 7,
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: submissionError.message,
        data: { stack: submissionError.stack, name: submissionError.name },
      },
    });
  });
  for (const rejection of [undefined, null, "transport failed", 42]) {
    it(`reports a non-Error sendAsync rejection (${String(rejection)}) through the callback`, async () => {
      const provider = {
        async request() {
          throw rejection;
        },
      } as unknown as EthereumProvider;
      const restore = waitForMinedTransactions(provider);
      try {
        const error = await new Promise<Error | null>((resolve) => {
          provider.sendAsync({ id: 8, jsonrpc: "2.0", method: "eth_sendTransaction", params: [] }, (callbackError) =>
            resolve(callbackError),
          );
        });
        expect(error).to.be.instanceOf(Error);
        expect(error!.message).to.equal(String(rejection));
      } finally {
        restore();
      }
    });
  }

  it("rejects duplicate installation and allows a fresh installation after restore", async () => {
    let polls = 0;
    const provider = {
      async request({ method }: { method: string }) {
        if (method === "eth_sendTransaction") return "0x1234";
        polls++;
        return { status: "0x1" };
      },
      async send() {},
      sendAsync() {},
    } as unknown as EthereumProvider;
    const original = { request: provider.request, send: provider.send, sendAsync: provider.sendAsync };
    const restore = waitForMinedTransactions(provider);
    expect(() => waitForMinedTransactions(provider)).to.throw("already installed");
    expect(await provider.send("eth_sendTransaction", [])).to.equal("0x1234");
    expect(polls).to.equal(1);
    restore();
    expect(provider).to.include(original);
    const restoreAgain = waitForMinedTransactions(provider);
    restore(); // A stale cleanup must not remove a newer installation.
    expect(provider.request).not.to.equal(original.request);
    restoreAgain();
    expect(provider).to.include(original);
  });
});
