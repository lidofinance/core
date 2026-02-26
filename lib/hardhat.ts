/**
 * Shared Hardhat network connection module for HH3.
 *
 * In Hardhat v3, `ethers` and network helpers are no longer available as
 * top-level imports from "hardhat". Instead, they are obtained from a
 * network connection via `hre.network.connect()`.
 *
 * This module establishes a single shared connection using top-level await
 * (supported because package.json has "type": "module") and re-exports
 * `ethers` and `networkHelpers` for use across the codebase.
 *
 * Usage:
 *   import { ethers } from "lib/hardhat";
 *   import { ethers, networkHelpers } from "lib/hardhat";
 */
import hre from "hardhat";

const connection = await hre.network.connect();

export const ethers = connection.ethers;
export const networkHelpers = connection.networkHelpers;
export const provider = connection.provider;
export const networkName = connection.networkName;
export const networkConfig = connection.networkConfig;
export const artifacts = hre.artifacts;
