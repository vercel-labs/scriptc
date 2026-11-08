// A tsconfig's `include` names declaration files that no module imports:
// global types of the project. They are part of the program's type world,
// as they are for tsc.
import { total } from "./sum.ts";

const measures: Measure[] = [
  { unit: "m", amount: 3 },
  { unit: "s", amount: 4 },
  { unit: "m", amount: 5 },
];
const unit: Unit = "m";
console.log(total(measures, unit), measures.length, measures[1]!.unit);
