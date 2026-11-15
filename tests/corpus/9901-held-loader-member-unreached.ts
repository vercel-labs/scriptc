// A createRequire loader handed on as a value keeps working for what a held
// loader does (it is called), while a function that reads `resolve` through
// the holder is never called here: the program builds with that read named
// at build time and runs to its end, as under Node.
import { createRequire } from "node:module";

const fetchPart = createRequire(import.meta.url);
type PartLoader = ReturnType<typeof createRequire>;

interface Workbench {
  fetchPart: PartLoader;
  label: string;
}

function whereIs(bench: Workbench, part: string): string {
  return bench.fetchPart.resolve(part);
}

function describe(bench: Workbench): string {
  return `${bench.label}: ${typeof bench.fetchPart}`;
}

const bench: Workbench = { fetchPart, label: "north bench" };
const stock: Array<(bench: Workbench, part: string) => string> = [];
if (process.argv.length > 99) stock.push(whereIs);

console.log(describe(bench));
console.log(stock.length);
for (const find of stock) console.log(find(bench, "node:path"));
console.log("done");
