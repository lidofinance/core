import fs from "fs";
import path from "path";

export function readUpgradeParameters() {
  const filePath = path.join(__dirname, "upgrade-parameters-mainnet.json");
  const rawData = fs.readFileSync(filePath);
  return JSON.parse(rawData.toString());
}
