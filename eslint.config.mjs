// @ts-check
import path from "node:path";
import { fileURLToPath } from "node:url";
import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import ts from "typescript-eslint";
import prettier from "eslint-config-prettier";

import pluginNoOnlyTests from "eslint-plugin-no-only-tests";
import pluginSimpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gitignorePath = path.resolve(__dirname, ".gitignore");

export default [
  includeIgnoreFile(gitignorePath),
  {
    ignores: [".solcover.js", "eslint.config.mjs"],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022, sourceType: "module", project: ["./tsconfig.json"],
      },
    },
    plugins: {
      "no-only-tests": pluginNoOnlyTests,
      "simple-import-sort": pluginSimpleImportSort,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": ["warn"],
      "@typescript-eslint/no-unused-vars": ["warn"],
      "@typescript-eslint/no-floating-promises": ["warn"],
      "@typescript-eslint/no-shadow": ["error"], // prevents committing `describe.only` and `it.only` tests
      "no-only-tests/no-only-tests": "warn",
      "no-shadow": "off",
      "simple-import-sort/imports": ["error", {
        "groups": [["^node:"], ["^\\u0000"], ["^[^@]\\w"], ["^@\\w"], ["^typechain-types"], ["^lib"], ["^test"], ["^../"], ["^./"], ["^"]],
      }],
    },
  },
  {
    files: [
      "scripts/**/*.ts",
      "test/**/*.ts",
      "lib/protocol/helpers/**/*.ts",
    ],
    languageOptions: {
      globals: {
        ...globals.mocha,
        ...globals.chai,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-expressions": ["off"],
    },
  },
];


