import type { AddressLike, BytesLike } from "ethers";

import type { ACL } from "typechain-types";

import { streccak } from "./keccak";

// Role hashes (`keccak256("ROLE_NAME")`) used across scratch deploy steps, the
// DG launch flow, and integration tests. Single source of truth.
//
// Aragon ACL roles (used via `acl.hasPermission(who, where, role)`):
export const RUN_SCRIPT_ROLE = streccak("RUN_SCRIPT_ROLE");
export const EXECUTE_ROLE = streccak("EXECUTE_ROLE");
export const CREATE_PERMISSIONS_ROLE = streccak("CREATE_PERMISSIONS_ROLE");
// OZ AccessControl roles (used via `contract.hasRole(role, account)`):
export const PAUSE_ROLE = streccak("PAUSE_ROLE");
export const RESUME_ROLE = streccak("RESUME_ROLE");

// `ACL.hasPermission` has three overloads at the ABI level; ethers requires the
// signature to be specified explicitly to disambiguate, which is verbose. This
// helper picks the simple `(address, address, bytes32)` overload.
export function aclHasPermission(acl: ACL, who: AddressLike, where: AddressLike, role: BytesLike): Promise<boolean> {
  return acl["hasPermission(address,address,bytes32)"](who, where, role);
}
