// What a module does while it loads happens at its import: output, a read
// of the environment and the clock, an error. Modules that only compute
// can run later, and it must not show.
import { PROBE, AT, WORDS } from "./stamp.ts";
import { SHAPES, sides } from "./shapes.ts";
import { TOTAL } from "./checked.ts";
import { power } from "./quiet.ts";

const started = Date.now();
// The environment changes after the import: the module read the old value.
process.env["LAZY_INIT_PROBE"] = "changed-later";
console.log("probe", PROBE, WORDS.join("+"), AT <= started);
if (process.argv.length > 0) console.log("total", TOTAL, sides("SQUARE"), SHAPES.length);
try {
  await import("./broken.ts");
  console.log("broken loaded");
} catch (error) {
  console.log("caught", error instanceof RangeError, (error as Error).message);
}
// A table changed by the program is the table its module's functions read.
function grow(): number {
  SHAPES.push({ name: "HEXAGON", sides: 6 });
  console.log(sides("HEXAGON"), SHAPES.length);
  return SHAPES.length;
}
const count = process.argv.length > 0 ? grow() : 0;
if (process.argv.length > 2) console.log("power", power(Number(process.argv[2])));
process.exit(count === 4 ? 0 : 3);
