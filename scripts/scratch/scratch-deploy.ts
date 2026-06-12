import { getProtocolContext } from "lib/protocol/context";

async function main() {
  console.log("Starting scratch deploy...");
  await getProtocolContext();
  console.log("Scratch deploy complete!");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
