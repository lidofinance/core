import { processAragonVoting } from "scripts/utils/upgrade";

import { ether, impersonate } from "lib";

export async function main() {
  const holderAddress = process.env.HOLDER || process.env.DEPLOYER || "";
  const holder = await impersonate(holderAddress, ether("100"));
  const voteDescription = process.env.VOTE_DESCRIPTION || "vote-description";
  const voteId = BigInt(process.env.VOTE_ID || "");

  await processAragonVoting(holder, voteId, voteDescription);

  // const parameters = readUpgradeParameters();

  //   const kernel = await loadContract<IAragonKernel>("IAragonKernel", getAddress(Sk.aragonKernel, state));
  //   const acl = await loadContract<ACL>("ACL", getAddress(Sk.aragonAcl, state));
  // //keccak256("APP_MANAGER_ROLE")
  //   const manager = await acl.getPermissionManager(kernel.address, "0xb6d92708f3d4817afc106147d969e229ced5c46e65e0a5002a0d391287762bd0");
  //   console.log("agent", getAddress(Sk.appAgent, state));
  //   console.log("acl", acl.address);
  //   console.log("kernel", kernel.address);
  //   console.log("manager", manager);

  // const wv = await loadContract<WithdrawalsManagerProxy>("WithdrawalsManagerProxy", getAddress(Sk.withdrawalVault, state));
  // console.log("withdrawal vault address", await wv.proxy_getAdmin());
}
