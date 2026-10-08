// A shared instance exported from one member of an import cycle and read
// through a function of the other member. inventory.ts evaluates after
// report.ts, so report's function only runs once `stock` initialized.
import { stock } from "./inventory.ts";
import { summary } from "./report.ts";

stock.add("bolt", 4);
console.log(summary());
console.log(stock.count());
