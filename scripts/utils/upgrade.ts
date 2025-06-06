import fs from "fs";

const UPGRADE_PARAMETERS_FILE = process.env.UPGRADE_PARAMETERS_FILE;

export function readUpgradeParameters() {
  if (!UPGRADE_PARAMETERS_FILE) {
    throw new Error("UPGRADE_PARAMETERS_FILE is not set");
  }

  const rawData = fs.readFileSync(UPGRADE_PARAMETERS_FILE);
  return JSON.parse(rawData.toString());
}
