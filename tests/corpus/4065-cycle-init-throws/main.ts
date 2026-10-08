// @exit: 1
// A module body of an import cycle throws during initialization: the
// error propagates out of the whole graph, so the rest of the throwing
// body, its importers and main never run (stdout and exit code match).
import { total } from "./ledger.ts";

console.log("main never runs", total);
