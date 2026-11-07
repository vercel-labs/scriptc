// A command-line program whose three dependencies run in Node islands
// (package.json says so): an ES module package of about a hundred small
// modules, a CommonJS package whose load reads an environment variable that
// is normally unset, and a package that is imported and not used, most of
// which is data files nothing loads. `report` calls into the first two.
// `version` uses none of them, so its time is what having islands costs a
// start that does not need them.
import { cells, describe, total } from "gridkit";
import { mark } from "envkit";
import { inventory } from "sparekit";

const mode = process.argv[2] ?? "report";
if (mode === "version") {
  console.log("startup-islands 1.0.0");
} else if (mode === "report") {
  const seed = Number(process.argv[3] ?? 7);
  console.log(mark(describe(total(seed))));
  console.log(`cells ${cells()}`);
} else if (mode === "inventory") {
  console.log(inventory());
} else {
  console.error(`unknown mode ${mode}`);
  process.exitCode = 2;
}
