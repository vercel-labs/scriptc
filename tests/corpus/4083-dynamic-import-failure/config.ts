import { SetupError } from "./errors.ts";
let runs = 0;
runs++;
console.log("evaluating config", runs);
if (runs > 0) throw new SetupError("missing limit", "E_SETUP");
export const limit = 5;
