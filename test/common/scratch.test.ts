import path from "node:path";

import { expect } from "chai";

import { deployUpgrade } from "#lib/scratch.js";

describe("deployUpgrade", () => {
  it("Fails when the steps file is missing", async () => {
    const stepsFile = "upgrade/steps-do-not-exist.json";
    const stepsPath = path.resolve(process.cwd(), `scripts/${stepsFile}`);

    await expect(deployUpgrade(stepsFile)).to.be.rejectedWith(`Steps file ${stepsPath} not found!`);
  });
});
