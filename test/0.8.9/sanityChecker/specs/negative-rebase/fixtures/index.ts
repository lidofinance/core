import { commonNegativeRebaseFormulaFixtureSet } from "./common";
import { hoodiNegativeRebaseFormulaFixtureSet } from "./hoodi";
import { migrationHoodiNegativeRebaseFormulaFixtureSet } from "./migration-hoodi";
import { migrationMainnetNegativeRebaseFormulaFixtureSet } from "./migration-mainnet";

export const negativeRebaseFormulaFixtureSets = [
  commonNegativeRebaseFormulaFixtureSet,
  hoodiNegativeRebaseFormulaFixtureSet,
  migrationHoodiNegativeRebaseFormulaFixtureSet,
  migrationMainnetNegativeRebaseFormulaFixtureSet,
];
