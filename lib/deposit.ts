import { sha256 } from "ethers";
import { ONE_GWEI } from "./constants";
import { bigintToHex } from "bigint-conversion";
import { intToHex } from "ethereumjs-util";

export function computeDepositDataRoot(creds: string, pubkey: string, signature: string, amount: bigint) {
  // strip everything of the 0x prefix to make 0x explicit when slicing
  creds = creds.slice(2);
  pubkey = pubkey.slice(2);
  signature = signature.slice(2);

  const pubkeyRoot = sha256("0x" + pubkey + "00".repeat(16)).slice(2);

  const sigSlice1root = sha256("0x" + signature.slice(0, 128)).slice(2);
  const sigSlice2root = sha256("0x" + signature.slice(128, signature.length) + "00".repeat(32)).slice(2);
  const sigRoot = sha256("0x" + sigSlice1root + sigSlice2root).slice(2);

  const sizeInGweiLE64 = formatAmount(amount);

  const pubkeyCredsRoot = sha256("0x" + pubkeyRoot + creds).slice(2);
  const sizeSigRoot = sha256("0x" + sizeInGweiLE64 + "00".repeat(24) + sigRoot).slice(2);
  return sha256("0x" + pubkeyCredsRoot + sizeSigRoot);
}

export function formatAmount(amount: bigint) {
  const gweiAmount = amount / ONE_GWEI;
  let bytes = bigintToHex(gweiAmount, false, 8);
  return Buffer.from(bytes, "hex").reverse().toString("hex");
}
