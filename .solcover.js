module.exports = {
  istanbulReporter: ["html", "text", "cobertura"],
  // NOTE: those is are all relative paths to the `contracts` directory and does not support regex
  //       https://github.com/sc-forks/solidity-coverage/issues/632#issuecomment-1736629543
  skipFiles: [
    "common/interfaces",
    "common/test_helpers",
    "0.4.24/template",
    "0.4.24/test_helpers",
    "0.6.11/deposit_contract.sol",
    "0.6.12/interfaces",
    "0.6.12/mocks",
    "0.8.9/interfaces",
    "0.8.9/test_helpers",
    // Skip contracts that are tested by Foundry tests
    "common/lib", // 100% covered by test/common/*.t.sol
    "0.8.9/lib/UnstructuredStorage.sol", // 100% covered by test/0.8.9/unstructuredStorage.t.sol
  ],
};
