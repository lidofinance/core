import { commonNegativeRebaseFormulaFixtureSet } from "./common.js";
import { hoodiNegativeRebaseFormulaFixtureSet } from "./hoodi.js";
import { migrationHoodiNegativeRebaseFormulaFixtureSet } from "./migration-hoodi.js";
import { migrationMainnetNegativeRebaseFormulaFixtureSet } from "./migration-mainnet.js";

export const negativeRebaseFormulaFixtureSets = [
  commonNegativeRebaseFormulaFixtureSet,
  hoodiNegativeRebaseFormulaFixtureSet,
  migrationHoodiNegativeRebaseFormulaFixtureSet,
  migrationMainnetNegativeRebaseFormulaFixtureSet,
];
